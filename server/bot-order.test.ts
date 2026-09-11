// The sidebar order is the bots.json array. PUT /api/bots/order replaces it
// whole, so a stale or partial list is refused rather than merged.
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
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";
const origin = () => `http://127.0.0.1:${port}`;

type RequestBody = { name: string } | { botIds: readonly (string | number)[] | string };

const api = async (method: "GET" | "POST" | "PUT", path: string, body?: RequestBody) => {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${origin()}${path}`, init);
  return { status: res.status, body: await res.json() };
};

const listedIds = async () =>
  z.object({ bots: z.array(z.object({ id: z.string() }).passthrough()) })
    .parse((await api("GET", "/api/bots?messages=0")).body)
    .bots.map((bot) => bot.id);

async function start() {
  stderr = "";
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
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = mkdtempSync(join(tmpdir(), "omb-bot-order-"));
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
  );
  await start();
  for (const name of ["Ada", "Bea", "Cy"]) {
    expect((await api("POST", "/api/bots", { name })).status).toBe(201);
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("PUT /api/bots/order", () => {
  it("refuses a list that is not exactly the current bots", async () => {
    const ids = await listedIds();
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const refused = [
      ids.slice(1),
      [...ids, ids[0]],
      [ids[0], ...ids.slice(0, -1)],
      [...ids.slice(1), "no-such-bot"],
      [...ids.slice(1), 7],
      ids.join(","),
    ];
    for (const botIds of refused) {
      expect((await api("PUT", "/api/bots/order", { botIds })).status).toBe(400);
    }
    expect(await listedIds()).toEqual(ids);
  });

  it("saves, broadcasts, and keeps a new order across a restart", async () => {
    const reversed = (await listedIds()).reverse();
    const stream = await openSse(`${origin()}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      expect((await api("PUT", "/api/bots/order", { botIds: reversed })).status).toBe(200);
      expect(await stream.until((frame) => frame.kind === "bots.order")).toMatchObject({ botIds: reversed });
    } finally {
      stream.close();
    }
    expect(await listedIds()).toEqual(reversed);

    await waitForExit(child, { signal: "SIGTERM" });
    await start();
    expect(await listedIds()).toEqual(reversed);
  });
});
