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
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";

const createdBot = z.object({
  id: z.string(),
  color: z.string(),
  mascotStyle: z.string(),
}).passthrough();

const api = async (method: "GET" | "POST", path: string, body?: { job: string }) => {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: res.status, body: await res.json() };
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
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
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

    const listed = await api("GET", "/api/bots?messages=0");
    const listedBots = z.object({ bots: z.array(createdBot) }).parse(listed.body);
    const stored = listedBots.bots.find((row) => row.id === bot.id);
    expect(stored).toMatchObject({ color: "white", mascotStyle: "squircle" });
  });
});
