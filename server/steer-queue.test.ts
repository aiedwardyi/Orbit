// Queue-and-steer for busy 1:1 bots, at two levels:
//
// Unit: the steer-queue module against a fake store — queue bookkeeping,
// the drain-once property, and one follow-up turn per queued 1:1 send.
//
// e2e: the real harness server with the grokAgent driver on the fake ACP
// CLI in echo-gated mode, whose turns stay open until a gate file exists —
// a deterministic busy window. The echo reply carries the FULL prompt
// (system + turn text), which pins both what a drained turn was sent (one
// queued send, not a newline-joined burst) and what it was not (the
// webhook untrusted-data paragraph an attended turn must never get).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  cancelSteeredMessage,
  continueQueuedDrainIfIdle,
  drainSteeredMessages,
  queuedSteeredMessage,
  queueRoomParticipation,
  queueSteeredMessage,
  _queuedCount,
  type SteerStore,
} from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

// ── unit: the queue module against a fake store ────────────────────────
function fakeBot(id: string, threadId: string, busy: boolean): BotRecord {
  return {
    id,
    threadId,
    name: id,
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "fake", model: "fake-model" },
    resumeCursors: {},
    busy,
    createdAt: 0,
  };
}

function fakeStore(bots: BotRecord[]): SteerStore & { messages: Message[] } {
  const messages: Message[] = [];
  let nextId = 0;
  return {
    messages,
    bot: (id) => bots.find((b) => b.id === id) ?? null,
    appendMessage: (threadId, message) => {
      const full: Message = { id: `m${(nextId += 1)}-${threadId}`, at: Date.now(), ...message };
      messages.push(full);
      return full;
    },
    patchMessage: (_threadId, messageId, patch) => {
      const at = messages.findIndex((m) => m.id === messageId);
      if (at === -1) return null;
      messages[at] = { ...messages[at], ...patch };
      return messages[at];
    },
  };
}

