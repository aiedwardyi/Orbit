import { describe, expect, it } from "vitest";

import {
  moveSidebarItem,
  normalizeSidebarOrder,
  orderedSidebarItems,
  sameSidebarOrder,
  sidebarItemKey,
  UNASSIGNED_SECTION_ID,
} from "./sidebar-order";

describe("sidebar item order", () => {
  it("deduplicates stale saved rows and appends new rows in source order", () => {
    expect(orderedSidebarItems(["group:g1", "bot:b1", "bot:b2"], ["bot:gone", "bot:b2", "bot:b2"])).toEqual([
      "bot:b2",
      "group:g1",
      "bot:b1",
    ]);
  });

  it("normalizes new and deleted sections without losing mixed rows", () => {
    expect(normalizeSidebarOrder(
      {
        sectionOrder: ["section:gone", UNASSIGNED_SECTION_ID, "section:Work", UNASSIGNED_SECTION_ID],
      itemOrder: {
        [UNASSIGNED_SECTION_ID]: ["bot:gone", "group:g1", "group:g1"],
          "section:Work": ["bot:b1"],
        },
      },
      [UNASSIGNED_SECTION_ID, "section:Work", "section:New"],
      {
        [UNASSIGNED_SECTION_ID]: ["bot:b1", "group:g1"],
        "section:Work": ["group:g2", "bot:b2"],
        "section:New": ["bot:b3"],
      },
    )).toEqual({
      sectionOrder: [UNASSIGNED_SECTION_ID, "section:Work", "section:New"],
      itemOrder: {
        [UNASSIGNED_SECTION_ID]: ["group:g1", "bot:b1"],
        "section:Work": ["group:g2", "bot:b2"],
        "section:New": ["bot:b3"],
      },
    });
  });

  it("moves a bot or group across sections and keeps the target row slot", () => {
    const order = {
      [UNASSIGNED_SECTION_ID]: [sidebarItemKey("group", "g1"), sidebarItemKey("bot", "b1")],
      "section:Work": [sidebarItemKey("bot", "b2"), sidebarItemKey("group", "g2")],
    };
    expect(moveSidebarItem(order, UNASSIGNED_SECTION_ID, "section:Work", "group:g1", "group:g2")).toEqual({
      [UNASSIGNED_SECTION_ID]: ["bot:b1"],
      "section:Work": ["bot:b2", "group:g1", "group:g2"],
    });
    expect(moveSidebarItem(order, "section:Work", UNASSIGNED_SECTION_ID, "bot:b2", undefined, "end")).toEqual({
      [UNASSIGNED_SECTION_ID]: ["group:g1", "bot:b1", "bot:b2"],
      "section:Work": ["group:g2"],
    });
  });

  it("removes duplicate copies of a rapidly moved item before inserting it", () => {
    const next = moveSidebarItem(
      { [UNASSIGNED_SECTION_ID]: ["bot:b1", "bot:b1"], "section:Work": ["group:g1"] },
      UNASSIGNED_SECTION_ID,
      "section:Work",
      "bot:b1",
      "group:g1",
    );
    expect(next).toEqual({ [UNASSIGNED_SECTION_ID]: [], "section:Work": ["bot:b1", "group:g1"] });
    expect(sameSidebarOrder({ sectionOrder: [], itemOrder: next }, { sectionOrder: [], itemOrder: next })).toBe(true);
  });
});
