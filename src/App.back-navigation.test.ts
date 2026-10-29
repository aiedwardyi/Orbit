// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { useStore } from "@/state/store";

const store = vi.hoisted(() => ({ dispatch: null as ReturnType<typeof useStore>["dispatch"] | null }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return { ...actual, useStore: () => {
    const value = actual.useStore();
    store.dispatch = value.dispatch;
    return value;
  } };
});

import App from "./App";

describe("Back with no bots", () => {
  it.each(["create-bot", "popup"])("closes %s before leaving the page", async (layer) => {
    localStorage.setItem("omb-onboarding-done", "true");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    const push = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    const close = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(App)));
      await act(async () => {
        store.dispatch!({ type: "instances", instances: [{
          instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
          snapshot: { state: "unavailable" }, models: { default: "default", options: [] },
        }] });
        store.dispatch!({ type: "connected", value: true });
        store.dispatch!({ type: "hydrate", bots: [], groups: [], computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } });
      });
      await act(async () => {
        if (layer === "create-bot") store.dispatch!({ type: "newBot" });
        else window.dispatchEvent(new CustomEvent("orbit:back-layer", { detail: { key: "popup:test", close } }));
      });
      if (layer === "create-bot") {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        await vi.waitFor(() => expect(host.textContent).toContain("No engine is connected yet."));
      }
      expect(push).toHaveBeenLastCalledWith({ orbitBack: layer === "create-bot" ? "create-bot" : "popup:test", depth: 1 }, "");
      await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state: null })));
      if (layer === "popup") expect(close).toHaveBeenCalledOnce();
      else {
        push.mockClear();
        await act(async () => store.dispatch!({ type: "newBot" }));
        expect(push).toHaveBeenCalledOnce();
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
      store.dispatch = null;
    }
  });
});
