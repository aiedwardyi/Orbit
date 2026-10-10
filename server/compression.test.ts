import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { acceptedEncoding, JSON_COMPRESS_MIN_BYTES, sendJson, sendStaticFile, sendText } from "./compression.ts";

type Raw = { status: number; headers: IncomingHttpHeaders; body: Buffer };

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve(handler: (res: ServerResponse) => void): Promise<number> {
  const server = createServer((_req, res) => handler(res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a TCP listen reports an AddressInfo, never a pipe name.
  return (server.address() as AddressInfo).port;
}

function get(port: number, headers: Record<string, string> = {}, method = "GET", path = "/"): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, headers, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const bigJson = JSON.stringify({ bots: Array.from({ length: 400 }, (_, i) => ({ id: `bot-${i}`, text: `reply ${i} ${"é".repeat(i % 7)}` })) });

describe("acceptedEncoding", () => {
  it("prefers brotli, falls back to gzip, else identity", () => {
    expect(acceptedEncoding("gzip, deflate, br")).toBe("br");
    expect(acceptedEncoding("gzip, br;q=0")).toBe("gzip");
    expect(acceptedEncoding("deflate, *;q=0.5")).toBe("br");
    expect(acceptedEncoding("gzip, deflate, br", ["gzip"])).toBe("gzip");
    expect(acceptedEncoding(undefined)).toBeNull();
    expect(acceptedEncoding("")).toBeNull();
    expect(acceptedEncoding("br;q=0, gzip;q=0")).toBeNull();
    expect(acceptedEncoding("*;q=0")).toBeNull();
    expect(acceptedEncoding("identity")).toBeNull();
  });
});

describe("sendJson", () => {
  it("gzips a big body to the exact original bytes and varies on accept-encoding", async () => {
    expect(Buffer.byteLength(bigJson)).toBeGreaterThan(JSON_COMPRESS_MIN_BYTES);
    const port = await serve((res) => sendJson(res, 200, bigJson));
    const res = await get(port, { "accept-encoding": "gzip, deflate, br" });
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers.vary).toBe("Accept-Encoding");
    expect(res.body.length).toBeLessThan(Buffer.byteLength(bigJson));
    expect(gunzipSync(res.body).equals(Buffer.from(bigJson))).toBe(true);
  });

  it("sends identity with no header or with every option at q=0", async () => {
    const port = await serve((res) => sendJson(res, 200, bigJson));
    const cases: Array<Record<string, string>> = [{}, { "accept-encoding": "gzip;q=0, br;q=0" }];
    for (const headers of cases) {
      const res = await get(port, headers);
      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.headers.vary).toBe("Accept-Encoding");
      expect(res.body.toString()).toBe(bigJson);
    }
  });

  it("leaves small bodies and HEAD untouched", async () => {
    const small = JSON.stringify({ ok: true });
    const port = await serve((res) => sendJson(res, 200, res.req.method === "HEAD" ? bigJson : small));
    const res = await get(port, { "accept-encoding": "gzip, br" });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers.vary).toBeUndefined();
    expect(res.body.toString()).toBe(small);
    const head = await get(port, { "accept-encoding": "gzip, br" }, "HEAD");
    expect(head.headers["content-encoding"]).toBeUndefined();
  });
});

describe("sendText", () => {
  it("merges accept-encoding into an existing vary", async () => {
    const port = await serve((res) => sendText(res, 200, { "content-type": "application/json", vary: "User-Agent" }, bigJson));
    const res = await get(port, { "accept-encoding": "br" });
    expect(res.headers.vary).toBe("User-Agent, Accept-Encoding");
    expect(res.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(res.body).toString()).toBe(bigJson);
  });

  it("never compresses an event stream", async () => {
    const port = await serve((res) => sendText(res, 200, { "content-type": "text/event-stream" }, `data: ${bigJson}\n\n`));
    const res = await get(port, { "accept-encoding": "gzip, br" });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.toString()).toBe(`data: ${bigJson}\n\n`);
  });
});

describe("sendStaticFile", () => {
  it("compresses a static file once and serves later requests from memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-compress-"));
    const file = join(dir, "index-AAAA1111.js");
    const stamp = new Date("2026-01-01T00:00:00Z");
    const first = `export const answer = "${"a".repeat(20_000)}";`;
    writeFileSync(file, first);
    utimesSync(file, stamp, stamp);
    const port = await serve((res) => sendStaticFile(res, file, "/assets/index-AAAA1111.js", "text/javascript"));

    const res = await get(port, { "accept-encoding": "gzip, deflate, br" });
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers.vary).toBe("Accept-Encoding");
    expect(brotliDecompressSync(res.body).toString()).toBe(first);

    // Same size and mtime: the cached copy is served without compressing again.
    writeFileSync(file, first.replace(/a/g, "b"));
    utimesSync(file, stamp, stamp);
    expect(brotliDecompressSync((await get(port, { "accept-encoding": "br" })).body).toString()).toBe(first);
    expect(gunzipSync((await get(port, { "accept-encoding": "gzip" })).body).toString()).toBe(first.replace(/a/g, "b"));

    utimesSync(file, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    expect(brotliDecompressSync((await get(port, { "accept-encoding": "br" })).body).toString()).toBe(first.replace(/a/g, "b"));
  });

  it("leaves images and HEAD uncompressed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-compress-"));
    const png = join(dir, "app-icon.png");
    writeFileSync(png, Buffer.alloc(20_000, 7));
    const css = join(dir, "index.css");
    writeFileSync(css, `body{color:red}${" ".repeat(20_000)}`);
    const port = await serve((res) =>
      res.req.url === "/png" ? sendStaticFile(res, png, "/app-icon.png", "image/png") : sendStaticFile(res, css, "/index.css", "text/css"),
    );
    const image = await get(port, { "accept-encoding": "gzip, br" }, "GET", "/png");
    expect(image.headers["content-encoding"]).toBeUndefined();
    expect(image.headers.vary).toBeUndefined();
    expect(image.body.equals(Buffer.alloc(20_000, 7))).toBe(true);
    expect((await get(port, { "accept-encoding": "gzip, br" })).headers["content-encoding"]).toBe("br");
    const head = await get(port, { "accept-encoding": "gzip, br" }, "HEAD");
    expect(head.headers["content-encoding"]).toBeUndefined();
  });
});
