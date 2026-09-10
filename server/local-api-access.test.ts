import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { waitForExit } from "./testing/cleanup.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
let child: ChildProcess;
let base: string;
let home: string;
let token: string;
let port: number;

async function start() {
  child = spawn(process.execPath, [join(root, "server/index.ts")], {
    cwd: root,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: join(home, "data"),
      OMB_STATIC_DIR: join(home, "ui"), OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout!.resume();
  child.stderr!.resume();
  token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("private token delivery timed out")), 20_000);
    child.once("message", (value) => {
      clearTimeout(timer);
      const message = z.object({ type: z.literal("orbit:api-token"), token: z.string() }).parse(value);
      expect(message.type).toBe("orbit:api-token");
      resolve(message.token);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("harness exited"));
    });
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok && z.object({ pid: z.number() }).parse(await response.json()).pid === child.pid) return;
    } catch {}
    if (Date.now() > deadline) throw new Error("harness did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "orbit-api-access-"));
  mkdirSync(join(home, "data"));
  mkdirSync(join(home, "ui/assets"), { recursive: true });
  writeFileSync(join(home, "ui/index.html"), "<h1>Public shell</h1>");
  writeFileSync(join(home, "ui/assets/app.css"), "body { color: black; }");
  writeFileSync(join(home, "data/config.json"), JSON.stringify({
    instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
  }));
  writeFileSync(join(home, "data/bots.json"), JSON.stringify([{
    id: "fixture", threadId: "fixture-thread", name: "Fixture", title: "", description: "",
    notifications: false, color: "purple", unread: false,
    modelSelection: { instanceId: "ghost", model: "ghost" }, resumeCursors: {}, computer: "off",
  }]));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  port = z.object({ port: z.number() }).parse(listener.address()).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  await start();
});

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
});

describe("local API access", () => {
  it.each(["/api/bots", "/api/config", "/api/threads/fixture-thread/export", "/api/events"])("requires the app token for %s", async (path) => {
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    expect((await fetch(`${base}${path}`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const controller = new AbortController();
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    expect(response.status).toBe(200);
    if (path === "/api/events") {
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect((await response.body!.getReader().read()).value?.length).toBeGreaterThan(0);
      controller.abort();
    } else {
      expect(await response.text()).not.toContain(token);
    }
  });

  it.each(["/api/health", "/", "/assets/app.css"])("keeps %s public without exposing the token", async (path) => {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(token);
  });

  it("protects attachment upload and image reads", async () => {
    const upload = await fetch(`${base}/api/attachments`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(upload.status).toBe(201);
    const { path } = z.object({ path: z.string() }).parse(await upload.json());
    const url = `${base}/api/attachments/${path.replaceAll("\\", "/").split("/").pop()}`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it("preserves host, origin, and internal-route checks", async () => {
    expect((await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${token}`, origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(`${base}/api/internal/unknown`)).status).toBe(401);
    expect((await fetch(`${base}/api/health`, { method: "POST" })).status).toBe(401);
  });

  it("rotates the token on restart and rejects the old token", async () => {
    const old = token;
    await waitForExit(child, { signal: "SIGTERM" });
    await start();
    expect(token).not.toBe(old);
    expect((await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${old}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});