describe("steer-queue module", () => {
  it("does not append a queued user message until drain", () => {
    const bot = fakeBot("bot-a", "thread-a", true);
    const store = fakeStore([bot]);
    const queued = queueSteeredMessage(bot.id, bot.threadId, "hold that thought");
    expect(queued).toMatchObject({ id: expect.any(String) });
    expect(store.messages).toHaveLength(0);
    expect(_queuedCount("thread-a")).toBe(1);

    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      role: "user",
      kind: "text",
      text: "hold that thought",
      queueId: queued.id,
    });
    expect(store.messages[0]!.queued).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(_queuedCount("thread-a")).toBe(0);
  });

  it("keeps a stable client receipt while a send waits to drain", () => {
    const bot = fakeBot("bot-receipt", "thread-receipt", true);
    const store = fakeStore([bot]);
    const queued = queueSteeredMessage(bot.id, bot.threadId, "retry safely", {
      replyToId: "reply-1",
      sendId: "send_1234567890123456",
    });

    expect(queuedSteeredMessage(bot.id, bot.threadId, "send_1234567890123456")).toEqual({
      id: queued.id,
      text: "retry safely",
      replyToId: "reply-1",
    });
    expect(queuedSteeredMessage("other-bot", bot.threadId, "send_1234567890123456")).toBeNull();

    bot.busy = false;
    drainSteeredMessages(store, vi.fn());
    expect(store.messages[0]).toMatchObject({
      text: "retry safely",
      sendId: "send_1234567890123456",
      queueId: queued.id,
    });
    expect(queuedSteeredMessage(bot.id, bot.threadId, "send_1234567890123456")).toBeNull();
  });

  it("holds the queue while the bot is busy and drains it once when idle", () => {
    const bot = fakeBot("bot-b", "thread-b", true);
    const store = fakeStore([bot]);
    const first = queueSteeredMessage(bot.id, bot.threadId, "first note");
    const second = queueSteeredMessage(bot.id, bot.threadId, "second note");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
    expect(_queuedCount("thread-b")).toBe(2);

    bot.busy = false;
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    const [botId, threadId, prompt, userMessage] = run.mock.calls[0];
    expect(botId).toBe("bot-b");
    expect(threadId).toBe("thread-b");
    // One queued send per settle — later lines wait for the next idle.
    expect(prompt).toBe("first note");
    expect(store.messages.map((m) => m.text)).toEqual(["first note"]);
    expect(store.messages.map((m) => m.queueId)).toEqual([first.id]);
    expect(userMessage.text).toBe("first note");
    expect(run.mock.calls[0][4]).toEqual([store.messages[0]!.id]);
    expect(store.messages.every((m) => !m.queued)).toBe(true);
    expect(_queuedCount("thread-b")).toBe(1);

    // Still working on the drained turn — the second line stays queued.
    bot.busy = true;
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(_queuedCount("thread-b")).toBe(1);

    bot.busy = false;
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][2]).toBe("second note");
    expect(store.messages.map((m) => m.text)).toEqual(["first note", "second note"]);
    expect(store.messages.map((m) => m.queueId)).toEqual([first.id, second.id]);
    expect(run.mock.calls[1][3].text).toBe("second note");
    expect(_queuedCount("thread-b")).toBe(0);

    // drain-once: a third settle finds nothing and fires nothing
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drops a cancelled message so drain does not send it", () => {
    const bot = fakeBot("bot-cancel", "thread-cancel", true);
    const store = fakeStore([bot]);
    const first = queueSteeredMessage(bot.id, bot.threadId, "keep me");
    const second = queueSteeredMessage(bot.id, bot.threadId, "drop me");
    expect(cancelSteeredMessage(bot.id, second.id)).toBe(true);
    expect(cancelSteeredMessage(bot.id, "missing")).toBe(false);
    expect(_queuedCount("thread-cancel")).toBe(1);

    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toBe("keep me");
    expect(store.messages.map((m) => m.queueId)).toEqual([first.id]);
    expect(_queuedCount("thread-cancel")).toBe(0);
  });

  it("keeps reply metadata and the provider-facing reply prompt while queued", () => {
    const bot = fakeBot("bot-reply", "thread-reply", true);
    const store = fakeStore([bot]);
    queueSteeredMessage(bot.id, bot.threadId, "That part", {
      replyToId: "original-message",
      prompt: "Reply context\nThat part",
    });
    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(store.messages[0]).toMatchObject({ text: "That part", replyToId: "original-message" });
    expect(run.mock.calls[0][2]).toBe("Reply context\nThat part");
  });

  it("cancels a pinned-task queue after the bot switches without crossing bot ownership", () => {
    const bot = fakeBot("bot-switch-cancel", "thread-original-cancel", true);
    const queued = queueSteeredMessage(bot.id, bot.threadId, "cancel on the old task");

    bot.threadId = "thread-new-cancel";
    expect(cancelSteeredMessage("some-other-bot", queued.id)).toBe(false);
    expect(_queuedCount("thread-original-cancel")).toBe(1);
    expect(cancelSteeredMessage(bot.id, queued.id)).toBe(true);
    expect(_queuedCount("thread-original-cancel")).toBe(0);
  });

  it("fires nothing when nothing is queued", () => {
    const run = vi.fn();
    drainSteeredMessages(fakeStore([fakeBot("bot-c", "thread-c", false)]), run);
    expect(run).not.toHaveBeenCalled();
  });

  it("drops the queue of a deleted bot without running it", () => {
    const bot = fakeBot("bot-d", "thread-d", true);
    queueSteeredMessage(bot.id, bot.threadId, "orphaned");
    const run = vi.fn();
    drainSteeredMessages(fakeStore([]), run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedCount("thread-d")).toBe(0);
  });

  it("does not append a room participation until drain, and never as a user line", () => {
    const skye = fakeBot("skye", "skye-1to1", true);
    const store = fakeStore([skye]);
    const queued = queueRoomParticipation(skye.id, "room-thread", { groupId: "room-two-bots" });
    expect(queued).toMatchObject({ id: expect.any(String) });
    expect(store.messages).toHaveLength(0);
    expect(_queuedCount("room-thread")).toBe(1);

    skye.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(store.messages).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(1);
    const [botId, threadId, prompt, userMessage, excludeIds, room] = run.mock.calls[0];
    expect(botId).toBe("skye");
    expect(threadId).toBe("room-thread");
    expect(prompt).toBe("");
    expect(userMessage).toBeNull();
    expect(excludeIds).toEqual([]);
    expect(room).toEqual({ groupId: "room-two-bots", hop: 0 });
    expect(_queuedCount("room-thread")).toBe(0);

    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("passes a room dispatch-error hook through drain without appending", () => {
    const skye = fakeBot("skye-card", "skye-card-1to1", true);
    const store = fakeStore([skye]);
    const onDispatchError = vi.fn();
    queueRoomParticipation(skye.id, "room-card", { groupId: "room-card", onDispatchError });
    skye.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(store.messages).toHaveLength(0);
    expect(run.mock.calls[0][5]).toMatchObject({ groupId: "room-card", hop: 0 });
    expect(run.mock.calls[0][5].onDispatchError).toBe(onDispatchError);
  });

  it("holds a room participation while the bot is busy and drains it once when idle", () => {
    const skye = fakeBot("skye-hold", "skye-hold-1to1", true);
    const store = fakeStore([skye]);
    queueRoomParticipation(skye.id, "room-hold", { groupId: "room-hold", hop: 1 });
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
    expect(_queuedCount("room-hold")).toBe(1);

    skye.busy = false;
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][5]).toEqual({ groupId: "room-hold", hop: 1 });
    expect(_queuedCount("room-hold")).toBe(0);
  });

  it("coalesces another room queue for the same member so drain cannot double-fire", () => {
    const skye = fakeBot("skye-once", "skye-once-1to1", true);
    const store = fakeStore([skye]);
    const first = queueRoomParticipation(skye.id, "room-once", { groupId: "room-once" });
    const second = queueRoomParticipation(skye.id, "room-once", { groupId: "room-once", hop: 1 });
    expect(second.id).toBe(first.id);
    expect(_queuedCount("room-once")).toBe(1);

    skye.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][5]).toEqual({ groupId: "room-once", hop: 0 });
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lets two busy room members queue on the same thread independently", () => {
    const skye = fakeBot("skye-pair", "skye-pair-1to1", true);
    const nova = fakeBot("nova-pair", "nova-pair-1to1", true);
    const store = fakeStore([skye, nova]);
    queueRoomParticipation(skye.id, "room-pair", { groupId: "room-pair" });
    queueRoomParticipation(nova.id, "room-pair", { groupId: "room-pair" });
    expect(_queuedCount("room-pair")).toBe(2);

    skye.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe("skye-pair");
    expect(_queuedCount("room-pair")).toBe(1);

    nova.busy = false;
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toBe("nova-pair");
    expect(_queuedCount("room-pair")).toBe(0);
  });

  it("wires the failed-start re-drain through continueQueuedDrainIfIdle", () => {
    const index = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
    expect(index).toContain("continueQueuedDrainIfIdle(store, botId, drainQueuedSends)");
    expect(index).not.toMatch(/if \(!store\.bot\(botId\)\?\.busy\) drainQueuedSends\(\)/);
  });

  it("re-drains only when the failed start left the bot idle", () => {
    const bot = fakeBot("bot-busy-fail", "thread-busy-fail", false);
    const drain = vi.fn();
    continueQueuedDrainIfIdle(fakeStore([bot]), bot.id, drain);
    expect(drain).toHaveBeenCalledTimes(1);

    bot.busy = true;
    continueQueuedDrainIfIdle(fakeStore([bot]), bot.id, drain);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("starts the next queued send after a failed start leaves the bot idle", async () => {
    const bot = fakeBot("bot-fail-next", "thread-fail-next", true);
    const store = fakeStore([bot]);
    queueSteeredMessage(bot.id, bot.threadId, "first");
    queueSteeredMessage(bot.id, bot.threadId, "second");
    bot.busy = false;

    const prompts: string[] = [];
    const drain = () => {
      drainSteeredMessages(store, (_botId, _threadId, prompt) => {
        void Promise.reject(new Error("provider unavailable")).catch(() => {
          prompts.push(prompt);
          continueQueuedDrainIfIdle(store, bot.id, drain);
        });
      });
    };
    drain();
    await vi.waitFor(() => expect(prompts).toEqual(["first", "second"]));
    expect(store.messages.map((message) => message.text)).toEqual(["first", "second"]);
    expect(_queuedCount("thread-fail-next")).toBe(0);
  });

  it("drains only one queue per bot per settle so a 1:1 and a room wait cannot double-fire", () => {
    const skye = fakeBot("skye-both", "skye-both-1to1", true);
    const store = fakeStore([skye]);
    queueSteeredMessage(skye.id, skye.threadId, "1:1 follow-up");
    queueRoomParticipation(skye.id, "room-both", { groupId: "room-both" });
    skye.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);

    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(2);
    const kinds = run.mock.calls.map((call) => (call[5] ? "room" : "steer"));
    expect(kinds.sort()).toEqual(["room", "steer"]);
    expect(_queuedCount(skye.threadId)).toBe(0);
    expect(_queuedCount("room-both")).toBe(0);
  });

});

