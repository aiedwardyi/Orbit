import { describe, expect, it } from "vitest";

import { collapsedUnreadCount, formatCollapsedUnreadBadge, markUnreadReadAt, unreadConversationCount, unreadReplyCount } from "./unread";

describe("unreadConversationCount", () => {
  it("counts visible bot and room conversations but ignores archived bots", () => {
    expect(
      unreadConversationCount(
        [{ unread: true }, { unread: false }, { unread: true, hidden: true }],
        [{ unread: true }, { unread: false }],
      ),
    ).toBe(2);
  });

  it("ignores bot-to-bot channels but still counts normal rooms", () => {
    expect(unreadConversationCount([], [{ dm: true, unread: true }, { unread: true }])).toBe(1);
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

  it("ignores bot-to-bot channels", () => {
    const groups = [{ id: "dm", dm: true, unread: true }, { id: "g1", unread: true }];
    expect(collapsedUnreadCount([], groups, "none")).toBe(1);
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

describe("unreadReplyCount", () => {
  const reply = (at: number) => ({ role: "bot", kind: "text", at });
  const mine = (at: number) => ({ role: "user", kind: "text", at });

  it("counts shown text replies since the chat was last read", () => {
    const read = [mine(5), reply(10), reply(11), reply(12)];
    expect(unreadReplyCount(true, 20, [...read, reply(30), { role: "bot", kind: "activity", at: 31 }, { ...reply(32), summarized: true }, reply(33)])).toBe(2);
  });

  it("counts 1 after Mark as Unread", () => {
    const messages = [mine(5), reply(10), reply(11), reply(12), { role: "bot", kind: "activity", at: 13 }];
    expect(markUnreadReadAt(messages)).toBe(11);
    expect(unreadReplyCount(true, markUnreadReadAt(messages), messages)).toBe(1);
    expect(markUnreadReadAt([mine(5)])).toBeUndefined();
  });

  it("keeps counting past a message without a timestamp", () => {
    expect(unreadReplyCount(true, 5, [reply(10), { role: "bot", kind: "activity" }, reply(12)])).toBe(2);
    expect(unreadReplyCount(true, 5, [reply(10), { role: "bot", kind: "text" }, reply(12)])).toBe(3);
  });

  it("counts after your last message for a record without readAt", () => {
    expect(unreadReplyCount(true, undefined, [reply(1), mine(5), reply(10), reply(11)])).toBe(2);
  });

  it("is 0 for a read chat and at least 1 for an unread one", () => {
    expect(unreadReplyCount(false, 0, [mine(5), reply(10), reply(11)])).toBe(0);
    expect(unreadReplyCount(true, 20, [reply(10), mine(15)])).toBe(1);
    expect(unreadReplyCount(true, undefined, [])).toBe(1);
  });
});
