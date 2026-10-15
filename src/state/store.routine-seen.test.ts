// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Action } from "./store";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.current = this;
  }
}

const run = {
  id: "ringer",
  routineId: "routine-ringer",
  routineName: "ringer",
  botId: "ringer",
  runOn: "maus",
  scheduledFor: 1,
  status: "completed",
  manual: false,
  sourceThreadId: "ringer-thread",
  createdAt: 1,
};

const box: { plugins: boolean; appSettings: boolean; runs: number; dispatch: ((action: Action) => void) | null } = {
  plugins: false,
  appSettings: false,
  runs: 0,
  dispatch: null,
};

function Probe() {
  const store = useStore();
  box.plugins = store.state.pluginsOpen;
  box.appSettings = store.state.appSettingsOpen;
  box.runs = store.state.routineRuns.length;
  box.dispatch = store.dispatch;
  return null;
}

function Cover({ kind, open }: { kind: "plugins" | "appSettings"; open: boolean }) {
  const { dispatch, state } = useStore();
  const current = kind === "plugins" ? state.pluginsOpen : state.appSettingsOpen;
  useEffect(() => {
    if (open === current) return;
    dispatch(kind === "plugins" ? { type: "togglePlugins", open } : { type: "toggleAppSettings", open });
  }, [current, dispatch, kind, open]);
  return null;
}

function Harness({ kind, open }: { kind: "plugins" | "appSettings"; open: boolean }) {
  return createElement(StoreProvider, null, createElement(Cover, { kind, open }), createElement(Probe));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  FakeEventSource.current = null;
  box.dispatch = null;
});

async function mount(kind: "plugins" | "appSettings") {
  const seen: string[] = [];
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    const url = String(path);
    if (url.includes("/seen")) seen.push(url);
    if (url.startsWith("/api/bots")) {
      return Response.json({ bots: [{ id: "ringer", threadId: "ringer-thread", name: "ringer", messages: [] }], groups: [] });
    }
    if (url.startsWith("/api/routines")) return Response.json({ routines: [], runs: [run] });
    if (url.startsWith("/api/webhooks")) return Response.json({ webhooks: [], attempts: [], ingress: null });
    if (url.startsWith("/api/instances")) return Response.json({ instances: [] });
    return Response.json({});
  }));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  let setOpen: (open: boolean) => void = () => {};
  function App() {
    const [open, set] = useState(true);
    setOpen = set;
    return createElement(Harness, { kind, open });
  }
  await act(async () => root.render(createElement(App)));
  await act(async () => FakeEventSource.current!.onmessage?.({
    data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
    lastEventId: "",
  }));
  await vi.waitFor(() => expect(box.runs).toBe(1));
  return {
    seen,
    covered: () => kind === "plugins" ? box.plugins : box.appSettings,
    close: () => act(async () => setOpen(false)),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("routine seen while a cover is open", () => {
  it.each(["plugins", "appSettings"] as const)("does not mark a run seen while %s covers the chat", async (kind) => {
    const view = await mount(kind);
    try {
      expect(view.covered()).toBe(true);
      expect(view.seen).toEqual([]);
      await view.close();
      await vi.waitFor(() => expect(view.seen).toEqual(["/api/routine-runs/ringer/seen"]));
    } finally {
      await view.unmount();
    }
  });
});
