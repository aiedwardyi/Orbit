// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findHitIndex,
  findSeedFor,
  highlightParts,
  paintChatFindHighlight,
  revealFindMatch,
  setFindCurrent,
} from "./chat-find";

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

describe("current find match", () => {
  class FakeHighlight {
    ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  let registry: Map<string, FakeHighlight>;

  const mount = (html: string) => {
    registry = new Map();
    vi.stubGlobal("Highlight", FakeHighlight);
    vi.stubGlobal("CSS", { escape: (value: string) => value, highlights: registry });
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.append(root);
    return root;
  };
  const marked = (name: string) => registry.get(name)?.ranges.map((range) => `${range.startContainer.parentElement?.id}:${range.startOffset}`) ?? [];

  afterEach(() => {
    setFindCurrent(null);
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("marks the first copy in the landed row strong and every other copy soft", () => {
    const root = mount('<div data-mid="a"><p id="a">one post</p></div><div data-mid="b"><p id="b">first post, second post</p></div>');
    setFindCurrent({ messageId: "b", query: "Post" });
    paintChatFindHighlight(root, "post");
    expect(marked("orbit-find-current")).toEqual(["b:6"]);
    expect(marked("orbit-find")).toEqual(["a:4", "b:19"]);
  });

  it("leaves every copy soft for a query other than the landed one", () => {
    const root = mount('<div data-mid="b"><p id="b">post</p></div>');
    setFindCurrent({ messageId: "b", query: "posts" });
    paintChatFindHighlight(root, "post");
    expect(registry.has("orbit-find-current")).toBe(false);
    expect(marked("orbit-find")).toEqual(["b:0"]);
  });

  it("marks a link whose address holds the phrase when its text does not", () => {
    const root = mount('<div data-mid="b"><p>See <a id="link" href="https://x.com/s/1?ref=post">the thread</a>.</p></div>');
    setFindCurrent({ messageId: "b", query: "post" });
    const range = paintChatFindHighlight(root, "post");
    expect(range?.toString()).toBe("the thread");
    expect(registry.get("orbit-find-current")?.ranges).toEqual([range]);
  });

  it("finds nothing to mark when the phrase never renders", () => {
    const root = mount('<div data-mid="b"><p>Here is the frame <img src="postcard.png"></p></div>');
    setFindCurrent({ messageId: "b", query: "post" });
    expect(revealFindMatch(root, "b")).toBeNull();
  });

  it("unclamps a one-line row while it holds the current match, then restores it", () => {
    const root = mount(
      '<div data-mid="b"><div id="chip" style="display:flex"><span id="name" style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">gh api replies -X POST</span></div></div>' +
        '<div data-mid="c"><p id="c">post</p></div>',
    );
    setFindCurrent({ messageId: "b", query: "post" });
    expect(revealFindMatch(root, "c")).toBeNull();
    const range = revealFindMatch(root, "b");
    expect(range?.toString()).toBe("POST");
    expect(root.querySelector("#name")?.hasAttribute("data-find-unclamp")).toBe(true);
    expect(root.querySelector("#chip")?.hasAttribute("data-find-unclamp")).toBe(false);
    setFindCurrent({ messageId: "c", query: "post" });
    expect(root.querySelector("#name")?.hasAttribute("data-find-unclamp")).toBe(false);
  });

  it("lifts a collapsed long message's height cap while its match is current", () => {
    const root = mount('<div data-mid="b"><div id="wall" style="max-height:160px;overflow:hidden">long wall, then post</div></div>');
    setFindCurrent({ messageId: "b", query: "post" });
    revealFindMatch(root, "b");
    expect(root.querySelector("#wall")?.hasAttribute("data-find-unclamp")).toBe(true);
  });
});
