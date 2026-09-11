import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const STUB = pathToFileURL(join(SERVER_DIR, "testing", "stub-oauth-usage.mjs")).href;

const windowSchema = z.object({ id: z.string(), usedPercent: z.number() }).passthrough();
const reportSchema = z.object({
  observedAt: z.string(),
  windows: z.array(windowSchema),
});
const refreshSchema = z.object({
  instanceId: z.string(),
  report: reportSchema.optional(),
  error: z.string().optional(),
});
const instanceSchema = z.object({
  instanceId: z.string(),
  models: z.object({ default: z.string() }),
  rateLimits: reportSchema.optional(),
}).passthrough();
const instancesSchema = z.object({ instances: z.array(instanceSchema) });
const botSchema = z.object({ bot: z.object({ id: z.string() }).passthrough() });

interface RefreshRouteBody {
  modelSelection?: { instanceId: string; model: string };
  text?: string;
}

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";
const origin = () => `http://127.0.0.1:${port}`;

const api = async (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: RefreshRouteBody) => {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${origin()}${path}`, init);
  return { status: res.status, body: await res.json() };
};

const findHappy = async () => {
  const listed = instancesSchema.parse((await api("GET", "/api/instances")).body);
  const happy = listed.instances.find((instance) => instance.instanceId === "claudeHappy");
  if (!happy) throw new Error("claudeHappy missing");
  return happy;
};

beforeAll(async () => {
  port = await freePortBlock([0, 1], 24_100, 2_000);
  home = mkdtempSync(join(tmpdir(), "omb-usage-refresh-route-"));
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({
      instances: {
        claudeHappy: {
          driver: "claudeAgent",
          displayName: "Fixture Claude Happy",
          environment: { FAKE_CLAUDE_MODE: "happy", CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth" },
          config: { cli: FAKE_CLAUDE_CLI },
        },
      },
    }),
  );

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    FAKE_CLAUDE_RATE_LIMITS: "1",
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

  child = spawn(process.execPath, ["--import", STUB, join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env,
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${origin()}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("usage refresh throttle vs runtime reports", () => {
  it("keeps a newer runtime report when a second refresh hits the 30s cache", async () => {
    const first = refreshSchema.parse((await api("POST", "/api/usage/refresh/claudeHappy")).body);
    expect(first.error).toBeUndefined();
    if (!first.report) throw new Error("first refresh had no report");
    expect(first.report.windows.map((window) => window.usedPercent)).toEqual([42, 19]);
    const firstObserved = first.report.observedAt;

    const happy = await findHappy();
    const created = botSchema.parse((await api("POST", "/api/bots")).body);
    try {
      expect((await api("PATCH", `/api/bots/${created.bot.id}`, {
        modelSelection: { instanceId: "claudeHappy", model: happy.models.default },
      })).status).toBe(200);
      expect((await api("POST", `/api/bots/${created.bot.id}/messages`, { text: "how full is my week" })).status).toBe(202);
      await expect.poll(async () =>
        (await findHappy()).rateLimits?.windows.map((window) => `${window.id}=${window.usedPercent}`),
      ).toEqual(["five_hour=12", "seven_day=76"]);
      const afterTurn = reportSchema.parse((await findHappy()).rateLimits);
      expect(Date.parse(afterTurn.observedAt)).toBeGreaterThan(Date.parse(firstObserved));

      const second = refreshSchema.parse((await api("POST", "/api/usage/refresh/claudeHappy")).body);
      expect(second.report).toEqual(afterTurn);
      expect(reportSchema.parse((await findHappy()).rateLimits)).toEqual(afterTurn);
    } finally {
      await api("DELETE", `/api/bots/${created.bot.id}`);
    }
  });
});
