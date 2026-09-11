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
    expect(botOrderAfterDrop(bots, "a", "c")).toEqual(["chief", "pinned", "b", "work", "c", "a"]);
    expect(botOrderAfterDrop(bots, "c", "a")).toEqual(["chief", "c", "a", "pinned", "b", "work"]);
    expect(botOrderAfterDrop(bots, "a", "b")).toEqual(["chief", "pinned", "b", "a", "work", "c"]);
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

  it("ignores a drop onto itself or an unknown bot", () => {
    expect(botOrderAfterDrop(bots, "a", "a")).toBeNull();
    expect(botOrderAfterDrop(bots, "a", "gone")).toBeNull();
  });
});
