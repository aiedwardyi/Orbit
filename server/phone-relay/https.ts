// Small HTTPS client for enroll and CT lookups: normal certificate
// verification, a hard deadline, a response size cap and no cross-origin
// redirects. `ca` and `lookup` exist so tests can point it at a local server.

import type { OutgoingHttpHeaders } from "node:http";
import { request } from "node:https";
import type { LookupFunction } from "node:net";

export interface HttpsDeps {
  /** Extra trust roots; production leaves this unset and uses the system store. */
  ca?: string | string[];
  lookup?: LookupFunction;
  /** Port override for tests; production uses the URL's port. */
  port?: number;
}

export interface HttpsRequest {
  method: "GET" | "POST";
  url: string;
  body?: string;
  contentType?: string;
  timeoutMs: number;
  maxBytes: number;
  /** Same-origin redirects to follow; cross-origin ones always fail. */
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface HttpsResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export class HttpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpsError";
  }
}

export async function httpsRequest(req: HttpsRequest, deps: HttpsDeps = {}): Promise<HttpsResponse> {
  let url = new URL(req.url);
  if (url.protocol !== "https:") throw new HttpsError("only https is allowed");
  const origin = url.origin;
  for (let redirects = 0; ; redirects++) {
    const res = await once(url, req, deps);
    if (res.status < 300 || res.status >= 400) return res;
    if (redirects >= (req.maxRedirects ?? 0) || !res.location) throw new HttpsError(`unexpected redirect ${res.status}`);
    const next = new URL(res.location, url);
    if (next.origin !== origin) throw new HttpsError("cross-origin redirect refused");
    url = next;
  }
}

function once(url: URL, req: HttpsRequest, deps: HttpsDeps): Promise<HttpsResponse & { location?: string }> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = { accept: "application/json" };
    if (req.body !== undefined) {
      headers["content-type"] = req.contentType ?? "application/json";
      headers["content-length"] = String(Buffer.byteLength(req.body));
    }
    const client = request(
      {
        method: req.method,
        protocol: "https:",
        hostname: url.hostname,
        servername: url.hostname,
        port: deps.port ?? (url.port || 443),
        path: `${url.pathname}${url.search}`,
        headers,
        ca: deps.ca,
        lookup: deps.lookup,
        signal: req.signal,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > req.maxBytes) {
            client.destroy(new HttpsError("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks, size),
            location: res.headers.location,
          });
        });
        res.on("error", fail);
      },
    );
    const timer = setTimeout(() => client.destroy(new HttpsError("request timed out")), req.timeoutMs);
    timer.unref();
    function fail(error: Error) {
      clearTimeout(timer);
      reject(error instanceof HttpsError ? error : new HttpsError(error.message));
    }
    client.on("error", fail);
    client.end(req.body);
  });
}
