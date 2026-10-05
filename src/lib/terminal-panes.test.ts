// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Action } from "@/state/store";

import { PANE_COUNT_REFRESH_MS, panesFromPayload, useTerminalPanes } from "./terminal-panes";

function Probe({ dispatch, terminalOpen = false }: { dispatch: (action: Action) => void; terminalOpen?: boolean }) {
  useTerminalPanes(dispatch, terminalOpen);
  return null;
}

type PaneCountBody = { counts?: Record<string, number>; panes?: Record<string, string[]> };

function jsonResponse(body: PaneCountBody, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("useTerminalPanes", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads open panes and reloads them when a pane opens, closes or exits", async () => {
    const listeners = new Map<string, () => void>();
    const listen = (name: string) => (cb: () => void) => {
      listeners.set(name, cb);
      return () => listeners.delete(name);
    };
    let reads = 0;
    const paneLabels = vi.fn(async () => ({ "bot-1": [`w${++reads}`] }));
    vi.stubGlobal("ogb", {
      platform: "win32",
      terminal: { paneLabels, onOpened: listen("opened"), onClosed: listen("closed"), onExit: listen("exit") },
    });
    const dispatch = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Probe, { dispatch })));
      expect(dispatch).toHaveBeenLastCalledWith({ type: "setTerminalPanes", panes: { "bot-1": ["w1"] } });
      for (const name of ["opened", "closed", "exit"]) await act(async () => listeners.get(name)!());
      expect(paneLabels).toHaveBeenCalledTimes(4);
      expect(dispatch).toHaveBeenLastCalledWith({ type: "setTerminalPanes", panes: { "bot-1": ["w4"] } });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
    expect(listeners.size).toBe(0);
  });

  it("keeps the newest pane count when an older read resolves last", async () => {
    const listeners = new Map<string, () => void>();
    const listen = (name: string) => (cb: () => void) => {
      listeners.set(name, cb);
      return () => listeners.delete(name);
    };
    const reads: ((panes: Record<string, string[]>) => void)[] = [];
    const paneLabels = vi.fn(() => new Promise<Record<string, string[]>>((resolve) => reads.push(resolve)));
    vi.stubGlobal("ogb", {
      platform: "win32",
      terminal: { paneLabels, onOpened: listen("opened"), onClosed: listen("closed"), onExit: listen("exit") },
    });
    const dispatch = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Probe, { dispatch })));
      await act(async () => listeners.get("opened")!());
      await act(async () => reads[1]!({ "bot-1": ["w1", "w2"] }));
      await act(async () => reads[0]!({}));
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenLastCalledWith({ type: "setTerminalPanes", panes: { "bot-1": ["w1", "w2"] } });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("does not dispatch when the host pane-count read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const dispatch = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe, { dispatch })));
    await act(async () => root.unmount());
    host.remove();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("loads the host's pane counts into the store without the desktop bridge", async () => {
    const fetchMock = vi.fn(async (_path: string) => jsonResponse({ counts: { "bot-1": 2 }, panes: { "bot-1": ["w1", "w2"] } }));
    vi.stubGlobal("fetch", fetchMock);
    const dispatch = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Probe, { dispatch, terminalOpen: false })));
      expect(dispatch).toHaveBeenLastCalledWith({ type: "setTerminalPanes", panes: { "bot-1": ["w1", "w2"] } });
      await act(async () => root.render(createElement(Probe, { dispatch, terminalOpen: true })));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.every(([path]) => path === "/api/terminal/pane-counts")).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps the newest pane-count read when an older one resolves last", async () => {
    const pending: Array<(body: PaneCountBody) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      pending.push((body) => resolve(jsonResponse(body)));
    })));
    const dispatch = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(Probe, { dispatch })));
      await act(async () => window.dispatchEvent(new Event("focus")));
      await act(async () => pending[1]!({ panes: { "bot-1": ["w1", "w2"] } }));
      await act(async () => pending[0]!({ panes: { "bot-1": ["stale"] } }));
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenLastCalledWith({ type: "setTerminalPanes", panes: { "bot-1": ["w1", "w2"] } });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("polls pane counts no faster than 15s, and only while the page is visible", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({ counts: { "bot-1": 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    const dispatch = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const visibility = document.visibilityState;
    try {
      await act(async () => root.render(createElement(Probe, { dispatch })));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(PANE_COUNT_REFRESH_MS - 1));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(panesFromPayload({ counts: { "bot-1": 1 } })).toEqual({ "bot-1": [""] });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      await act(async () => vi.advanceTimersByTimeAsync(PANE_COUNT_REFRESH_MS));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
      await act(async () => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  });
});
