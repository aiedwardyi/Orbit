// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type ModelSelection } from "./store";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
}

const running: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5", mode: "pinned" };
const next: ModelSelection = { instanceId: "codex", model: "gpt-6-sol", mode: "pinned" };
const botOf = (busy: boolean, pending: ModelSelection | null = null): Bot => ({
  id: "b1",
  threadId: "t-b1",
  name: "b1",
  title: "",
  description: "",
  color: "green",
  notifications: false,
  unread: false,
  busy,
  messages: [],
  modelSelection: running,
  pendingModelSelection: pending,
});

const duplicatePatch = vi.fn();
let store: ReturnType<typeof useStore>;
let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(bot: Bot) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const patch = vi.fn(async () => Response.json({ bot }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/bots?messages=200") return Response.json({ bots: [bot], groups: [], computerControl: {} });
    if (String(url) === "/api/bots/b1" && init?.method === "PATCH") return patch();
    if (String(url) === "/api/bots" && init?.method === "POST") return Response.json({ bot: { ...bot, id: "b2", threadId: "t-b2" } });
    if (String(url) === "/api/bots/b2" && init?.method === "PATCH") {
      duplicatePatch(JSON.parse(String(init.body)));
      return Response.json({ bot: { ...bot, id: "b2", threadId: "t-b2" } });
    }
    return new Promise<Response>(() => {});
  }));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  function Probe() {
    store = useStore();
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
  });
  await vi.waitFor(() => expect(store.state.bots).toHaveLength(1));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return patch;
}

describe("setModel", () => {
  it("holds a pick on a busy bot as pending and raises no error", async () => {
    const patch = await mount(botOf(true));
    await act(async () => store.dispatch({ type: "setModel", botId: "b1", selection: next }));
    await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(store.state.bots[0]).toMatchObject({ modelSelection: running, pendingModelSelection: next });
    expect(store.state.error).toBeNull();
  });

  it("applies a pick on an idle bot at once and drops a held one", async () => {
    await mount(botOf(false, next));
    await act(async () => store.dispatch({ type: "setModel", botId: "b1", selection: running }));
    expect(store.state.bots[0]).toMatchObject({ modelSelection: running, pendingModelSelection: null });
  });
});

describe("duplicateBot", () => {
  it("copies a pending pick, the model the UI shows", async () => {
    await mount(botOf(true, next));
    await act(async () => store.dispatch({ type: "duplicateBot", botId: "b1" }));
    await vi.waitFor(() => expect(duplicatePatch).toHaveBeenCalledOnce());
    expect(duplicatePatch.mock.calls[0][0].modelSelection).toEqual(next);
  });
});
