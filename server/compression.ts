import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { basename, extname } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export type Encoding = "br" | "gzip";

export const STATIC_TEXT_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".webmanifest", ".svg", ".wasm"]);
export const JSON_COMPRESS_MIN_BYTES = 8 * 1024;
export const IMMUTABLE_CACHE = "private, max-age=31536000, immutable";
// Level 4 gzips a 1.3 MB /api/bots body in about 11 ms; brotli q5 runs once per static file.
const JSON_GZIP_LEVEL = 4;
const STATIC_GZIP_LEVEL = 6;
const STATIC_BROTLI_QUALITY = 5;

type StaticEntry = { size: number; mtimeMs: number; etag: string; br?: Buffer; gzip?: Buffer };
const staticCache = new Map<string, StaticEntry>();

/** The first of `offered` the client takes with q > 0. Null means identity. */
export function acceptedEncoding(header: string | undefined, offered: readonly Encoding[] = ["br", "gzip"]): Encoding | null {
  if (!header) return null;
  const weights = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
    if (!name) continue;
    const q = params.find((param) => param.startsWith("q="));
    const weight = q ? Number(q.slice(2)) : 1;
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }
  return offered.find((encoding) => (weights.get(encoding) ?? weights.get("*") ?? 0) > 0) ?? null;
}

export function withVaryAcceptEncoding(existing: number | string | string[] | undefined): string {
  const values = (Array.isArray(existing) ? existing.join(",") : String(existing ?? ""))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.some((value) => value === "*" || value.toLowerCase() === "accept-encoding")) return values.join(", ");
  return [...values, "Accept-Encoding"].join(", ");
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}

function compress(body: Buffer | string, encoding: Encoding, gzipLevel = STATIC_GZIP_LEVEL): Buffer {
  if (encoding === "gzip") return gzipSync(body, { level: gzipLevel });
  return brotliCompressSync(body, {
    params: { [constants.BROTLI_PARAM_QUALITY]: STATIC_BROTLI_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(body) },
  });
}

function sendEncoded(
  res: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders,
  body: Buffer | string,
  offered: readonly Encoding[],
  encode: (encoding: Encoding) => Buffer,
): void {
  const req: IncomingMessage | undefined = res.req;
  const stream = String(headers["content-type"] ?? "").startsWith("text/event-stream");
  if (!req || stream || req.method === "HEAD" || status === 204 || status === 304) {
    res.writeHead(status, headers);
    res.end(body);
    return;
  }
  const vary = withVaryAcceptEncoding(headers.vary ?? res.getHeader("vary"));
  const encoding = acceptedEncoding(req.headers["accept-encoding"], offered);
  if (!encoding) {
    res.writeHead(status, { ...headers, vary });
    res.end(body);
    return;
  }
  res.writeHead(status, { ...headers, vary, "content-encoding": encoding });
  res.end(encode(encoding));
}

export function sendJson(res: ServerResponse, status: number, data: string): void {
  const headers = { "content-type": "application/json" };
  if (Buffer.byteLength(data) <= JSON_COMPRESS_MIN_BYTES) {
    res.writeHead(status, headers);
    res.end(data);
    return;
  }
  sendEncoded(res, status, headers, data, ["gzip"], (encoding) => compress(data, encoding, JSON_GZIP_LEVEL));
}

/** Small generated text, compressed per request. */
export function sendText(res: ServerResponse, status: number, headers: OutgoingHttpHeaders, body: Buffer | string): void {
  sendEncoded(res, status, headers, body, ["br", "gzip"], (encoding) => compress(body, encoding));
}

/** A built UI file. Throws like readFileSync when it is missing. */
export function sendStaticFile(res: ServerResponse, file: string, pathname: string, contentType: string): void {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`not a file: ${file}`);
  const data = readFileSync(file);
  if (!STATIC_TEXT_EXTENSIONS.has(extname(file).toLowerCase())) {
    res.writeHead(200, pathname.startsWith("/assets/")
      ? { "content-type": contentType, "cache-control": IMMUTABLE_CACHE }
      : { "content-type": contentType });
    res.end(data);
    return;
  }
  let entry = staticCache.get(file);
  if (!entry || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
    entry = { size: stat.size, mtimeMs: stat.mtimeMs, etag: `W/"${createHash("sha1").update(data).digest("base64url")}"` };
    staticCache.set(file, entry);
  }
  const headers: OutgoingHttpHeaders = { "content-type": contentType };
  if (pathname.startsWith("/assets/")) headers["cache-control"] = IMMUTABLE_CACHE;
  else if (basename(file) === "index.html") {
    headers["cache-control"] = "no-cache";
    headers.etag = entry.etag;
    if (etagMatches(res.req?.headers["if-none-match"], entry.etag)) {
      res.writeHead(304, { "cache-control": "no-cache", etag: entry.etag, vary: "Accept-Encoding" });
      res.end();
      return;
    }
  }
  const cached = entry;
  sendEncoded(res, 200, headers, data, ["br", "gzip"], (encoding) => (cached[encoding] ??= compress(data, encoding)));
}
