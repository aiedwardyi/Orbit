import { describe, expect, it } from "vitest";

import { findHitIndex, findSeedFor, highlightParts } from "./chat-find";

describe("highlightParts", () => {
  it("marks every copy of the query", () => {
    const parts = highlightParts("최세훈 그리고 나중에도 최세훈", "최세훈");
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(["최세훈", "최세훈"]);
  });

  it("marks only the exact phrase, like the search count", () => {
    expect(highlightParts("foo then bar", "foo bar")).toEqual([{ text: "foo then bar", match: false }]);
    const parts = highlightParts("say Foo Bar", "foo bar");
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(["Foo Bar"]);
  });

  it("keeps offsets on the original text when lowercasing changes length", () => {
    expect(highlightParts("İabc", "abc")).toEqual([{ text: "İ", match: false }, { text: "abc", match: true }]);
  });

  it("leaves a snippet unmarked when the words are absent", () => {
    expect(highlightParts("targets-by-id", "최세훈")).toEqual([{ text: "targets-by-id", match: false }]);
  });
});

describe("findHitIndex", () => {
  const hits = [{ messageId: "a" }, { messageId: "b" }];

  it("starts at the clicked message", () => {
    expect(findHitIndex(hits, "b")).toBe(1);
  });

  it("starts at the first hit when find was opened on its own", () => {
    expect(findHitIndex(hits, null)).toBe(0);
  });

  it("does not jump away when the clicked row is missing", () => {
    expect(findHitIndex(hits, "missing")).toBeNull();
  });
});

describe("findSeedFor", () => {
  const focus = { threadId: "t", messageId: "m", nonce: 2, consumed: false, query: "최세훈" };

  it("opens find for a fresh sidebar landing", () => {
    expect(findSeedFor(focus, "t")).toEqual({ query: "최세훈", messageId: "m", nonce: 2 });
  });

  it("keeps find closed when returning after the landing was shown", () => {
    expect(findSeedFor({ ...focus, consumed: true }, "t")).toBeNull();
  });

  it("ignores other chats and jumps without a query", () => {
    expect(findSeedFor(focus, "other")).toBeNull();
    expect(findSeedFor({ ...focus, query: undefined }, "t")).toBeNull();
  });
});
