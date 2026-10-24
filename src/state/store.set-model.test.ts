// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelPickerControl } from "@/components/ModelPicker";
import { StoreProvider, useStore, type Bot, type InstanceInfo, type ModelSelection } from "./store";

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
  it("acknowledges a switch pick only after its PATCH returns", async () => {
    const patch = await mount(botOf(true));
    let applied!: (response: Response) => void;
    patch.mockImplementationOnce(() => new Promise<Response>((resolve) => { applied = resolve; }));
    const onApplied = vi.fn();
    await act(async () => store.dispatch({ type: "setModel", botId: "b1", selection: next, holdForSwitch: true, onApplied }));
    expect(onApplied).not.toHaveBeenCalled();
    await act(async () => applied(Response.json({ bot: botOf(true, next) })));
    expect(onApplied).toHaveBeenCalledExactlyOnceWith(botOf(true, next));
  });

  it("asks Stop for a settled switch acknowledgement and returns its result", async () => {
    await mount(botOf(true));
    const fetchBefore = fetch;
    const stopped = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, stopped: true, returned: [] }));
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/interrupt") ? stopped(url, init) : fetchBefore(url, init)));
    const onStopped = vi.fn();
    await act(async () => store.dispatch({ type: "interrupt", botId: "b1", switchThreadId: "t-b1", onStopped }));
    expect(JSON.parse(String(stopped.mock.calls[0][1]?.body))).toEqual({ threadId: "t-b1", requireSettled: true });
    expect(onStopped).toHaveBeenCalledExactlyOnceWith({ stopped: true, returned: [] });
  });

  it("releases the stop hold on an unconfirmed switch stop and keeps it on plain Stop", async () => {
    await mount(botOf(true));
    const fetchBefore = fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/interrupt") ? Promise.resolve(Response.json({ ok: true, stopped: false, returned: [] })) : fetchBefore(url, init)));
    await act(async () => store.dispatch({ type: "interrupt", botId: "b1", switchThreadId: "t-b1" }));
    expect(store.state.stoppingBots.b1).toBeUndefined();
    expect(store.state.bots[0].busy).toBe(true);
    await act(async () => store.dispatch({ type: "interrupt", botId: "b1" }));
    expect(store.state.stoppingBots.b1).toBeDefined();
    expect(store.state.bots[0].busy).toBe(false);
  });

  it("forwards the rerun pick guard and shows a rejected fork's error row", async () => {
    await mount(botOf(false));
    const fetchBefore = fetch;
    const edit = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ error: "changed" }, { status: 409 }));
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/edit") ? edit(url, init) : fetchBefore(url, init)));
    const onSettled = vi.fn();
    await act(async () => store.dispatch({ type: "editMessage", botId: "b1", messageId: "u1", text: "hello", expectedSelection: next, onSettled }));
    expect(JSON.parse(String(edit.mock.calls[0][1]?.body))).toEqual({ text: "hello", expectedSelection: next });
    expect(onSettled.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(store.state.error).toBe("changed");
  });

  it("shows one error row and clears the transition when the edit refuses a Switch rerun", async () => {
    const bot: Bot = { ...botOf(true), messages: [{ id: "u1", role: "user", kind: "text", text: "hello", at: 1 }] };
    await mount(bot);
    const fetchBefore = fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/interrupt") ? Promise.resolve(Response.json({ ok: true, stopped: true, returned: [] }))
      : url.endsWith("/edit") ? Promise.resolve(Response.json({ error: "changed" }, { status: 409 })) : fetchBefore(url, init)));
    const instances = [["claude", "claudeAgent", running.model], ["codex", "codex", "gpt-6.1-sol"]].map(([instanceId, driverKind, model]) => ({
      instanceId, driverKind, displayName: instanceId,
      snapshot: { state: "available", authenticated: true }, models: { default: model, options: [{ id: model, label: model }] }, capabilities: {},
    })) as InstanceInfo[];
    const control = createRef<() => void>();
    const onSwitching = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const picker = createRoot(host);
    await act(async () => picker.render(createElement(ModelPickerControl, { bot, switchControl: control, onSwitching, store: { state: { instances, selectedId: "b1" }, dispatch: store.dispatch, refreshInstances: async () => {} } })));
    await act(async () => control.current!());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-model-cell="gpt-6.1-sol"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".model-cross-footer button")!.click());
    expect(onSwitching.mock.calls.map(([stage]) => stage)).toEqual(["saving", "rerunning", null]);
    expect(store.state.error).toBe("changed");
    await act(async () => picker.unmount());
    host.remove();
  });

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
