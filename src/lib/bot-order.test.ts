import { describe, expect, it } from "vitest";

import { botOrderAfterDrop } from "./bot-order";

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
