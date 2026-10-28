import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { createBotRoutes } from "./bot-routes.ts";
import type { ModelSelection } from "./contracts.ts";
import { LimitWaits } from "./limit-wait.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { _resetSteerQueue } from "./steer-queue.ts";
import { Store } from "./store.ts";

const dirs: string[] = [];
afterEach(() => { _resetSteerQueue(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "limit-wait-routes-")); dirs.push(dir);
  const selection = { instanceId: "claude", model: "opus", effort: "max" as const };
  const store = new Store(() => selection);
  const bot = store.createBot({}, { seedMessages: false });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "finish this" });
  const state = { now: Date.parse("2026-10-28T00:00:00Z") };
  const report = () => ({ observedAt: new Date(state.now).toISOString(), windows: [
    { id: "five_hour", usedPercent: 0, resetsAt: null }, { id: "seven_day", usedPercent: 20, resetsAt: null },
  ] });
  type Result = { report: ReturnType<typeof report>; retryAt: number };
  let release!: (value: Result) => void;
  const usage = vi.fn(() => new Promise<Result>((resolve) => { release = resolve; }));
  const dispatch = vi.fn(async () => {});
  const waits = new LimitWaits({ file: join(dir, "limit-waits.json"), now: () => state.now, deviceId: () => "pc-a",
    current: () => {
      const current = store.bot(bot.id);
      return current && store.taskByThread(bot.id, current.threadId) ? { threadId: current.threadId, controlKey: JSON.stringify(current.modelSelection), busy: Boolean(current.busy) } : null;
    }, usage, dispatch });
  waits.track(bot.id, bot.threadId, selection); waits.bind(bot.threadId, "turn");
  waits.failed(bot.threadId, "turn", state.now + 60_000, "error", ["five_hour", "seven_day"]);
  waits.settled(bot.threadId, "turn", false);
  const row = waits.store.all()[0]!;
  state.now = row.nextCheckAt;
  const steer = vi.fn(async () => true);
  const interruptTurn = vi.fn(async () => {});
  const startTurn = vi.fn(async () => ({}));
  const noop = () => {};
  const routes = createBotChatRoutes({
    cfg: {}, threadSyncGate: { enabled: false }, store, registry: new Map([["claude", { adapter: { capabilities: { queueing: true }, steer, interruptTurn } }]]),
    wireBot: () => ({}), wireTask: () => ({}),
    sendSequencer: new SendSequencer(), startTurn, noteTalked: noop, pullSyncedThread: noop, resolveReplyTarget: () => undefined,
    ensureChatLatency: noop, markChatLatency: noop, broadcast: noop, clearUnattended: noop, resumePaneWakes: noop,
    botHasActiveTurn: () => Boolean(bot.busy), paneNoteTurnThreads: new Set(), busyResumeThreads: new Set(), drainQueuedSends: noop,
    routines: { activeRunForBot: () => null }, taskResumes: { forgetBot: noop }, closeOpenApprovals: noop,
    bumpTurnEpoch: () => 1, markThreadInterrupted: noop, flushInterruptedTask: noop, releaseInterruptedBot: noop,
    cancelUsageWait: (botId: string, id?: string) => waits.cancel(botId, id),
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  async function request(route: "send" | "interrupt" | "cancelUsageWait", body: object = {}, waitId = row.id) {
    let status = 0;
    let data: Record<string, unknown> = {};
    const res = { writeHead: (code: number) => { status = code; }, end: (raw: string) => { data = JSON.parse(raw); } } as unknown as ServerResponse;
    const match = ["", bot.id, waitId] as RegExpMatchArray;
    if (route === "cancelUsageWait") routes.cancelUsageWait(res, match);
    else await routes[route](Readable.from([JSON.stringify(body)]) as IncomingMessage, res, match);
    return { status, data };
  }
  return { bot, row, store, waits, routes, steer, dispatch, startTurn, interruptTurn, request,
    begin: () => waits.tick(), release: () => release({ report: report(), retryAt: state.now + 30_000 }) };
}

it.each(["new", "queued", "steered"])("an accepted %s user send cancels an in-flight usage read", async (delivery) => {
  const h = harness();
  const checking = h.begin();
  if (delivery !== "new") h.store.setActivity(h.bot.id, "working");
  const response = await h.request("send", { text: "new instruction", ...(delivery === "queued" ? { deliver: "after" } : {}) });
  expect(response.status).toBe(202);
  if (delivery === "queued") expect(response.data.queued).toBe(true);
  if (delivery === "steered") expect(response.data.steered).toBe(true);
  h.release(); await checking;
  expect(h.waits.held(h.bot.id)).toBe(false);
  expect(h.dispatch).not.toHaveBeenCalled();
});

it.each(["model", "engine", "effort"])("an accepted %s pick cancels a read before applying the selection", async (kind) => {
  const h = harness();
  const checking = h.begin();
  const selection: ModelSelection = { ...h.bot.modelSelection, ...(kind === "model" ? { model: "sonnet" } : kind === "engine" ? { instanceId: "codex" } : { effort: "high" as const }) };
  const cancel = vi.fn((botId: string) => {
    expect(h.bot.modelSelection).not.toEqual(selection);
    h.waits.cancel(botId);
  });
  const route = createBotRoutes({ cfg: {}, store: h.store, registry: new Map(), wireBot: (bot: unknown) => bot,
    checkedModelSelection: () => ({ ok: true, selection }), cancelUsageWait: cancel } as unknown as Parameters<typeof createBotRoutes>[0]);
  const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  await route.patch(Readable.from([JSON.stringify({ modelSelection: selection, holdForSwitch: true })]) as IncomingMessage, res, ["", h.bot.id] as RegExpMatchArray);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(h.bot.modelSelection).toEqual(selection);
  h.release(); await checking;
  expect(h.dispatch).not.toHaveBeenCalled();
});

it("does not acknowledge a model change when cancellation cannot be persisted", async () => {
  const h = harness();
  const before = { ...h.bot.modelSelection };
  const selection: ModelSelection = { ...before, effort: "high" };
  const route = createBotRoutes({ cfg: {}, store: h.store, registry: new Map(),
    checkedModelSelection: () => ({ ok: true, selection }), cancelUsageWait: () => { throw new Error("disk full"); } } as unknown as Parameters<typeof createBotRoutes>[0]);
  const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  await expect(route.patch(Readable.from([JSON.stringify({ modelSelection: selection })]) as IncomingMessage, res, ["", h.bot.id] as RegExpMatchArray)).rejects.toThrow("disk full");
  expect(h.bot.modelSelection).toEqual(before);
});

it("cancels before accepting a task switch during a usage read", async () => {
  const h = harness();
  const target = h.store.createTask(h.bot.id, "Other", false)!;
  const checking = h.begin();
  const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  await h.routes.switchTask(res, ["", h.bot.id, target.threadId] as RegExpMatchArray, new URL("http://localhost/"), () => ({}));
  expect(h.bot.threadId).toBe(target.threadId);
  h.release(); await checking;
  expect(h.waits.held(h.bot.id)).toBe(false);
  expect(h.dispatch).not.toHaveBeenCalled();
});

it("leaves the task and branch unchanged if cancellation cannot be saved", async () => {
  const h = harness();
  const before = h.bot.threadId;
  const target = h.store.createTask(h.bot.id, "Other", false)!;
  const oldLeaf = h.store.activeLeaf(before);
  const latest = h.store.appendMessage(before, { role: "bot", kind: "text", text: "progress" });
  const routes = createBotChatRoutes({ store: h.store, threadSyncGate: { enabled: false }, pullSyncedThread: () => {},
    routines: { activeRunForBot: () => null }, cancelUsageWait: () => { throw new Error("disk full"); } } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  await expect(routes.switchTask(res, ["", h.bot.id, target.threadId] as RegExpMatchArray, new URL("http://localhost/"), () => ({}))).rejects.toThrow("disk full");
  expect(h.bot.threadId).toBe(before);
  await expect(routes.activeBranch(Readable.from([JSON.stringify({ messageId: oldLeaf })]) as IncomingMessage, res, ["", h.bot.id] as RegExpMatchArray)).rejects.toThrow("disk full");
  expect(h.store.activeLeaf(before)).toBe(latest.id);
});

it.each([false, true])("Stop cancels while idle, including requireSettled=%s", async (requireSettled) => {
  const h = harness();
  const checking = h.begin();
  expect(h.bot.busy).toBeFalsy();
  expect((await h.request("interrupt", { requireSettled })).status).toBe(200);
  h.release(); await checking;
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.waits.held(h.bot.id)).toBe(false);
});

it("the scoped Cancel route is idempotent and an unrelated wait ID does not cancel this request", async () => {
  const h = harness();
  const checking = h.begin();
  expect((await h.request("cancelUsageWait", {}, "other-wait")).status).toBe(200);
  expect(h.waits.held(h.bot.id)).toBe(true);
  expect((await h.request("cancelUsageWait")).status).toBe(200);
  expect((await h.request("cancelUsageWait")).status).toBe(200);
  h.release(); await checking;
  expect(h.dispatch).not.toHaveBeenCalled();
});
