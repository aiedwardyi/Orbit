// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { SNAPSHOT_CACHE_KEY } from "./state/snapshot-cache";

class FakeEventSource {
  onmessage = null;
  close = vi.fn();
}

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function boot() {
  localStorage.setItem("omb-onboarding-done", "true");
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", FakeEventSource);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return host;
}

describe("reload while the server is still answering", () => {
  it("paints the cached chat instead of the connecting screen", async () => {
    const bot = {
      id: "b1",
      threadId: "t1",
      name: "Scout",
      unread: false,
      color: "blue",
      messages: [{ id: "m1", at: 1, role: "bot", kind: "text", text: "cached reply" }],
      modelSelection: { instanceId: "inst", model: "m" },
    };
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ bots: [bot], groups: [], selectedId: "b1" }));
    const host = await boot();
    expect(host.textContent).not.toContain("Connecting");
    await vi.waitFor(() => expect(host.textContent).toContain("cached reply"));
  });

  it("shows the connecting screen on a first load with nothing cached", async () => {
    const host = await boot();
    expect(host.textContent).toContain("Connecting");
  });
});