// ── e2e: the real server on the gated fake ACP fleet ───────────────────
describe("steer-queue e2e (fake ACP fleet)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let drainGate: string;
  let stopGate: string;
  let roomBusyGate: string;
  let stopRpcDump: string;

  /** the command payloads these tests POST/PATCH */
  type ApiBody = Record<string, unknown>;

  const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const botById = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  const echoes = (bot: any): any[] =>
    bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text?.startsWith("echo: "));

  const until = async (probe: () => Promise<boolean>, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe()) return;
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const newBot = async (instanceId: string, name: string) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: "fake-model" } });
    return bot;
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-test-"));
    mkdirSync(join(home, ".orbit"), { recursive: true });
    mkdirSync(join(home, "gates"), { recursive: true });
    drainGate = join(home, "gates", "drain.gate");
    stopGate = join(home, "gates", "stop.gate");
    roomBusyGate = join(home, "gates", "room-busy.gate");
    stopRpcDump = join(home, "gates", "stop.rpc");
    writeFileSync(
      join(home, ".orbit", "config.json"),
      JSON.stringify({
        instances: {
          steer: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: drainGate },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // the RPC dump lets the interrupt test wait for session/prompt to
          // be in flight — interrupting earlier would be a no-op on a turn
          // the driver has not registered yet
          steerStop: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "echo-gated",
              FAKE_ACP_GATE_FILE: stopGate,
              FAKE_ACP_RPC_DUMP: stopRpcDump,
            },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // Immediate echo — the free room member while another bot is gated.
          steerNow: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          steerRoomBusy: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: roomBusyGate },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    // Without SystemRoot, winsock fails to initialize in the child.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
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
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it(
    "queues sends while busy and drains them as separate attended turns",
    async () => {
      const bot = await newBot("steer", "Steerable");

      // the first send starts a turn that stays open until the gate exists
      const first = await api("POST", `/api/bots/${bot.id}/messages`, { text: "first task please" });
      expect(first.status).toBe(202);
      expect(first.body.queued).toBeUndefined();
      expect((await botById(bot.id)).busy).toBe(true);

      // sends while busy stay off the transcript so they cannot become the leaf
      const second = await api("POST", `/api/bots/${bot.id}/messages`, { text: "steer two" });
      expect(second.status).toBe(202);
      expect(second.body).toMatchObject({ ok: true, queued: true });
      const third = await api("POST", `/api/bots/${bot.id}/messages`, { text: "steer three" });
      expect(third.body.queued).toBe(true);

      let snapshot = await botById(bot.id);
      expect(snapshot.busy).toBe(true);
      expect(snapshot.messages.filter((m: any) => m.role === "user").map((m: any) => m.text)).toEqual([
        "first task please",
      ]);
      expect(echoes(snapshot)).toHaveLength(0); // nothing has answered yet

      // open the gate: turn 1 settles, then each queued send runs its own turn
      writeFileSync(drainGate, "open");
      await until(async () => {
        snapshot = await botById(bot.id);
        return !snapshot.busy && echoes(snapshot).length >= 3;
      }, "the queued turns");

      const replies = echoes(snapshot);
      // two queued messages → two drained turns — not one joined prompt
      expect(replies).toHaveLength(3);
      expect(replies[0].text).toContain("first task please");
      expect(replies[1].text).toContain("steer two");
      expect(replies[1].text).not.toContain("steer three");
      expect(replies[2].text).toContain("steer three");
      expect(replies[2].text).not.toContain("steer two\nsteer three");
      // ...and each is an ordinary attended turn: no webhook untrusted-data
      // framing, no rewind replay wrapper
      expect(replies[1].text).not.toContain("authenticated external webhook");
      expect(replies[1].text).not.toContain("[The user rewound");
      // drain appends each queued line just before its own turn
      const userTexts = snapshot.messages.filter((m: any) => m.role === "user").map((m: any) => m.text);
      expect(userTexts).toEqual(["first task please", "steer two", "steer three"]);
      expect(snapshot.messages.some((m: any) => m.queued)).toBe(false);

      // an idle send with an empty queue runs one normal turn — the drain
      // adds nothing behind it
      const followUp = await api("POST", `/api/bots/${bot.id}/messages`, { text: "plain follow-up" });
      expect(followUp.body.queued).toBeUndefined();
      await until(async () => {
        snapshot = await botById(bot.id);
        return !snapshot.busy && echoes(snapshot).length >= 4;
      }, "the follow-up turn");
      expect(echoes(snapshot)).toHaveLength(4);
    },
    60_000,
  );

  it(
    "drains the queue after an interrupt — stop-then-steer",
    async () => {
      const bot = await newBot("steerStop", "Stoppable");

      const first = await api("POST", `/api/bots/${bot.id}/messages`, { text: "long job" });
      expect(first.status).toBe(202);
      expect((await botById(bot.id)).busy).toBe(true);

      const queued = await api("POST", `/api/bots/${bot.id}/messages`, { text: "after stop please" });
      expect(queued.body.queued).toBe(true);

      // wait for the prompt to be genuinely in flight before stopping it
      await until(async () => {
        try {
          return readFileSync(stopRpcDump, "utf8").includes("session/prompt");
        } catch {
          return false;
        }
      }, "the hung prompt");
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);

      // the interrupt settles the hung turn (ACP cancel grace), and the
      // drain consumes the queue: its message loses the queued flag while
      // the steered turn waits on the still-missing gate
      await until(async () => {
        const snapshot = await botById(bot.id);
        const message = snapshot.messages.find((m: any) => m.text === "after stop please");
        return Boolean(message) && !message.queued;
      }, "the post-interrupt drain");

      writeFileSync(stopGate, "open");
      let snapshot: any;
      await until(async () => {
        snapshot = await botById(bot.id);
        return !snapshot.busy && echoes(snapshot).length >= 1;
      }, "the steered turn");

      // the interrupted turn produced no reply; the steered one answers
      const replies = echoes(snapshot);
      expect(replies).toHaveLength(1);
      expect(replies[0].text).toContain("after stop please");
    },
    60_000,
  );

  it(
    "queues a busy room member and lets the free member answer now",
    async () => {
      const skye = await newBot("steerRoomBusy", "Skye");
      const nova = await newBot("steerNow", "Nova");
      const room = (
        await api("POST", "/api/groups", {
          name: "Two bots",
          memberIds: [skye.id, nova.id],
          setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
        })
      ).body.group;

      const first = await api("POST", `/api/bots/${skye.id}/messages`, { text: "skye is busy elsewhere" });
      expect(first.status).toBe(202);
      expect((await botById(skye.id)).busy).toBe(true);

      const sent = await api("POST", `/api/groups/${room.id}/messages`, { text: "안뇽" });
      expect(sent.status).toBe(202);

      let snapshot: any;
      await until(async () => {
        snapshot = (await api("GET", "/api/bots")).body;
        const group = snapshot.groups.find((candidate: any) => candidate.id === room.id);
        const novaReply = group?.messages.some(
          (message: any) => message.role === "bot" && message.kind === "text" && message.from?.botId === nova.id,
        );
        return Boolean(novaReply) && !snapshot.groups.find((candidate: any) => candidate.id === room.id)?.working;
      }, "Nova's room reply while Skye is busy");

      const group = snapshot.groups.find((candidate: any) => candidate.id === room.id);
      expect(
        group.messages.some((message: any) => message.tool?.name?.includes("skipped this round")),
      ).toBe(false);
      expect(
        group.messages.filter(
          (message: any) => message.role === "bot" && message.kind === "text" && message.from?.botId === skye.id,
        ),
      ).toHaveLength(0);
      expect((await botById(skye.id)).busy).toBe(true);

      writeFileSync(roomBusyGate, "open");
      await until(async () => {
        snapshot = (await api("GET", "/api/bots")).body;
        const current = snapshot.groups.find((candidate: any) => candidate.id === room.id);
        const skyeReplies = current?.messages.filter(
          (message: any) => message.role === "bot" && message.kind === "text" && message.from?.botId === skye.id,
        ) ?? [];
        const skyeBusy = snapshot.bots.find((candidate: any) => candidate.id === skye.id)?.busy;
        return !skyeBusy && !current?.working && skyeReplies.length >= 1;
      }, "Skye's queued room turn");

      const drained = snapshot.groups.find((candidate: any) => candidate.id === room.id);
      expect(
        drained.messages.some((message: any) => message.tool?.name?.includes("skipped this round")),
      ).toBe(false);
      expect(
        drained.messages.filter(
          (message: any) => message.role === "bot" && message.kind === "text" && message.from?.botId === skye.id,
        ),
      ).toHaveLength(1);
      expect(
        drained.messages.filter(
          (message: any) => message.role === "bot" && message.kind === "text" && message.from?.botId === nova.id,
        ).length,
      ).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );
});
