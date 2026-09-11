// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Action, type AppState } from "./store";

type LiveFrame = { kind: "hello"; resumed: false; cursor: string } | { kind: "bots.order"; botIds: string[] };

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.current = this;
  }

  send(frame: LiveFrame, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId });
  }
}

const bot = (id: string) => ({ id, threadId: `${id}-thread`, name: id, messages: [] });

type Reply = { bots: ReturnType<typeof bot>[]; groups: [] } | { botIds: string[] } | { error: string };

const respond = (status: number, body: Reply) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Lets a failure handler and any refetch it starts run to the end.
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

async function mountStore() {
  const orderRequests: RequestInit[] = [];
  const answers: Array<(response: Response) => void> = [];
  const refetches: Array<() => void> = [];
  let serverOrder = ["a", "b", "c"];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
    if (path === "/api/bots") return respond(200, { bots: serverOrder.map(bot), groups: [] });
    if (path === "/api/bots?messages=0") {
      const saved = serverOrder;
      return new Promise<Response>((resolve) => {
        refetches.push(() => resolve(respond(200, { bots: saved.map(bot), groups: [] })));
      });
    }
    if (path !== "/api/bots/order") return respond(404, { error: "not in this test" });
    orderRequests.push(init);
    return new Promise<Response>((resolve) => answers.push(resolve));
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let store: { state: AppState; dispatch: (action: Action) => void } | null = null;
  const Probe = () => {
    store = useStore();
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  const current = () => store!;
  const order = () => current().state.bots.map((candidate) => candidate.id);
  await act(async () => FakeEventSource.current!.send({ kind: "hello", resumed: false, cursor: "c0" }));
  await vi.waitFor(() => expect(order()).toEqual(["a", "b", "c"]));
  return {
    order,
    dispatch: (action: Action) => act(async () => current().dispatch(action)),
    error: () => current().state.error,
    orderRequests,
    answerOrder: (index: number, response: Response) => answers[index]!(response),
    refetchCount: () => refetches.length,
    answerRefetch: (index: number) => refetches[index]!(),
    saveOnServer: (ids: string[]) => {
      serverOrder = ids;
    },
    unmount: () => act(async () => root.unmount()),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reorderBots", () => {
  it("paints the new order at once and puts the server's back when the server refuses it", async () => {
    const store = await mountStore();
    try {
      await store.dispatch({ type: "reorderBots", botIds: ["c", "a", "b"] });
      expect(store.order()).toEqual(["c", "a", "b"]);
      expect(store.orderRequests).toHaveLength(1);
      expect(store.orderRequests[0]).toMatchObject({ method: "PUT", body: JSON.stringify({ botIds: ["c", "a", "b"] }) });

      store.answerOrder(0, respond(400, { error: "botIds must list every bot exactly once" }));
      await vi.waitFor(() => expect(store.refetchCount()).toBe(1));
      expect(store.error()).toBe("botIds must list every bot exactly once");
      store.answerRefetch(0);
      await vi.waitFor(() => expect(store.order()).toEqual(["a", "b", "c"]));
    } finally {
      await store.unmount();
    }
  });

  it("ignores an older reorder that fails after a newer one was saved", async () => {
    const store = await mountStore();
    try {
      await store.dispatch({ type: "reorderBots", botIds: ["c", "a", "b"] });
      await store.dispatch({ type: "reorderBots", botIds: ["b", "c", "a"] });
      store.saveOnServer(["b", "c", "a"]);
      store.answerOrder(1, respond(200, { botIds: ["b", "c", "a"] }));
      await settle();
      store.answerOrder(0, respond(400, { error: "botIds must list every bot exactly once" }));
      await settle();
      expect(store.order()).toEqual(["b", "c", "a"]);
      expect(store.error()).toBeNull();
    } finally {
      await store.unmount();
    }
  });

  it("trusts the saved order's frame when that reorder's response is lost", async () => {
    const store = await mountStore();
    try {
      await store.dispatch({ type: "reorderBots", botIds: ["c", "a", "b"] });
      store.saveOnServer(["c", "a", "b"]);
      await act(async () => FakeEventSource.current!.send({ kind: "bots.order", botIds: ["c", "a", "b"] }, "c1"));
      store.answerOrder(0, respond(502, { error: "connection reset" }));
      await settle();
      expect(store.order()).toEqual(["c", "a", "b"]);
      expect(store.error()).toBeNull();
      expect(store.refetchCount()).toBe(0);
    } finally {
      await store.unmount();
    }
  });

  it("keeps another window's order when a failed reorder's refetch lands after it", async () => {
    const store = await mountStore();
    try {
      await store.dispatch({ type: "reorderBots", botIds: ["c", "a", "b"] });
      store.answerOrder(0, respond(400, { error: "botIds must list every bot exactly once" }));
      await vi.waitFor(() => expect(store.refetchCount()).toBe(1));
      store.saveOnServer(["b", "a", "c"]);
      await act(async () => FakeEventSource.current!.send({ kind: "bots.order", botIds: ["b", "a", "c"] }, "c1"));
      store.answerRefetch(0);
      await settle();
      expect(store.order()).toEqual(["b", "a", "c"]);
    } finally {
      await store.unmount();
    }
  });

  it("keeps an accepted order and follows one saved in another window", async () => {
    const store = await mountStore();
    try {
      await store.dispatch({ type: "reorderBots", botIds: ["b", "c", "a"] });
      store.answerOrder(0, respond(200, { botIds: ["b", "c", "a"] }));
      await act(async () => {});
      expect(store.order()).toEqual(["b", "c", "a"]);

      await act(async () => FakeEventSource.current!.send({ kind: "bots.order", botIds: ["c", "b", "a"] }, "c1"));
      expect(store.order()).toEqual(["c", "b", "a"]);
    } finally {
      await store.unmount();
    }
  });
});
