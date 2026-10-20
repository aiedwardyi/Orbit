// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

const bot = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `${id}-thread`,
  name: id,
  messages: [],
  modelSelection: { instanceId: "muse", model: "muse-spark" },
  ...extra,
});

afterEach(() => {
  window.localStorage.removeItem("omb-onboarding-done");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountApp(bots: unknown[]) {
  window.localStorage.setItem("omb-onboarding-done", "true");
  const engine = {
    instanceId: "muse",
    driverKind: "museAgent",
    displayName: "Meta Muse",
    snapshot: { state: "available" },
    models: { default: "muse-spark", options: [{ id: "muse-spark", label: "Meta Muse" }] },
  };
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path === "/api/bots?messages=200") return new Response(JSON.stringify({ bots, groups: [] }));
    if (path === "/api/instances") return new Response(JSON.stringify({ instances: [engine] }));
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  await act(async () => FakeEventSource.current!.onmessage?.({
    data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
    lastEventId: "",
  }));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const sidebarMark = (host: HTMLElement, id: string) =>
  host.querySelector(`[data-sidebar-row-id="${id}"] [data-sidebar-keep-going]`);

describe("keep going mark", () => {
  it("marks the avatar solid when on, hollow when paused, and not at all when off", async () => {
    const { host, unmount } = await mountApp([
      bot("on", { keepGoing: { paused: null } }),
      bot("paused", { keepGoing: { paused: "no-progress" } }),
      bot("off", { keepGoing: null }),
    ]);
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="off"]')).not.toBeNull());
      expect(sidebarMark(host, "on")?.getAttribute("data-sidebar-keep-going")).toBe("on");
      expect(sidebarMark(host, "on")?.getAttribute("aria-label")).toBe("Keep going on");
      expect(sidebarMark(host, "on")?.querySelector("circle")).toBeNull();
      expect(sidebarMark(host, "paused")?.getAttribute("data-sidebar-keep-going")).toBe("paused");
      expect(sidebarMark(host, "paused")?.getAttribute("aria-label")).toBe("Keep going paused");
      expect(sidebarMark(host, "paused")?.querySelector("circle")?.getAttribute("fill")).toBe("none");
      expect(sidebarMark(host, "off")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("shows the header mark for the open bot and opens its Keep going setting", async () => {
    const { host, unmount } = await mountApp([bot("on", { keepGoing: { paused: null } })]);
    try {
      const mark = () => host.querySelector<HTMLButtonElement>("[data-chat-keep-going]");
      await vi.waitFor(() => expect(mark()).not.toBeNull());
      expect(mark()?.getAttribute("data-chat-keep-going")).toBe("on");
      expect(mark()?.getAttribute("aria-label")).toBe("Keep going on");
      expect(host.querySelector("[data-settings-keep-going]")).toBeNull();
      const scrolled: Element[] = [];
      vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
        scrolled.push(this);
      });
      await act(async () => mark()!.click());
      await vi.waitFor(() => expect(host.querySelector("[data-settings-keep-going]")).not.toBeNull());
      expect(scrolled).toContain(host.querySelector("[data-settings-keep-going]"));
      expect(host.querySelector('[data-settings-keep-going] [role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    } finally {
      await unmount();
    }
  });

  it("labels a paused header mark and drops it when off", async () => {
    const paused = await mountApp([bot("paused", { keepGoing: { paused: "bot-paused" } })]);
    try {
      await vi.waitFor(() => expect(paused.host.querySelector("[data-chat-keep-going]")).not.toBeNull());
      expect(paused.host.querySelector("[data-chat-keep-going]")?.getAttribute("aria-label")).toBe("Keep going paused");
    } finally {
      await paused.unmount();
    }
    const off = await mountApp([bot("off", { keepGoing: null })]);
    try {
      await vi.waitFor(() => expect(off.host.querySelector("[data-orbit-composer]")).not.toBeNull());
      expect(off.host.querySelector("[data-chat-keep-going]")).toBeNull();
    } finally {
      await off.unmount();
    }
  });
});
