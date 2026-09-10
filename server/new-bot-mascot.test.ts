// New bots persist the white Soft squircle. Existing colour-mapped profiles
// are a different path and stay peach/teal/lavender/coral.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch, harnessToken } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";
const origin = () => `http://127.0.0.1:${port}`;

const createdBot = z.object({
  id: z.string(),
  name: z.string(),
  threadId: z.string(),
  color: z.string(),
  mascotStyle: z.string(),
}).passthrough();

const api = async (method: "GET" | "POST" | "PATCH", path: string, body?: object) => {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${origin()}${path}`, init);
  return { status: res.status, body: await res.json() };
};

const listedBot = async (id: string) => {
  const listed = await api("GET", "/api/bots?messages=0");
  const listedBots = z.object({ bots: z.array(createdBot) }).parse(listed.body);
  return listedBots.bots.find((row) => row.id === id);
};

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = mkdtempSync(join(tmpdir(), "omb-new-bot-mascot-"));
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

describe("new bot mascot default", () => {
  it("stores white squircle on POST /api/bots", async () => {
    const created = await api("POST", "/api/bots", { job: "Keep a weekly competitor brief." });
    expect(created.status).toBe(201);
    const bot = z.object({ bot: createdBot }).parse(created.body).bot;
    expect(bot).toMatchObject({ color: "white", mascotStyle: "squircle" });
    expect(await listedBot(bot.id)).toMatchObject({ color: "white", mascotStyle: "squircle" });
  });

  it("keeps a colour and style sent on POST /api/bots", async () => {
    const created = await api("POST", "/api/bots", { color: "purple", mascotStyle: "lavender" });
    expect(created.status).toBe(201);
    const bot = z.object({ bot: createdBot }).parse(created.body).bot;
    expect(bot).toMatchObject({ color: "purple", mascotStyle: "lavender" });
    expect(await listedBot(bot.id)).toMatchObject({ color: "purple", mascotStyle: "lavender" });
  });

  it("stores white squircle on POST /api/internal/create-bot", async () => {
    const chiefRes = await api("POST", "/api/bots", { name: "Channel Chief" });
    expect(chiefRes.status).toBe(201);
    const chief = z.object({ bot: createdBot }).parse(chiefRes.body).bot;
    expect((await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, section: "Mascot" })).status).toBe(200);

    const token = await harnessToken(origin());
    const created = await fetch(`${origin()}/api/internal/create-bot`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        fromBotId: chief.id,
        fromThreadId: chief.threadId,
        name: "Direct Task Operator",
        role: "Research operator",
        instructions: "Research the assigned question and report concise findings.",
      }),
    });
    expect(created.status).toBe(201);
    const body = z.object({ id: z.string() }).parse(await created.json());
    expect(await listedBot(body.id)).toMatchObject({ color: "white", mascotStyle: "squircle" });
  });

  it("stores white squircle on package import when the file has no style", async () => {
    const imported = await api("POST", "/api/teams/import", {
      format: "openmaus.team",
      version: 2,
      team: {
        name: "Default Face",
        members: [{ key: "white-squircle-import", name: "White Squircle Import", appearance: { color: "white" } }],
      },
    });
    expect(imported.status).toBe(201);
    const bots = z.object({ bots: z.array(createdBot) }).parse(imported.body).bots;
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({ name: "White Squircle Import", color: "white", mascotStyle: "squircle" });
  });

  it("keeps a colour and style sent on package import", async () => {
    const imported = await api("POST", "/api/teams/import", {
      format: "openmaus.team",
      version: 2,
      team: {
        name: "Kept Face",
        members: [{
          key: "kept",
          name: "Kept Face Import",
          appearance: { color: "purple", mascotStyle: "lavender" },
        }],
      },
    });
    expect(imported.status).toBe(201);
    const bots = z.object({ bots: z.array(createdBot) }).parse(imported.body).bots;
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({ name: "Kept Face Import", color: "purple", mascotStyle: "lavender" });
  });
});
