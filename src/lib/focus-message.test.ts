import { describe, expect, it, vi } from "vitest";

import { landOnSearchHit, restoreChatChrome, scrollElementIntoContainer } from "./focus-message";
import type { SearchHit } from "./search-hit";

function box(top: number, height: number, scrollTop = 0) {
  return {
    scrollTop,
    getBoundingClientRect: () => ({
      top,
      height,
      bottom: top + height,
      left: 0,
      width: 400,
      right: 400,
    }),
  };
}

describe("scrollElementIntoContainer", () => {
  it("scrolls only the transcript container, never the window", () => {
    const container = box(80, 400, 20);
    const target = box(500, 40);
    scrollElementIntoContainer(container, target);
    // Target center is 520; container center is 280; delta 240 → scrollTop 260
    expect(container.scrollTop).toBe(260);
  });

  it("does not move the window scroll position", () => {
    const windowLike = { scrollX: 0, scrollY: 48, scrollTo(x: number, y: number) {
      this.scrollX = x;
      this.scrollY = y;
    } };
    const previous = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowLike });
    try {
      const container = box(80, 400, 0);
      scrollElementIntoContainer(container, box(200, 40));
      expect(windowLike.scrollY).toBe(48);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previous });
    }
  });
});

describe("restoreChatChrome", () => {
  it("pins the window back to the top-left after find closes", () => {
    const calls: Array<[number, number]> = [];
    const windowLike = {
      scrollTo(x: number, y: number) {
        calls.push([x, y]);
      },
    };
    const documentLike = {
      documentElement: { scrollTop: 80 },
      body: { scrollTop: 80 },
    };
    restoreChatChrome(windowLike, documentLike);
    expect(calls).toEqual([[0, 0]]);
    expect(documentLike.documentElement.scrollTop).toBe(0);
    expect(documentLike.body.scrollTop).toBe(0);
  });
});

describe("landOnSearchHit", () => {
  it("carries the sidebar query so the chat can open find on that message", async () => {
    const hit: SearchHit = {
      botId: "b",
      name: "Bot",
      threadId: "t",
      messageId: "m",
      role: "user",
      kind: "text",
      at: 1,
      snippet: "최세훈",
      matchStart: 0,
      matchLength: 3,
      onActivePath: true,
    };
    const dispatch = vi.fn();
    await landOnSearchHit(hit, { bots: [{ id: "b", threadId: "t" }], groups: [] }, dispatch, "최세훈");
    expect(dispatch).toHaveBeenCalledWith({
      type: "focusMessage",
      threadId: "t",
      messageId: "m",
      query: "최세훈",
    });
  });
});
