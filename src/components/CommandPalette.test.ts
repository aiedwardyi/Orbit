// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "@/state/store";

import { CommandPalette } from "./CommandPalette";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CommandPalette rooms", () => {
  it("offers a normal room but not a bot-to-bot channel", async () => {
    const room = (id: string, name: string, dm?: boolean) => ({ id, threadId: `${id}-thread`, name, memberIds: [], messages: [], dm });
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/bots?messages=200"
          ? new Response(JSON.stringify({ bots: [], groups: [room("dm-1", "Career and Wink", true), room("room-1", "Launch room")] }))
          : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(CommandPalette, {}))));
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
      });
      await vi.waitFor(() => expect(host.textContent).toContain("Launch room"));
      expect(host.textContent).not.toContain("Career and Wink");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
