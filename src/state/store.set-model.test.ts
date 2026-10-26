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

async function mount(bot: Bot, render?: () => ReturnType<typeof createElement> | null) {
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
    return Response.json({ error: "not in this test" }, { status: 404 });
  }));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  function Probe() {
    store = useStore();
    return render?.() ?? null;
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

  it("lets a follow-up still posting at Switch be the one run, with no rerun or error row", async () => {
    const bot: Bot = { ...botOf(true), messages: [{ id: "u1", role: "user", kind: "text", text: "hello", at: 1 }] };
    await mount(bot);
    const fetchBefore = fetch;
    let receipt!: (response: Response) => void;
    let stopped!: (response: Response) => void;
    const routes = vi.fn((url: string, init?: RequestInit) => url.endsWith("/messages") ? new Promise<Response>((resolve) => { receipt = resolve; })
      : url.endsWith("/interrupt") ? new Promise<Response>((resolve) => { stopped = resolve; })
      : url.endsWith("/edit") ? Promise.resolve(Response.json({ error: "the bot is working - stop it before editing" }, { status: 409 })) : fetchBefore(url, init));
    vi.stubGlobal("fetch", routes);
    await act(async () => store.dispatch({ type: "send", botId: "b1", text: "and this", sendId: "s2" }));
    const instances: InstanceInfo[] = [["claude", "claudeAgent", running.model], ["codex", "codex", "gpt-6.1-sol"]].map(([instanceId, driverKind, model]) => ({
      instanceId, driverKind, displayName: instanceId,
      snapshot: { state: "available", authenticated: true }, models: { default: model, options: [{ id: model, label: model }] }, capabilities: {},
    }));
    const control = createRef<() => void>();
    const onSwitching = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const picker = createRoot(host);
    await act(async () => picker.render(createElement(ModelPickerControl, { bot, accepted: store.state.acceptedSends["t-b1"], switchControl: control, onSwitching, store: { state: { instances, selectedId: "b1" }, dispatch: store.dispatch, refreshInstances: async () => {} } })));
    await act(async () => control.current!());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-model-cell="gpt-6.1-sol"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".model-cross-footer button")!.click());
    await act(async () => receipt(Response.json({ ok: true, threadId: "t-b1", message: { id: "u2", parentId: "u1", role: "user", kind: "text", text: "and this", at: 2, sendId: "s2" } }, { status: 202 })));
    await act(async () => stopped(Response.json({ ok: true, stopped: true, returned: [] })));
    expect(routes.mock.calls.map(([url]) => url).filter((url) => /\/(messages|edit)$/.test(url))).toEqual(["/api/bots/b1/messages"]);
    expect(onSwitching.mock.calls.map(([stage]) => stage)).toEqual(["saving", null]);
    expect(store.state.error).toBeNull();
    await act(async () => picker.unmount());
    host.remove();
  });

  it.each(["steered", "queued", "returned", "posting"] as const)("checks a %s follow-up after the switch stop", async (followUp) => {
    const bot: Bot = { ...botOf(true), messages: [{ id: "u1", role: "user", kind: "text", text: "hello", at: 1 }] };
    const instances: InstanceInfo[] = [["claude", "claudeAgent", running.model], ["codex", "codex", "gpt-6.1-sol"]].map(([instanceId, driverKind, model]) => ({
      instanceId, driverKind, displayName: instanceId,
      snapshot: { state: "available", authenticated: true }, models: { default: model, options: [{ id: model, label: model }] }, capabilities: {},
    }));
    const control = createRef<() => void>();
    const onSwitching = vi.fn();
    const patch = await mount(bot, () => store.state.bots.length ? createElement(ModelPickerControl, {
      bot: store.state.bots[0], accepted: store.state.acceptedSends["t-b1"], switchControl: control, onSwitching,
      store: { state: { instances, selectedId: "b1", pendingQueued: store.state.pendingQueued }, dispatch: store.dispatch, refreshInstances: async () => {} },
    }) : null);
    let picked!: (response: Response) => void;
    patch.mockImplementationOnce(() => new Promise<Response>((resolve) => { picked = resolve; }));
    const fetchBefore = fetch;
    let receipt!: (response: Response) => void;
    let stopped!: (response: Response) => void;
    const post = vi.fn(() => new Promise<Response>((resolve) => { receipt = resolve; }));
    const edit = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/messages") ? post()
      : url.endsWith("/interrupt") ? new Promise<Response>((resolve) => { stopped = resolve; })
      : url.endsWith("/edit") ? edit(url, init) : fetchBefore(url, init)));
    await act(async () => control.current!());
    await act(async () => store.dispatch({ type: "send", botId: "b1", text: "and this", sendId: "s2" }));
    expect(store.state.acceptedSends["t-b1"]).toEqual([expect.objectContaining({ sendId: "s2", kind: "sends-next" })]);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-model-cell="gpt-6.1-sol"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".model-cross-footer button")!.click());
    expect(picked).toBeTypeOf("function");
    expect(stopped).toBeUndefined();
    const message = { id: "u2", parentId: "u1", role: "user", kind: "text", text: "and this", at: 2, sendId: "s2" };
    if (followUp === "steered") {
      await act(async () => receipt(Response.json({ ok: true, steered: true, threadId: "t-b1", message: { ...message, steered: true } })));
      expect(store.state.acceptedSends["t-b1"]).toBeUndefined();
    }
    const selection = { instanceId: "codex", model: "gpt-6.1-sol", mode: "pinned" };
    await act(async () => picked(Response.json({ bot: { ...bot, pendingModelSelection: selection } })));
    if (followUp === "queued" || followUp === "returned") {
      await act(async () => receipt(Response.json({ ok: true, queued: true, queueId: "q2", threadId: "t-b1" })));
      expect(store.state.acceptedSends["t-b1"]).toBeUndefined();
      expect(store.state.pendingQueued["t-b1"]).toEqual([expect.objectContaining({ queueId: "q2", sendId: "s2" })]);
    }
    const returned = followUp === "returned" ? [{ threadId: "t-b1", queueId: "q2", sendId: "s2", text: "and this" }] : [];
    await act(async () => stopped(Response.json({ ok: true, stopped: true, returned })));
    if (followUp === "steered") {
      expect(edit).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(edit.mock.calls[0][1]?.body))).toEqual({ text: "hello", expectedSelection: selection });
      expect(edit.mock.calls[0][0]).toBe("/api/bots/b1/messages/u1/edit");
    } else {
      expect(edit).not.toHaveBeenCalled();
      if (followUp === "posting") await act(async () => receipt(Response.json({ ok: true, threadId: "t-b1", message })));
      if (followUp !== "returned") {
        await act(async () => {
          FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "bot", bot: { ...bot, modelSelection: selection, pendingModelSelection: null } }), lastEventId: "" });
          FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "message", threadId: "t-b1", message: { ...message, queueId: "q2" } }), lastEventId: "" });
        });
        expect(store.state.bots[0].modelSelection).toEqual(selection);
        expect(store.state.bots[0].messages.filter((entry) => entry.sendId === "s2")).toHaveLength(1);
      }
      expect(store.state.pendingQueued["t-b1"]).toBeUndefined();
    }
    expect(post).toHaveBeenCalledTimes(1);
    expect(onSwitching.mock.calls.map(([stage]) => stage)).toEqual(["saving", followUp === "steered" ? "rerunning" : null]);
    expect(store.state.error).toBeNull();
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
