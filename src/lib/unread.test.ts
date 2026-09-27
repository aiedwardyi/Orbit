import { describe, expect, it } from "vitest";

import { collapsedUnreadCount, formatCollapsedUnreadBadge, unreadConversationCount } from "./unread";

describe("unreadConversationCount", () => {
  it("counts visible bot and room conversations but ignores archived bots", () => {
    expect(
      unreadConversationCount(
        [{ unread: true }, { unread: false }, { unread: true, hidden: true }],
        [{ unread: true }, { unread: false }],
      ),
    ).toBe(2);
  });
});

describe("collapsedUnreadCount", () => {
  it("excludes the currently open bot or room from the count", () => {
    const bots = [
      { id: "a", unread: true },
      { id: "b", unread: true },
      { id: "c", unread: false },
    ];
    const groups = [{ id: "g1", unread: true }];
    expect(collapsedUnreadCount(bots, groups, "a")).toBe(2);
    expect(collapsedUnreadCount(bots, groups, "g1")).toBe(2);
    expect(collapsedUnreadCount(bots, groups, "none")).toBe(3);
  });

  it("ignores hidden bots, same as unreadConversationCount", () => {
    expect(collapsedUnreadCount([{ id: "a", unread: true, hidden: true }], [], "none")).toBe(0);
  });
});

describe("formatCollapsedUnreadBadge", () => {
  it("hides at zero, caps at 9+, and passes lower counts through", () => {
    expect(formatCollapsedUnreadBadge(0)).toBeNull();
    expect(formatCollapsedUnreadBadge(1)).toBe("1");
    expect(formatCollapsedUnreadBadge(9)).toBe("9");
    expect(formatCollapsedUnreadBadge(10)).toBe("9+");
    expect(formatCollapsedUnreadBadge(42)).toBe("9+");
  });
});
