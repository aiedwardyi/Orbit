// relay.<base> HTTP API over the outer TLS, ALPN http/1.1 (design sections 4 and 7):
// GET /v1/healthz, GET /v1/status/<label>, POST /v1/enroll.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LABEL_RE, hostFor } from "../../shared/relay-protocol.ts";
import { BAD_REQUEST, enrollRequestSchema, type Enroller } from "./enroll.ts";
import type { Hub } from "./hub.ts";
import { RateLimiter, type RelayLimits } from "./limits.ts";
import type { Logger } from "./log.ts";
import { peerPrefix, rateKey } from "./net-util.ts";

export interface ApiOptions {
  base: string;
  relayHost: string;
  hub: Hub;
  enroller: Enroller;
  limits: RelayLimits;
  log: Logger;
  now: () => number;
}

const STATUS_RE = /^\/v1\/status\/([^/?#]{1,64})$/;

type ReplyBody = Record<string, string | number | boolean | null>;

function reply(res: ServerResponse, status: number, body: ReplyBody, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > max) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks, size)));
    req.on("error", () => resolve(null));
  });
}

export function createApiServer(opts: ApiOptions): Server {
  const { hub, limits, log } = opts;
  const enrollLimit = RateLimiter.perHour(limits.enrollPerIpPerHour, opts.now);
  const statusLimit = RateLimiter.perMinute(limits.statusPerIpPerMin, opts.now);

  const server = createServer(
    { requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8 * 1024, keepAliveTimeout: 5_000 },
    (req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) reply(res, 500, { error: "internal" });
        else res.destroy();
      });
    },
  );
  server.maxRequestsPerSocket = 100;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? "").toLowerCase().replace(/:443$/, "");
    if (host !== opts.relayHost) {
      reply(res, 421, { error: "misdirected" });
      return;
    }
    const url = req.url ?? "";
    const ip = rateKey(req.socket.remoteAddress);

    if (url === "/v1/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { error: "method" });
      return reply(res, 200, { ok: true });
    }

    const status = STATUS_RE.exec(url);
    if (status) {
      if (req.method !== "GET") return reply(res, 405, { error: "method" });
      if (!statusLimit.take(ip)) return reply(res, 429, { error: "rate-limited" });
      const label = status[1];
      if (!LABEL_RE.test(label)) return reply(res, 404, { error: "not-found" });
      // Only the label's own origin may read this cross-origin (the phone offline page).
      const origin = req.headers.origin;
      const cors: Record<string, string> = {};
      cors.vary = "Origin";
      if (origin === `https://${hostFor(label, opts.base)}`) cors["access-control-allow-origin"] = origin;
      const { online, since } = hub.status(label);
      return reply(res, 200, { online, since }, cors);
    }

    if (url === "/v1/enroll") {
      if (req.method !== "POST") return reply(res, 405, { error: "method" });
      if (!enrollLimit.take(ip)) {
        log.log("enroll-rejected", { peer: peerPrefix(req.socket.remoteAddress), reason: "rate-limited" });
        return reply(res, 429, { error: "rate-limited" });
      }
      if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) {
        return reply(res, 415, { error: "content-type" });
      }
      const body = await readBody(req, limits.maxBodyBytes);
      if (!body) return reply(res, 413, { error: "too-large" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return reply(res, 400, { error: "bad-request" });
      }
      const request = enrollRequestSchema.safeParse(parsed);
      const result = request.success ? await opts.enroller.enroll(request.data) : BAD_REQUEST;
      if (!result.ok) {
        log.log("enroll-rejected", { peer: peerPrefix(req.socket.remoteAddress), reason: result.error });
        return reply(res, result.status, { error: result.error });
      }
      log.log("enrolled", { label: result.label, peer: peerPrefix(req.socket.remoteAddress) });
      return reply(res, 200, { ticket: result.ticket });
    }

    reply(res, 404, { error: "not-found" });
  }

  return server;
}
