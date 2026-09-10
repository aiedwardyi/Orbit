// The automatic task-state fold on a ROOM turn. Boots the real harness on
// the fake claude CLI in happy mode - which plays one tool call and one
// reply - sends a room message mentioning the only member, and reads the
// room's durable packet back off disk.
//
// The real claudeAgent driver is used deliberately: its hasSession reports
// live thread ownership, unlike the in-memory fake driver's constant false.
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

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
  instructionId: z.string().optional(),
  settledInstructionId: z.string().optional(),
  completed: z.array(z.object({ note: z.string(), at: z.number() })),
  evidence: z.array(z.object({ kind: z.string(), ref: z.string(), note: z.string().optional() })),
  blockers: z.array(z.object({ kind: z.string(), note: z.string() })),
  flushReason: z.string(),
}).passthrough().parse(JSON.parse(
  readFileSync(join(home, ".orbit", "task-state", `${threadId}.json`), "utf8"),
));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-room-fold-"));
  setupDump = join(home, "setup-dump.json");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({
      instances: {
        ghost: { driver: "not-a-real-driver", displayName: "Ghost" },
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
  it("folds a room turn's tool evidence onto the room packet", async () => {
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
    expect(folded.evidence.some((item) => item.kind === "tool" && item.note === "Bash")).toBe(true);

    // consecutive turns on the same room thread each fold evidence
    const again = await api("POST", `/api/groups/${group.id}/messages`, { text: `@${bot.name} check once more` });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    await expect.poll(async () => {
      const messages = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages as { text?: string }[];
      return messages.filter((message) => message.text?.includes("hello from fake claude")).length;
    }, { timeout: 20_000 }).toBe(2);
    expect(packet(group.threadId).evidence.filter((item) => item.kind === "tool").length).toBe(2);
  }, 60_000);

  it("does not fold a running room turn's evidence onto a later instruction", async () => {
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
      name: "Setup race room",
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
      const messages = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages as { text?: string }[];
      return messages.some((message) => message.text?.includes("hello from fake claude"));
    }, { timeout: 20_000 }).toBe(true);

    const held = packet(group.threadId);
    expect(held.instructionId).toBe(queuedId);
    expect(held.nextAction).toContain("second instruction");
    expect(held.evidence.some((item) => item.kind === "tool")).toBe(false);
  }, 60_000);

  it("clears a room turn's blocker after a later instruction is queued", async () => {
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

    const waiting = await makeBot("claudeHang");
    const queued = await makeBot("claudeHang");
    const group = (await api("POST", "/api/groups", {
      name: "Blocker room",
      memberIds: [waiting.id, queued.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: waiting.id } },
    })).body.group;

    expect((await api("POST", `/api/groups/${group.id}/messages`, {
      text: "first instruction",
    })).status).toBe(202);
    await expect.poll(async () => {
      const rooms = (await api("GET", "/api/bots?messages=0")).body.groups;
      return rooms.find((candidate: { id: string }) => candidate.id === group.id)?.busyBotId;
    }, { timeout: 20_000 }).toBe(waiting.id);

    const conn = await connectPermissionBroker(group.threadId);
    conn.write(JSON.stringify({ t: "ask", id: "ask-room-1", tool: "Bash", input: { command: "rm -rf scratch" } }) + "\n");
    await expect.poll(
      () => packet(group.threadId).blockers.some((item) => item.kind === "approval" && item.note === "rm -rf scratch"),
      { timeout: 20_000 },
    ).toBe(true);

    const next = await api("POST", `/api/groups/${group.id}/messages`, {
      text: `@${queued.name} second instruction`,
    });
    expect(next.status, JSON.stringify(next.body)).toBe(202);
    const queuedId = next.body.message.id as string;
    await expect.poll(() => packet(group.threadId).instructionId, { timeout: 10_000 }).toBe(queuedId);
    expect(packet(group.threadId).blockers.some((item) => item.kind === "approval")).toBe(true);

    expect((await api("POST", `/api/threads/${group.threadId}/respond`, {
      requestId: "ask-room-1",
      behavior: "allow",
    })).status).toBe(200);
    await expect.poll(
      () => packet(group.threadId).blockers.some((item) => item.kind === "approval" || item.kind === "input"),
      { timeout: 20_000 },
    ).toBe(false);
    conn.destroy();
  }, 60_000);

  it("drops a room binding when setup fails before sendTurn", async () => {
    const instances = (await api("GET", "/api/instances")).body.instances;
    const happy = z.object({ default: z.string() }).parse(
      instances.find((instance: { instanceId: string }) => instance.instanceId === "claudeHappy").models,
    ).default;
    const ghostBot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${ghostBot.id}`, {
      modelSelection: { instanceId: "ghost", model: "ghost-1" },
    })).status).toBe(200);
    const liveBot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${liveBot.id}`, {
      modelSelection: { instanceId: "claudeHappy", model: happy },
    })).status).toBe(200);

    const group = (await api("POST", "/api/groups", {
      name: "Setup fail room",
      memberIds: [ghostBot.id, liveBot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: ghostBot.id } },
    })).body.group;
    expect((await api("POST", `/api/groups/${group.id}/messages`, {
      text: `@${ghostBot.name} first instruction`,
    })).status).toBe(202);
    await expect.poll(async () => {
      const messages = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages as { tool?: { name?: string } }[];
      return messages.some((message) => message.tool?.name === `error: ${ghostBot.name}'s model is unavailable`);
    }, { timeout: 20_000 }).toBe(true);

    const sent = await api("POST", `/api/groups/${group.id}/messages`, {
      text: `@${liveBot.name} second instruction`,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(async () => {
      const messages = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages as { text?: string }[];
      return messages.some((message) => message.text?.includes("hello from fake claude"));
    }, { timeout: 20_000 }).toBe(true);
    expect(packet(group.threadId).evidence.some((item) => item.kind === "tool" && item.note === "Bash")).toBe(true);
  }, 60_000);
});

function connectPermissionBroker(threadId: string): Promise<Socket> {
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(threadId).digest("hex").slice(0, 4);
  const pid = child.pid;
  if (!pid) throw new Error("server pid missing");
  const path = process.platform === "win32"
    ? `\\\\.\\pipe\\openmausbot-perm-${pid}-${prefix}${digest}`
    : join(home, ".orbit", `perm-${prefix}${digest}.sock`);
  return new Promise((resolve, reject) => {
    let retriesLeft = 40;
    const tryConnect = () => {
      const conn = connect(path);
      const onConnect = () => {
        conn.removeListener("error", onError);
        resolve(conn);
      };
      const onError = (error: NodeJS.ErrnoException) => {
        conn.removeListener("connect", onConnect);
        conn.destroy();
        if (retriesLeft-- > 0) {
          setTimeout(tryConnect, 50);
          return;
        }
        reject(error);
      };
      conn.once("connect", onConnect);
      conn.once("error", onError);
    };
    tryConnect();
  });
}
