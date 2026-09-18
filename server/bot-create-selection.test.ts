// POST /api/bots with an explicit modelSelection skips provider discovery.
// Boots the real harness with a fast engine plus one sluggish unrelated
// engine (its --version probe sleeps) and times both creation paths: the
// undisclosed path must block on the slow probe, the explicit path must
// not. Same spawn shape as the other route tests (spawnHarness +
// harnessFetch); the transform flag only lets plain node load this tree.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const SLOW_CLI = join(SERVER_DIR, "testing", "slow-version-cli.ts");
// The slow probe latency. Lower bounds are exact (setTimeout never fires
// early); the fast-path upper bound below stays orders of magnitude above
// a sync write so loaded CI cannot flake it.
const SLOW_MS = 4000;

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  port = await freePortBlock([0, 1], 24_100, 2_000);
  home = mkdtempSync(join(tmpdir(), "omb-bot-create-test-"));
  const staticDir = join(home, "static");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({
      instances: {
        fast: { driver: "geminiAgent", displayName: "Fast", config: { cli: FAKE_ACP_CLI } },
        slow: { driver: "geminiAgent", displayName: "Slow", config: { cli: SLOW_CLI } },
      },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_STATIC_DIR: staticDir,
    OMB_SSE_HEARTBEAT_MS: "50",
    SLOW_VERSION_DELAY_MS: String(SLOW_MS),
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  child = spawn(
    process.execPath,
    ["--experimental-transform-types", join(SERVER_DIR, "index.ts")],
    { cwd: join(SERVER_DIR, ".."), env, windowsHide: true },
  );
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
    } catch {
      /* starting */
    }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server never came up: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("POST /api/bots engine discovery", () => {
  it("blocks on the slowest engine when no selection is sent", async () => {
    const started = Date.now();
    const { status } = await api("POST", "/api/bots", { job: "undisclosed path" });
    const elapsed = Date.now() - started;
    console.log(`create-without-selection: ${elapsed}ms (slow probe ${SLOW_MS}ms)`);
    expect(status).toBe(201);
    expect(elapsed).toBeGreaterThanOrEqual(SLOW_MS - 1000);
  }, 20_000);

  it("returns without waiting for discovery when the selection is explicit", async () => {
    const selection = { mode: "automatic", instanceId: "fast", model: "auto" };
    const started = Date.now();
    const { status, body } = await api("POST", "/api/bots", { job: "explicit path", modelSelection: selection });
    const elapsed = Date.now() - started;
    console.log(`create-with-selection: ${elapsed}ms (slow probe ${SLOW_MS}ms)`);
    expect(status).toBe(201);
    expect(body.bot.modelSelection).toMatchObject(selection);
    expect(elapsed).toBeLessThan(SLOW_MS - 1000);
  });

  it("still validates the shape of an explicit selection", async () => {
    const { status, body } = await api("POST", "/api/bots", { job: "bad selection", modelSelection: {} });
    expect(status).toBe(400);
    expect(body.error).toContain("modelSelection");
  });
});
