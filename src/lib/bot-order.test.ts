import { describe, expect, it } from "vitest";

import {
  botOrderAfterCrossSectionDrop,
  botOrderAfterDrop,
  botOrderAfterSectionDrop,
  groupOrderAfterDrop,
} from "./bot-order";

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

  it("moves a bot into another section while keeping that section's slots together", () => {
    const sectioned = [
      { id: "a", section: "A" },
      { id: "b", section: "B" },
      { id: "c", section: "B" },
      { id: "d", section: "A" },
    ];
    expect(botOrderAfterSectionDrop(sectioned, "a", "B")).toEqual(["b", "c", "a", "d"]);
    expect(botOrderAfterSectionDrop(sectioned, "c", "A")).toEqual(["a", "b", "d", "c"]);
    expect(botOrderAfterSectionDrop(sectioned, "d", "A")).toBeNull();
  });

  it("accepts a cross-section row drop and rejects chiefs or archived bots", () => {
    const sectioned = [
      { id: "a", section: "A" },
      { id: "b", section: "B" },
      { id: "c", section: "B" },
      { id: "d", section: "A" },
    ];
    expect(botOrderAfterCrossSectionDrop(sectioned, "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(botOrderAfterCrossSectionDrop(sectioned, "c", "a")).toEqual(["c", "a", "b", "d"]);
    expect(botOrderAfterCrossSectionDrop([{ id: "chief", chiefOfStaff: true }, ...sectioned], "chief", "b")).toBeNull();
    expect(botOrderAfterCrossSectionDrop([{ id: "archived", hidden: true, section: "A" }, ...sectioned], "archived", "b")).toBeNull();
  });
});

const groups = [
  { id: "r1" },
  { id: "r2" },
  { id: "w1", section: "Work" },
  { id: "r3" },
];

describe("groupOrderAfterDrop", () => {
  it("moves a group into the dropped row's slot, in either direction", () => {
    expect(groupOrderAfterDrop(groups, "r1", "r3")).toEqual(["r2", "r3", "w1", "r1"]);
    expect(groupOrderAfterDrop(groups, "r3", "r1")).toEqual(["r3", "r1", "w1", "r2"]);
    expect(groupOrderAfterDrop(groups, "r1", "r2")).toEqual(["r2", "r1", "w1", "r3"]);
  });

  it("moves within a section and keeps every other group in its slot", () => {
    const sectioned = [
      { id: "w1", section: "Work" },
      { id: "h1", section: "Home" },
      { id: "w2", section: "Work" },
    ];
    expect(groupOrderAfterDrop(sectioned, "w1", "w2")).toEqual(["w2", "h1", "w1"]);
  });

  it("refuses drops across sections, like single chats do", () => {
    expect(groupOrderAfterDrop(groups, "r1", "w1")).toBeNull();
    expect(groupOrderAfterDrop(groups, "w1", "r1")).toBeNull();
    expect(groupOrderAfterDrop([...groups, { id: "h1", section: "Home" }], "w1", "h1")).toBeNull();
  });

  it("ignores a drop onto itself or an unknown group", () => {
    expect(groupOrderAfterDrop(groups, "r1", "r1")).toBeNull();
    expect(groupOrderAfterDrop(groups, "r1", "gone")).toBeNull();
  });
});
