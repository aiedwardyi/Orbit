// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "@/state/store";

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
