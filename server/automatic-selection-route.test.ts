import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const STUB = pathToFileURL(join(SERVER_DIR, "testing", "stub-oauth-usage.mjs")).href;
const selectionSchema = z.object({ instanceId: z.string().min(1), model: z.string().min(1), mode: z.literal("automatic") });
const botSchema = z.object({ id: z.string(), busy: z.boolean(), modelSelection: selectionSchema });
const createdSchema = z.object({ bot: botSchema });
const members = Array.from({ length: 4 }, (_, i) => ({ key: `member-${i}`, name: `Member ${i}`, appearance: { color: "white" } }));
const manifest = { format: "openmaus.team", version: 2, team: { name: "Fixture Team", members } };
const packageDocument = {
  format: "openmaus.package", version: 1,
  package: {
    id: "fixture-team", release: "1.0.0", name: "Fixture Team", tagline: "Research together.",
    summary: "A test team.", category: "Research", author: { name: "Fixture" }, license: "MIT",
    outcomes: ["Write a brief."], setupMinutes: 1, requirements: { apps: [], capabilities: [] }, agents: members,
  },
};

let child: ChildProcess;
let home: string;
let port = 0;
const api = async (method: string, path: string, body?: typeof manifest | typeof packageDocument | { text: string }) => {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const result = await res.json();
  expect(res.ok, JSON.stringify(result)).toBe(true);
  return result;
};
const createBot = async () => createdSchema.parse(await api("POST", "/api/bots")).bot;
const prime = async (first = 100, second = 0) => {
  writeFileSync(join(home, "usage.json"), JSON.stringify({ "Bearer first": first, "Bearer second": second }));
  for (const instanceId of ["first", "second"]) {
    const result = z.object({ report: z.object({ windows: z.array(z.object({ usedPercent: z.number() })) }) }).parse(
      await api("POST", `/api/usage/refresh/${instanceId}`),
    );
    expect(result.report.windows[0].usedPercent).toBe(instanceId === "first" ? first : second);
  }
};

beforeEach(async () => {
  port = await freePortBlock([0, 1], 24_100, 2_000);
  home = mkdtempSync(join(tmpdir(), "omb-automatic-selection-"));
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(join(home, "calls.txt"), "");
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({
    instances: Object.fromEntries(["first", "second"].map((instanceId) => [instanceId, {
      driver: "claudeAgent", config: { cli: FAKE_CLI },
      environment: { FAKE_CLAUDE_MODE: "happy", CLAUDE_CODE_OAUTH_TOKEN: instanceId },
    }])),
  }));
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
    FAKE_USAGE_REPORTS: join(home, "usage.json"), FAKE_USAGE_CALLS: join(home, "calls.txt"),
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  child = spawn(process.execPath, ["--import", STUB, join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server never came up: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
});

afterEach(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
});

describe("automatic selection from cached usage", () => {
  it("creates a bot on the first nonexhausted cached instance", async () => {
    await prime();
    expect((await createBot()).modelSelection.instanceId).toBe("second");
  });

  it.each([manifest, packageDocument])("imports all four members on the nonexhausted cached instance: $format", async (document) => {
    await prime();
    const imported = z.object({ bots: z.array(botSchema) }).parse(await api("POST", "/api/teams/import", document));
    expect(imported.bots).toHaveLength(4);
    expect(imported.bots.map((bot) => bot.modelSelection.instanceId)).toEqual(Array(4).fill("second"));
  });

  it("keeps automatic creation usable when every cached instance is exhausted", async () => {
    await prime(100, 100);
    expect((await createBot()).modelSelection.instanceId).toBe("first");
  });

  it("keeps an existing automatic bot on an exhausted instance", async () => {
    const bot = await createBot();
    expect(bot.modelSelection.instanceId).toBe("first");
    await prime();
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "fixture turn" });
    await expect.poll(async () => {
      const listed = z.object({ bots: z.array(botSchema) }).parse(await api("GET", "/api/bots"));
      const current = listed.bots.find((entry) => entry.id === bot.id)!;
      expect(current.modelSelection).toEqual(bot.modelSelection);
      return current.busy;
    }).toBe(false);
  });

  it("does not request usage during bot creation or team import", async () => {
    await prime();
    const calls = readFileSync(join(home, "calls.txt"), "utf8");
    expect(calls.trim().split("\n")).toHaveLength(2);
    await createBot();
    await api("POST", "/api/teams/import", manifest);
    expect(readFileSync(join(home, "calls.txt"), "utf8")).toBe(calls);
  });

  it("uses configured order before any usage report arrives", async () => {
    expect((await createBot()).modelSelection.instanceId).toBe("first");
    expect(readFileSync(join(home, "calls.txt"), "utf8")).toBe("");
  });
});
