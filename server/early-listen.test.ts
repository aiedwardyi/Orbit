import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_QUEUED_EARLY_REQUESTS,
  currentEarlyListen,
  isEarlyPublicPath,
  resetEarlyListenForTests,
  resolvedStaticPath,
  serveEarlyRequest,
  startEarlyListen,
} from "./early-listen.ts";

afterEach(async () => {
  await resetEarlyListenForTests();
});

async function listen(port = 0) {
  const early = startEarlyListen({ port, staticDir: process.env.OMB_STATIC_DIR ?? null });
  await new Promise<void>((resolve, reject) => {
    if (early.server.listening) return resolve();
    early.server.once("listening", () => resolve());
    early.server.once("error", reject);
  });
  const address = early.server.address();
  if (!address || typeof address === "string") throw new Error("early listen has no port");
  return { early, port: address.port, base: `http://127.0.0.1:${address.port}` };
}

describe("early public paths", () => {
  it("serves health and static UI before the harness attaches", () => {
    expect(isEarlyPublicPath("GET", "/api/health")).toBe(true);
    expect(isEarlyPublicPath("GET", "/")).toBe(true);
    expect(isEarlyPublicPath("GET", "/assets/app.js")).toBe(true);
    expect(isEarlyPublicPath("GET", "/api/bots")).toBe(false);
    expect(isEarlyPublicPath("GET", "/api/instances")).toBe(false);
    expect(isEarlyPublicPath("GET", "/api/events")).toBe(false);
    expect(isEarlyPublicPath("POST", "/api/health")).toBe(false);
  });
});

describe("startEarlyListen", () => {
  it("answers /api/health before a harness handler exists", async () => {
    const { base } = await listen();
    const res = await fetch(`${base}/api/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { app: string; pid: number; static: boolean };
    expect(body.app).toBe("openmausbot");
    expect(body.pid).toBe(process.pid);
    expect(typeof body.static).toBe("boolean");
  });

  it("serves the packaged UI from disk without waiting for the harness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-early-ui-"));
    writeFileSync(join(dir, "index.html"), "<html><body>composer shell</body></html>");
    const { base } = await listen();
    const early = currentEarlyListen();
    if (!early) throw new Error("expected early listen");
    early.staticDir = dir;
    const res = await fetch(`${base}/`);
    expect(res.ok).toBe(true);
    expect(await res.text()).toContain("composer shell");
  });

  it("holds /api/bots until the harness handler is installed", async () => {
    const { early, base } = await listen();
    let released = false;
    const pending = fetch(`${base}/api/bots`).then(async (res) => {
      expect(released).toBe(true);
      expect(res.status).toBe(200);
      return res.json();
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    released = true;
    early.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bots: [{ id: "ready" }] }));
    });
    expect(await pending).toEqual({ bots: [{ id: "ready" }] });
  });

  it("rejects further API holds once the early queue is full", async () => {
    const { base } = await listen();
    const held = Array.from({ length: MAX_QUEUED_EARLY_REQUESTS }, () =>
      fetch(`${base}/api/bots`).then((res) => res.status),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const overflow = await fetch(`${base}/api/bots`);
    expect(overflow.status).toBe(503);
    const early = currentEarlyListen();
    early?.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    expect(await Promise.all(held)).toEqual(Array.from({ length: MAX_QUEUED_EARLY_REQUESTS }, () => 200));
  });

  it("registers one shared slot so a later harness bundle can attach", async () => {
    const first = await listen();
    expect(startEarlyListen({ port: 1 }).server).toBe(first.early.server);
    expect(currentEarlyListen()?.server).toBe(first.early.server);
  });
});

describe("resolvedStaticPath", () => {
  it("keeps served files under the packaged UI root", () => {
    const root = "/tmp/orbit-ui";
    expect(resolvedStaticPath(root, "/")).toBe(join(root, "index.html"));
    expect(resolvedStaticPath(root, "/assets/app.js")).toBe(join(root, "assets/app.js"));
    expect(resolvedStaticPath(root, "/../etc/passwd")).toBeNull();
    expect(resolvedStaticPath(root, "/....//etc/passwd")).toBeNull();
  });
});

describe("serveEarlyRequest", () => {
  it("does not claim API routes that need the harness", async () => {
    const server = createServer((req, res) => {
      const handled = serveEarlyRequest(req, res, { staticDir: null });
      expect(handled).toBe(false);
      res.writeHead(599);
      res.end("held");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${address.port}/api/bots`);
    expect(res.status).toBe(599);
    server.close();
  });
});
