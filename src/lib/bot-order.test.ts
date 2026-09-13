import { describe, expect, it } from "vitest";

import { botOrderAfterDrop, botOrderAfterKeyboardMove, botOrderAfterVisibleKeyboardMove } from "./bot-order";

const bots = [
  { id: "chief", chiefOfStaff: true },
  { id: "a" },
  { id: "pinned", pinned: true },
  { id: "b" },
  { id: "work", section: "Work" },
  { id: "c" },
];

describe("botOrderAfterDrop", () => {
  it("moves a bot into the dropped row's slot, in either direction", () => {
    expect(botOrderAfterDrop(bots, "a", "c")).toEqual(["chief", "b", "pinned", "c", "work", "a"]);
    expect(botOrderAfterDrop(bots, "c", "a")).toEqual(["chief", "c", "pinned", "a", "work", "b"]);
    expect(botOrderAfterDrop(bots, "a", "b")).toEqual(["chief", "b", "pinned", "a", "work", "c"]);
  });

  it("keeps every other bot in its slot, so a section never jumps past another", () => {
    const interleaved = [{ id: "a1", section: "A" }, { id: "b1", section: "B" }, { id: "a2", section: "A" }];
    expect(botOrderAfterDrop(interleaved, "a1", "a2")).toEqual(["a2", "b1", "a1"]);
  });

  it("refuses drops the pinned-first sort or sections would snap back", () => {
    expect(botOrderAfterDrop(bots, "a", "pinned")).toBeNull();
    expect(botOrderAfterDrop(bots, "a", "work")).toBeNull();
    expect(botOrderAfterDrop([...bots, { id: "home", section: "Home" }], "work", "home")).toBeNull();
  });

  it("never moves a Chief of Staff or drops onto one", () => {
    expect(botOrderAfterDrop(bots, "chief", "a")).toBeNull();
    expect(botOrderAfterDrop(bots, "a", "chief")).toBeNull();
  });

  it("keeps an archived bot in its slot and never drops onto or from one", () => {
    const withArchived = [{ id: "a" }, { id: "b", hidden: true }, { id: "c" }];
    expect(botOrderAfterDrop(withArchived, "a", "c")).toEqual(["c", "b", "a"]);
    expect(botOrderAfterDrop(withArchived, "a", "b")).toBeNull();
    expect(botOrderAfterDrop(withArchived, "b", "c")).toBeNull();
  });

  it("ignores a drop onto itself or an unknown bot", () => {
    expect(botOrderAfterDrop(bots, "a", "a")).toBeNull();
    expect(botOrderAfterDrop(bots, "a", "gone")).toBeNull();
  });
});

describe("botOrderAfterKeyboardMove", () => {
  it("moves the focused bot one slot up or down within its group", () => {
    expect(botOrderAfterKeyboardMove(bots, "b", -1)).toEqual(["chief", "b", "pinned", "a", "work", "c"]);
    expect(botOrderAfterKeyboardMove(bots, "b", 1)).toEqual(["chief", "a", "pinned", "c", "work", "b"]);
  });

  it("is a no-op at group edges", () => {
    expect(botOrderAfterKeyboardMove(bots, "a", -1)).toBeNull();
    expect(botOrderAfterKeyboardMove(bots, "c", 1)).toBeNull();
  });

  it("keeps pinned and unpinned bots in separate groups", () => {
    const pinned = [{ id: "p1", pinned: true }, { id: "p2", pinned: true }, { id: "u1" }];
    expect(botOrderAfterKeyboardMove(pinned, "p1", 1)).toEqual(["p2", "p1", "u1"]);
    expect(botOrderAfterKeyboardMove(pinned, "p2", 1)).toBeNull();
    expect(botOrderAfterKeyboardMove(pinned, "u1", -1)).toBeNull();
    expect(botOrderAfterKeyboardMove(pinned, "p1", -1)).toBeNull();
  });

  it("keeps sections separate", () => {
    const sectioned = [{ id: "a1", section: "A" }, { id: "b1", section: "B" }, { id: "a2", section: "A" }];
    expect(botOrderAfterKeyboardMove(sectioned, "a1", 1)).toEqual(["a2", "b1", "a1"]);
    expect(botOrderAfterKeyboardMove(sectioned, "b1", 1)).toBeNull();
  });

  it("never moves a Chief of Staff or hidden bot", () => {
    expect(botOrderAfterKeyboardMove(bots, "chief", 1)).toBeNull();
    expect(botOrderAfterKeyboardMove(bots, "chief", -1)).toBeNull();
    const withHidden = [{ id: "a" }, { id: "b", hidden: true }, { id: "c" }];
    expect(botOrderAfterKeyboardMove(withHidden, "b", 1)).toBeNull();
    expect(botOrderAfterKeyboardMove(withHidden, "b", -1)).toBeNull();
    expect(botOrderAfterKeyboardMove(withHidden, "a", 1)).toEqual(["c", "b", "a"]);
  });
});

describe("botOrderAfterVisibleKeyboardMove", () => {
  it("moves to the adjacent visible bot, skipping filtered-out middles", () => {
    const full = [{ id: "ax" }, { id: "bx" }, { id: "ax2" }];
    const visible = [{ id: "ax" }, { id: "ax2" }];
    expect(botOrderAfterVisibleKeyboardMove(full, visible, "ax", 1)).toEqual(["bx", "ax2", "ax"]);
    expect(botOrderAfterVisibleKeyboardMove(full, visible, "ax2", -1)).toEqual(["ax2", "ax", "bx"]);
  });

  it("is a no-op at visible edges even when hidden bots sit beyond", () => {
    const full = [{ id: "ax" }, { id: "bx" }, { id: "ax2" }];
    const visible = [{ id: "ax" }, { id: "ax2" }];
    expect(botOrderAfterVisibleKeyboardMove(full, visible, "ax", -1)).toBeNull();
    expect(botOrderAfterVisibleKeyboardMove(full, visible, "ax2", 1)).toBeNull();
  });
});
