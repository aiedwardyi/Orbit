import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { createBotRoutes } from "./bot-routes.ts";
import { modelPickPatch } from "./pending-model.ts";
import { _resetSteerQueue, queueSteeredMessage } from "./steer-queue.ts";
import { Store } from "./store.ts";

const old = { instanceId: "old", model: "old-model", mode: "pinned" as const };
const next = { instanceId: "next", model: "next-model", mode: "pinned" as const };
let store: Store;
let bot: ReturnType<Store["createBot"]>;
let routine = false;
const cancelRun = vi.fn(async () => {});
const interruptTurn = vi.fn(async (_threadId: string) => {});
const startTurn = vi.fn(async (_botId: string, _text: string, _opts?: unknown) => ({}));
const release = vi.fn(() => store.setActivity(bot.id, "idle"));
const closeOpenApprovals = vi.fn();
let heldUntil = Infinity;
const onDriver = { botHasActiveTurn: (_botId: string, threadId = bot.threadId) => Boolean(bot.busy) || hasSession(threadId) };

function hasSession(threadId: string) {
  return threadId === bot.threadId && Date.now() < heldUntil;
}

function routes(deps = {}) {
  return createBotChatRoutes({
    store,
    registry: { get: () => ({ adapter: { interruptTurn } }) },
    routines: { activeRunForBot: () => routine ? { id: "r1", threadId: bot.threadId } : null, cancelRun },
    botHasActiveTurn: () => Boolean(bot.busy),
    taskResumes: { forgetBot: vi.fn() },
    broadcast: vi.fn(), bumpTurnEpoch: () => 1, markThreadInterrupted: vi.fn(), flushInterruptedTask: vi.fn(),
    closeOpenApprovals: vi.fn(), releaseInterruptedBot: release,
    startTurn, resolveReplyTarget: vi.fn(),
    ...deps,
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
}

async function request(route: "interrupt" | "edit", body: unknown, messageId = "", deps = {}) {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  let status = 0;
  let data: any;
  const res = { writeHead: (code: number) => { status = code; }, end: (raw: string) => { data = JSON.parse(String(raw)); } } as unknown as ServerResponse;
  await routes(deps)[route](req, res, ["", bot.id, messageId] as RegExpMatchArray);
  return { status, data };
}

function stopThenRerun(source: { id: string; text?: string }) {
  return request("interrupt", { threadId: bot.threadId, requireSettled: true }, "", onDriver).then(async (stop) => ({
    stop,
    rerun: stop.data.stopped ? await request("edit", { text: source.text, expectedSelection: next }, source.id, onDriver) : null,
  }));
}

beforeEach(() => {
  _resetSteerQueue();
  store = new Store(() => old);
  bot = store.createBot();
  store.setActivity(bot.id, "working");
  store.patchBot(bot.id, modelPickPatch(bot, next));
  interruptTurn.mockReset().mockResolvedValue(undefined);
  startTurn.mockClear();
  release.mockClear();
  routine = false;
  cancelRun.mockClear();
  closeOpenApprovals.mockClear();
  heldUntil = Infinity;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("no reply switch acknowledgement", () => {
  it("keeps an effort-only switch pending instead of applying it to the waiting turn", async () => {
    const selection = { ...old, effort: "high" as const };
    store.patchBot(bot.id, { pendingModelSelection: undefined });
    const applyEffort = vi.fn(async () => true);
    const route = createBotRoutes({
      store, registry: { get: () => ({ adapter: { applyEffort } }) },
      checkedModelSelection: () => ({ ok: true, selection }), wireBot: (value: unknown) => value,
    } as unknown as Parameters<typeof createBotRoutes>[0]);
    const req = Readable.from([JSON.stringify({ modelSelection: selection, holdForSwitch: true })]) as IncomingMessage;
    const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    await route.patch(req, res, ["", bot.id] as RegExpMatchArray);
    expect(applyEffort).not.toHaveBeenCalled();
    expect(bot.modelSelection).toEqual(old);
    expect(bot.pendingModelSelection).toEqual(selection);
  });

  it("acknowledges one stop only after the pending pick applies", async () => {
    const result = await request("interrupt", { threadId: bot.threadId, requireSettled: true });
    expect(result.data).toMatchObject({ stopped: true });
    expect(interruptTurn).toHaveBeenCalledExactlyOnceWith(bot.threadId);
    expect(bot.modelSelection).toEqual(next);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("acknowledges the composer's existing routine cancellation path", async () => {
    routine = true;
    const result = await request("interrupt", { threadId: bot.threadId, requireSettled: true });
    expect(result.data.stopped).toBe(true);
    expect(cancelRun).toHaveBeenCalledExactlyOnceWith("r1");
    expect(bot.modelSelection).toEqual(next);
  });

  it("finishes a rejected stop like Stop and does not acknowledge the thread its driver still holds", async () => {
    vi.useFakeTimers();
    interruptTurn.mockRejectedValueOnce(new Error("failed"));
    const result = request("interrupt", { threadId: bot.threadId, requireSettled: true }, "", { ...onDriver, closeOpenApprovals });
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await result).data).toMatchObject({ stopped: false });
    expect(closeOpenApprovals).toHaveBeenCalledExactlyOnceWith(bot.threadId);
    expect(release).toHaveBeenCalledTimes(1);
    expect(bot.busy).toBe(false);
    expect(bot.modelSelection).toEqual(next);
    expect(bot.pendingModelSelection).toBeUndefined();
  });

  it.each([300, 5_000])("acknowledges the stop once its driver lets go %i ms later, so the rerun lands once on the new pick", async (hold) => {
    vi.useFakeTimers();
    const source = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello" });
    interruptTurn.mockImplementationOnce(async () => { heldUntil = Date.now() + hold; });
    const flow = stopThenRerun(source);
    await vi.advanceTimersByTimeAsync(hold);
    const { stop, rerun } = await flow;
    expect(stop.data.stopped).toBe(true);
    expect(rerun?.status).toBe(202);
    expect(interruptTurn).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(store.messagesFor(bot.threadId).filter((message) => message.role === "user")).toHaveLength(2);
    expect(bot.modelSelection).toEqual(next);
  });

  it("answers not stopped when the driver never lets go, with the bot idle and no rerun", async () => {
    vi.useFakeTimers();
    const source = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello" });
    let done = false;
    const flow = stopThenRerun(source).then((result) => { done = true; return result; });
    await vi.advanceTimersByTimeAsync(5_950);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    const { stop, rerun } = await flow;
    expect(stop.data).toMatchObject({ stopped: false });
    expect(rerun).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
    expect(bot.busy).toBe(false);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("answers plain Stop at once while the driver still holds the thread", async () => {
    vi.useFakeTimers();
    interruptTurn.mockRejectedValueOnce(new Error("failed"));
    const normal = await request("interrupt", {}, "", onDriver);
    expect(normal.data).toEqual({ ok: true, returned: [] });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge an unsettled stop", async () => {
    let settle!: () => void;
    interruptTurn.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
    let done = false;
    const result = request("interrupt", { threadId: bot.threadId, requireSettled: true }).then((response) => { done = true; return response; });
    await vi.waitFor(() => expect(interruptTurn).toHaveBeenCalled());
    expect(done).toBe(false);
    expect(bot.pendingModelSelection).toEqual(next);
    expect(release).not.toHaveBeenCalled();
    settle();
    expect((await result).data.stopped).toBe(true);
  });

  it("does not stop again if the turn has already ended", async () => {
    store.setActivity(bot.id, "idle");
    const result = await request("interrupt", { threadId: bot.threadId, requireSettled: true });
    expect(result.data).toMatchObject({ stopped: false });
    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it("returns queued sends in order as ordinary Stop does", async () => {
    queueSteeredMessage(bot.id, bot.threadId, "first");
    queueSteeredMessage(bot.id, bot.threadId, "second");
    const result = await request("interrupt", { threadId: bot.threadId, requireSettled: true });
    expect(result.data.stopped).toBe(true);
    expect(result.data.returned.map((send: { text: string }) => send.text)).toEqual(["first", "second"]);
  });

  it("refuses to fork on a different pick after Stop", async () => {
    const source = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello" });
    store.setActivity(bot.id, "idle");
    store.patchBot(bot.id, { modelSelection: old });
    const result = await request("edit", { text: source.text, expectedSelection: next }, source.id);
    expect(result.status).toBe(409);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("forks the complete attachment text and retains the old answer", async () => {
    const text = 'Look\n\n<attached-image path="/tmp/image.png" />\n\n<attached-file path="/tmp/report.pdf" name="report.pdf" size="8" />';
    const source = store.appendMessage(bot.threadId, { role: "user", kind: "text", text });
    const answer = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Earlier answer" });
    expect((await request("interrupt", { threadId: bot.threadId, requireSettled: true })).data.stopped).toBe(true);
    const result = await request("edit", { text, expectedSelection: next }, source.id);
    expect(result.status).toBe(202);
    expect(startTurn).toHaveBeenCalledTimes(1);
    const fork = store.messagesFor(bot.threadId).at(-1)!;
    expect(fork.text).toBe(text);
    expect(fork.parentId).toBe(source.parentId);
    expect(fork.id).not.toBe(source.id);
    expect(store.messagesFor(bot.threadId)).toContainEqual(answer);
    expect(store.activePath(bot.threadId)).toContainEqual(fork);
    expect(bot.modelSelection).toEqual(next);
  });
});
