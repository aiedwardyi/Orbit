// The automatic task-state fold on a ROOM turn. Boots the real harness on
// the fake claude CLI in happy mode — which plays one tool call and one
// reply — sends a room message mentioning the only member, and reads the
// room's durable packet back off disk.
//
// The real claudeAgent driver is used deliberately: its hasSession reports
// live thread ownership, unlike the in-memory fake driver's constant false.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 31800 + Math.floor(Math.random() * 6_000);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
let home: string;
let setupDump: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const packet = (threadId: string) => z.object({
  botId: z.string(),
  nextAction: z.string(),
  settledInstructionId: z.string().optional(),
  completed: z.array(z.object({ note: z.string(), at: z.number() })),
  evidence: z.array(z.object({ kind: z.string(), ref: z.string(), note: z.string().optional() })),
  flushReason: z.string(),
}).passthrough().parse(JSON.parse(
  readFileSync(join(home, ".orbit", "task-state", `${threadId}.json`), "utf8"),
));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-room-fold-"));
  setupDump = join(home, "setup-dump.json");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  const unauthCli = join(home, "unauth-cli.mjs");
  writeFileSync(
    unauthCli,
    "#!/usr/bin/env node\n"
    + 'if (process.argv.includes("--version")) { process.stdout.write("1.0.0\\n"); process.exit(0); }\n'
    + "process.exit(1);\n",
  );
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({
      instances: {
        claudeHappy: {
          driver: "claudeAgent",
          displayName: "Fixture Claude Happy",
          environment: { FAKE_CLAUDE_MODE: "happy" },
          config: { cli: FAKE_CLAUDE_CLI },
        },
        claudeSetup: {
          driver: "claudeAgent",
          displayName: "Fixture Claude Setup",
          environment: {
            FAKE_CLAUDE_MODE: "happy",
            FAKE_CLAUDE_DUMP: setupDump,
            FAKE_CLAUDE_GENERATE_DELAY_MS: "2000",
          },
          config: { cli: FAKE_CLAUDE_CLI },
        },
        claudeHang: {
          driver: "claudeAgent",
          displayName: "Fixture Claude Hang",
          environment: { FAKE_CLAUDE_MODE: "hang" },
          config: { cli: FAKE_CLAUDE_CLI },
        },
        opencodeUnauth: {
          driver: "opencodeGo",
          displayName: "Fixture OpenCode Unauth",
          config: { cli: unauthCli, fullAuto: true },
        },
      },
    }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
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

describe("room task-state fold", () => {
  it("folds a room turn's tool evidence and completion onto the room packet", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const models = z.object({ default: z.string() }).parse(
      (await api("GET", "/api/instances")).body.instances.find(
        (instance: { instanceId: string }) => instance.instanceId === "claudeHappy",
      ).models,
    );
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "claudeHappy", model: models.default },
    })).status).toBe(200);

    const group = (await api("POST", "/api/groups", {
      name: "Fold room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    const sent = await api("POST", `/api/groups/${group.id}/messages`, { text: `@${bot.name} run the check` });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);

    // the room itself shows finished work: the member's reply is on the wall
    await expect.poll(async () => {
      const messages = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages as { text?: string }[];
      return messages.some((message) => message.text?.includes("hello from fake claude"));
    }, { timeout: 20_000 }).toBe(true);

    const folded = packet(group.threadId);
    expect(folded.botId).toBe(bot.id);
    expect(folded.flushReason).toBe("turn-end");
    expect(folded.completed.at(-1)?.note).toContain("hello from fake claude");
    expect(folded.evidence.some((item) => item.kind === "tool" && item.note === "Bash")).toBe(true);

    // consecutive turns on the same room thread each fold, so the record
    // tracks the room rather than settling once and going stale
    const again = await api("POST", `/api/groups/${group.id}/messages`, { text: `@${bot.name} check once more` });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    await expect.poll(
      () => packet(group.threadId).completed.length,
      { timeout: 20_000 },
    ).toBe(2);
  }, 60_000);

  it("keeps a stopped room turn recorded as a stop", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const pick = (id: string) => z.object({ default: z.string() }).parse(
      instances.find((instance: { instanceId: string }) => instance.instanceId === id).models,
    ).default;

    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "claudeHappy", model: pick("claudeHappy") },
    })).status).toBe(200);
    const group = (await api("POST", "/api/groups", {
      name: "Stop room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;

    // one clean room turn first, so the thread carries the turn bookkeeping
    // a following turn has to be told apart from
    expect((await api("POST", `/api/groups/${group.id}/messages`, {
      text: `@${bot.name} first pass`,
    })).status).toBe(202);
    await expect.poll(() => packet(group.threadId).flushReason, { timeout: 20_000 }).toBe("turn-end");

    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "claudeHang", model: pick("claudeHang") },
    })).status).toBe(200);
    expect((await api("POST", `/api/groups/${group.id}/messages`, {
      text: `@${bot.name} second pass`,
    })).status).toBe(202);
    await expect.poll(async () => {
      const rooms = (await api("GET", "/api/bots?messages=0")).body.groups;
      return rooms.find((candidate: { id: string }) => candidate.id === group.id)?.busyBotId;
    }, { timeout: 20_000 }).toBe(bot.id);

    expect((await api("POST", `/api/groups/${group.id}/interrupt`, {})).status).toBe(200);
    await expect.poll(async () => {
      const rooms = (await api("GET", "/api/bots?messages=0")).body.groups;
      return rooms.find((candidate: { id: string }) => candidate.id === group.id)?.working;
    }, { timeout: 20_000 }).toBe(false);

    const stopped = packet(group.threadId);
    expect(stopped.flushReason).toBe("stop");
    expect(stopped.completed.length).toBe(1);
  }, 60_000);

  it("does not settle a queued room instruction on the running turn's completion", async () => {
    const instances = (await api("GET", "/api/instances")).body.instances;
    const pick = (id: string) => z.object({ default: z.string() }).parse(
      instances.find((instance: { instanceId: string }) => instance.instanceId === id).models,
    ).default;
    const makeBot = async (instanceId: string) => {
      const made = (await api("POST", "/api/bots")).body.bot;
      expect((await api("PATCH", `/api/bots/${made.id}`, {
        modelSelection: { instanceId, model: pick(instanceId) },
      })).status).toBe(200);
      return made;
    };

    const setup = await makeBot("claudeSetup");
    const hang = await makeBot("claudeHang");
    const group = (await api("POST", "/api/groups", {
      name: "Queue room",
      memberIds: [setup.id, hang.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: setup.id } },
    })).body.group;

    // oversized so prepareModelContext summarises; generateText is delayed,
    // which is the window the second POST has to land inside
    expect((await api("POST", `/api/groups/${group.id}/messages`, {
      text: `first instruction\n${"x".repeat(40_000)}`,
    })).status).toBe(202);
    await expect.poll(() => existsSync(setupDump), { timeout: 20_000 }).toBe(true);

    const queued = await api("POST", `/api/groups/${group.id}/messages`, {
      text: `@${hang.name} second instruction`,
    });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const queuedId = queued.body.message.id as string;

    await expect.poll(async () => {
      const rooms = (await api("GET", "/api/bots?messages=0")).body.groups;
      return rooms.find((candidate: { id: string }) => candidate.id === group.id)?.busyBotId;
    }, { timeout: 30_000 }).toBe(hang.id);

    const held = packet(group.threadId);
    expect(held.settledInstructionId).not.toBe(queuedId);
    expect(held.nextAction).toContain("second instruction");
  }, 60_000);

  it("folds a second room turn when the adapter completes before sendTurn returns", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const models = z.object({ default: z.string() }).parse(
      (await api("GET", "/api/instances")).body.instances.find(
        (instance: { instanceId: string }) => instance.instanceId === "opencodeUnauth",
      ).models,
    );
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "opencodeUnauth", model: models.default },
    })).status).toBe(200);
    const group = (await api("POST", "/api/groups", {
      name: "Sync complete room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;

    expect((await api("POST", `/api/groups/${group.id}/messages`, {
      text: "first sync turn",
    })).status).toBe(202);
    await expect.poll(() => packet(group.threadId).flushReason, { timeout: 20_000 }).toBe("turn-end");

    expect((await api("POST", `/api/groups/${group.id}/messages`, {
      text: "second sync turn",
    })).status).toBe(202);
    await expect.poll(async () => {
      const rooms = (await api("GET", "/api/bots?messages=0")).body.groups;
      return rooms.find((candidate: { id: string }) => candidate.id === group.id)?.working;
    }, { timeout: 20_000 }).toBe(false);

    // startGroupTurn stamps progress on the second message; only a fold
    // that is not classified superseded writes turn-end back
    expect(packet(group.threadId).flushReason).toBe("turn-end");
  }, 60_000);
});
