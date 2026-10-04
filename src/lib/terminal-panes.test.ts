// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Action } from "@/state/store";

import { useTerminalPanes } from "./terminal-panes";

function Probe({ dispatch }: { dispatch: (action: Action) => void }) {
  useTerminalPanes(dispatch);
  return null;
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

  it("stays idle without the desktop bridge", async () => {
    const dispatch = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe, { dispatch })));
    await act(async () => root.unmount());
    host.remove();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
