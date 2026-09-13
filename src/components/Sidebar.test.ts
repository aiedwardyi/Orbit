// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { persistPreference } from "@/lib/i18n";
import { formatTime, StoreProvider } from "@/state/store";

import { Sidebar } from "./Sidebar";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

const bot = (id: string) => ({ id, threadId: `${id}-thread`, name: id, messages: [] });

// happy-dom drag events carry no dataTransfer, and the row handlers write to it.
const fire = (target: Element, type: string) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData: () => {} } });
  target.dispatchEvent(event);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sidebar drag to reorder", () => {
  it("never revives a drag when a dragover lands after its dragend", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (path: string) =>
      path === "/api/bots"
        ? new Response(JSON.stringify({ bots: ["a", "b", "c"].map(bot), groups: [] }))
        : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const rows = () => host.querySelectorAll('[draggable="true"]');
    const dropLine = () => host.querySelector('[class~="h-0.5"]');
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(rows()).toHaveLength(3));
      const [a, b, c] = rows();
      await act(async () => fire(a!, "dragstart"));
      await act(async () => fire(c!, "dragover"));
      expect(dropLine()).not.toBeNull();
      await act(async () => {
        fire(a!, "dragend");
        fire(b!, "dragover");
      });
      expect(dropLine()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar keyboard reorder", () => {
  it("moves the focused row with Alt+Arrow and keeps drag working", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/bots") return new Response(JSON.stringify({ bots: ["a", "b", "c"].map(bot), groups: [] }));
      if (url === "/api/bots/order") return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const rows = () => host.querySelectorAll('[draggable="true"]');
    const order = () => Array.from(rows()).map((row) => row.textContent ?? "");
    const rowButtons = () => host.querySelectorAll('[draggable="true"] > [role="button"]');
    const key = (target: Element, keyName: string) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: keyName, altKey: true });
      target.dispatchEvent(event);
    };
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(rows()).toHaveLength(3));
      expect(order()[0]).toContain("a");
      expect(order()[1]).toContain("b");
      // Alt+Up on the middle row moves it before the first row.
      await act(async () => key(rowButtons()[1]!, "ArrowUp"));
      await vi.waitFor(() => expect(order()[0]).toContain("b"));
      expect(order()[1]).toContain("a");
      // Alt+Down moves it back after the second row.
      await act(async () => key(rowButtons()[0]!, "ArrowDown"));
      await vi.waitFor(() => expect(order()[0]).toContain("a"));
      expect(order()[1]).toContain("b");
      // Alt+Up at the top edge is a no-op.
      await act(async () => key(rowButtons()[0]!, "ArrowUp"));
      expect(order()[0]).toContain("a");
      // Drag still reorders after keyboard moves.
      await act(async () => fire(rows()[0]!, "dragstart"));
      await act(async () => fire(rows()[2]!, "dragover"));
      await act(async () => fire(rows()[2]!, "drop"));
      await vi.waitFor(() => expect(order()[2]).toContain("a"));
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar row time", () => {
  it.each(["en", "ko"] as const)("follows the %s UI language like the chat", async (locale) => {
    const at = Date.UTC(2026, 8, 12, 16, 36);
    const a = { ...bot("a"), messages: [{ id: "m", role: "bot", kind: "text", text: "hi", at }], activeLeafId: "m" };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (path: string) =>
      new Response(JSON.stringify(path === "/api/bots" ? { bots: [a], groups: [] } : {}), { status: path === "/api/bots" ? 200 : 404 })));
    persistPreference(locale);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))));
      await act(async () => FakeEventSource.current!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }), lastEventId: "" }));
      await vi.waitFor(() => expect(host.textContent).toContain(formatTime(at, locale)));
    } finally {
      persistPreference("en");
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
