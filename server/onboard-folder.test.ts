// Onboarding folder choice: a chosen folder persists on the bot and shows
// in bot details; skipping keeps the private-workspace behavior.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";
import { validateBotCwd } from "./bot-cwd.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

const dir = mkdtempSync(join(tmpdir(), "omb-onboard-folder-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("onboard folder choice", () => {
  it("creation with a chosen folder persists it on the bot", () => {
    const checked = validateBotCwd(dir);
    expect(checked.ok).toBe(true);
    const cwd = checked.ok ? checked.cwd! : dir;
    const store = new Store(selection);
    const bot = store.createBot({ cwd }, { job: "Keep a weekly brief." });
    expect(bot.cwd).toBe(cwd);
    expect(store.bot(bot.id)?.cwd).toBe(cwd);
  });

  it("creation skipped keeps private-workspace behavior (no cwd)", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { job: "Keep a weekly brief." });
    expect(bot.cwd).toBeUndefined();
    expect(store.bot(bot.id)?.cwd).toBeUndefined();
  });
});

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";
const origin = () => `http://127.0.0.1:${port}`;

const createdBot = z.object({
  id: z.string(),
  threadId: z.string(),
}).passthrough();

type BotsRequestBody = { job: string; cwd?: string };

const api = async (method: "GET" | "POST", path: string, body?: BotsRequestBody) => {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${origin()}${path}`, init);
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = mkdtempSync(join(tmpdir(), "omb-onboard-folder-http-"));
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
    },
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

describe("POST /api/bots folder choice", () => {
  it("persists a chosen folder so GET shows it on the bot", async () => {
    const created = await api("POST", "/api/bots", { job: "Keep a weekly brief.", cwd: dir });
    expect(created.status).toBe(201);
    const bot = z.object({ bot: createdBot }).parse(created.body).bot;
    expect(bot.cwd).toBe(dir);

    const listed = await api("GET", "/api/bots?messages=0");
    const bots = z.object({ bots: z.array(createdBot) }).parse(listed.body).bots;
    expect(bots.find((row) => row.id === bot.id)?.cwd).toBe(dir);
  });

  it("skipped creation stays on the private workspace", async () => {
    const created = await api("POST", "/api/bots", { job: "Keep a weekly brief." });
    expect(created.status).toBe(201);
    const bot = z.object({ bot: createdBot }).parse(created.body).bot;
    expect(bot.cwd ?? null).toBeNull();

    const listed = await api("GET", "/api/bots?messages=0");
    const bots = z.object({ bots: z.array(createdBot) }).parse(listed.body).bots;
    expect(bots.find((row) => row.id === bot.id)?.cwd ?? null).toBeNull();
  });

  it("refuses a folder that does not exist", async () => {
    const created = await api("POST", "/api/bots", { job: "Keep a weekly brief.", cwd: join(dir, "nope") });
    expect(created.status).toBe(400);
  });
});
