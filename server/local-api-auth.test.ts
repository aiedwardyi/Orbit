import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { waitForExit } from "./testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRANSCRIPT = "Synthetic legal case transcript: private fixture F01.";
let child: ChildProcess;
let base: string;

beforeAll(async () => {
  const scratch = process.env.OMB_DATA_DIR ?? tmpdir();
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "local-api-auth-"));
  const data = join(home, "data");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
  }));
  writeFileSync(join(data, "bots.json"), JSON.stringify([{
    id: "private-bot", threadId: "private-thread", name: "Private fixture",
    title: "", description: "", notifications: false, color: "purple", unread: false,
    modelSelection: { instanceId: "ghost", model: "ghost" }, resumeCursors: {}, computer: "off",
  }]));
  writeFileSync(join(data, "messages-private-thread.json"), JSON.stringify({
    activeLeafId: "private-message",
    messages: [{ id: "private-message", at: 1, parentId: null, role: "user", kind: "text", text: TRANSCRIPT }],
  }));

  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.stdout!.resume();
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json() as { pid: number };
        expect(health.pid).toBe(child.pid);
        break;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AssertionError") throw error;
    }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`server did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
});

describe("local API authentication", () => {
  it("rejects transcript reads without Authorization or Origin", async () => {
    const request = new Request(`${base}/api/bots`);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("origin")).toBe(false);
    const response = await fetch(request);
    const body = await response.text();
    expect(response.status, `GET /api/bots returned ${response.status}; transcript exposed: ${body.includes(TRANSCRIPT)}; body: ${body}`).toBe(401);
  });
});
