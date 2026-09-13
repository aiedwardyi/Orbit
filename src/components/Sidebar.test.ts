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
      expect(rowButtons()[0]!.getAttribute("aria-keyshortcuts")).toContain("Alt+ArrowUp");
      // Alt+Up on the middle row moves it before the first row, keeping focus.
      const moved = rowButtons()[1]! as HTMLElement;
      moved.focus();
      await act(async () => key(moved, "ArrowUp"));
      await vi.waitFor(() => expect(order()[0]).toContain("b"));
      expect(order()[1]).toContain("a");
      expect(document.activeElement?.textContent).toContain("b");
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

  it("ignores Alt+Arrow when Ctrl, Meta, or Shift is also pressed", async () => {
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
    const chord = (target: Element, keyName: string, mods: object) => {
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: keyName, altKey: true, ...mods }));
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
      await act(async () => chord(rowButtons()[1]!, "ArrowUp", { ctrlKey: true }));
      await act(async () => chord(rowButtons()[1]!, "ArrowDown", { metaKey: true }));
      await act(async () => chord(rowButtons()[1]!, "ArrowUp", { shiftKey: true }));
      expect(order()[0]).toContain("a");
      expect(order()[1]).toContain("b");
      expect(order()[2]).toContain("c");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("moves to the adjacent visible bot when a filter hides the middle", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/bots") return new Response(JSON.stringify({ bots: ["ax", "bx", "ax2"].map(bot), groups: [] }));
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
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(rows()).toHaveLength(3));
      const search = host.querySelector("input")!;
      await act(async () => {
        (search as HTMLInputElement).focus();
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        nativeSetter.call(search, "ax");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await vi.waitFor(() => expect(rows()).toHaveLength(2));
      expect(order()[0]).toContain("ax");
      // Alt+Down skips the filtered-out middle and lands after the visible neighbor.
      await act(async () => {
        rowButtons()[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown", altKey: true }));
      });
      await vi.waitFor(() => expect(order()[0]).toContain("ax2"));
      expect(order()[1]).toContain("ax");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("declares the shortcut only where the keys work", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const chief = { ...bot("chief"), chiefOfStaff: true };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/bots") return new Response(JSON.stringify({ bots: [chief, ...["a", "b"].map(bot)], groups: [] }));
      if (url === "/api/bots/order") return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(host.querySelectorAll('[draggable="true"] > [role="button"]')).toHaveLength(2));
      const movable = host.querySelectorAll('[draggable="true"] > [role="button"]');
      expect(movable[0]!.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
      const allButtons = Array.from(host.querySelectorAll('[role="button"]'));
      const chiefButton = allButtons.find((el) => (el.textContent ?? "").includes("chief") && el.getAttribute("aria-keyshortcuts") === null);
      expect(chiefButton).toBeTruthy();
      const chiefWithShortcut = allButtons.filter((el) => (el.textContent ?? "").includes("chief") && el.getAttribute("aria-keyshortcuts") !== null);
      expect(chiefWithShortcut).toHaveLength(0);
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
