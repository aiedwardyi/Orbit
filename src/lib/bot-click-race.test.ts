import { afterEach, describe, expect, it, vi } from "vitest";

import { landOnSearchHit } from "./focus-message";
import type { SearchHit } from "./search-hit";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const botState = (id: string, threadId: string) => ({ id, threadId, messages: [] });

const hitFor = (botId: string, threadId: string, messageId: string): SearchHit => ({
  botId,
  name: botId,
  threadId,
  messageId,
  role: "bot",
  kind: "text",
  at: 1,
  snippet: "match here",
  matchStart: 0,
  matchLength: 5,
  onActivePath: true,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rapid sidebar search landings", () => {
  it("lands on the last-clicked bot when chat loads resolve out of order", async () => {
    const state = {
      bots: [botState("a", "a-t0"), botState("b", "b-t0"), botState("c", "c-t0")],
      groups: [],
    };
    const pending = new Map<string, ReturnType<typeof deferred<object>>>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const slot = deferred<object>();
        pending.set(path, slot);
        const body = await slot.promise;
        return { ok: true, json: async () => body };
      }),
    );
    const dispatch = vi.fn();

    const landedA = landOnSearchHit(hitFor("a", "a-t1", "m-a"), state as never, dispatch);
    const landedB = landOnSearchHit(hitFor("b", "b-t1", "m-b"), state as never, dispatch);
    const landedC = landOnSearchHit(hitFor("c", "c-t1", "m-c"), state as never, dispatch);
    await vi.waitFor(() => expect(pending.size).toBe(3));

    pending.get("/api/bots/c/tasks/c-t1")!.resolve({ bot: { id: "c", threadId: "c-t1" } });
    pending.get("/api/bots/b/tasks/b-t1")!.resolve({ bot: { id: "b", threadId: "b-t1" } });
    pending.get("/api/bots/a/tasks/a-t1")!.resolve({ bot: { id: "a", threadId: "a-t1" } });
    await Promise.all([landedA, landedB, landedC]);

    expect(dispatch.mock.calls.map(([action]) => action).slice(0, 3)).toMatchObject([
      { type: "select", id: "a" },
      { type: "select", id: "b" },
      { type: "select", id: "c" },
    ]);
    const switched = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "taskSwitched");
    expect(switched.map((action) => action.bot.id)).toEqual(["c"]);
    const focused = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "focusMessage");
    expect(focused.map((action) => action.threadId)).toEqual(["c-t1"]);
  });
});
