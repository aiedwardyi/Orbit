import { describe, expect, it } from "vitest";

import {
  listedGroups,
  listedSearchHits,
  moveSidebarItem,
  moveSidebarItemWithinTier,
  normalizeSidebarOrder,
  orderedSidebarItems,
  partitionSidebarItemKeys,
  preferredStartupSelectionId,
  sidebarPriorityFor,
  sameSidebarOrder,
  sidebarItemKey,
  UNASSIGNED_SECTION_ID,
} from "./sidebar-order";
import type { Message } from "@/state/store";

describe("sidebar item order", () => {
  it("partitions global priority tiers without duplicating both flags", () => {
    const partition = partitionSidebarItemKeys(
      ["section:Work", UNASSIGNED_SECTION_ID],
      {
        "section:Work": ["group:g1", "bot:chief", "bot:pinned", "bot:both"],
        [UNASSIGNED_SECTION_ID]: ["bot:regular", "bot:chief"],
      },
      {
        "bot:chief": "chief",
        "bot:pinned": "pinned",
        "bot:both": "chief",
      },
    );
    expect(partition.chief).toEqual(["bot:chief", "bot:both"]);
    expect(partition.pinned).toEqual(["bot:pinned"]);
    expect(partition.regular).toEqual({
      "section:Work": ["group:g1"],
      [UNASSIGNED_SECTION_ID]: ["bot:regular"],
    });
  });

  it("gives Chief of Staff precedence over a pin", () => {
    expect(sidebarPriorityFor({ chiefOfStaff: true, pinned: true })).toBe("chief");
    expect(sidebarPriorityFor({ pinned: true })).toBe("pinned");
    expect(sidebarPriorityFor({})).toBeNull();
  });

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

  it("reorders a priority tier while keeping regular row slots intact", () => {
    expect(moveSidebarItemWithinTier(
      { [UNASSIGNED_SECTION_ID]: ["bot:p1", "bot:regular", "bot:p2"] },
      UNASSIGNED_SECTION_ID,
      "bot:p1",
      "bot:p2",
      ["bot:p1", "bot:p2"],
      "after",
    )).toEqual({ [UNASSIGNED_SECTION_ID]: ["bot:p2", "bot:regular", "bot:p1"] });
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

describe("listedGroups", () => {
  it("drops bot-to-bot channels and keeps rooms in order", () => {
    const groups = [{ id: "r1" }, { id: "dm", dm: true }, { id: "r2", dm: false }];
    expect(listedGroups(groups).map((group) => group.id)).toEqual(["r1", "r2"]);
  });

  it("keeps a bot-to-bot channel listed while a card there waits on the person", () => {
    const approval: Message = {
      id: "approval",
      role: "bot",
      kind: "options",
      at: 1,
      card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" },
    };
    const answered: Message = { ...approval, card: { ...approval.card!, answered: "Allow" } };
    expect(listedGroups([{ id: "dm", dm: true, messages: [approval] }]).map((group) => group.id)).toEqual(["dm"]);
    expect(listedGroups([{ id: "dm", dm: true, messages: [answered] }])).toEqual([]);
  });

  it("lists a bot-to-bot channel once the person has posted there", () => {
    const sent: Message = { id: "m1", role: "user", kind: "text", at: 1, text: "hello" };
    const mirrored: Message = { id: "m2", role: "bot", kind: "text", at: 2, text: "hi", from: { botId: "wink", name: "Wink", color: "blue" } };
    const activity: Message = { id: "m3", role: "bot", kind: "activity", at: 3, text: "Read" };
    expect(listedGroups([{ id: "dm", dm: true, messages: [mirrored, sent] }]).map((group) => group.id)).toEqual(["dm"]);
    expect(listedGroups([{ id: "dm", dm: true, messages: [mirrored, activity] }])).toEqual([]);
  });
});

describe("listedSearchHits", () => {
  const sent: Message = { id: "m1", role: "user", kind: "text", at: 1, text: "hello" };
  const mirrored: Message = { id: "m2", role: "bot", kind: "text", at: 2, text: "hi", from: { botId: "wink", name: "Wink", color: "blue" } };
  const groups = [
    { id: "room" },
    { id: "hidden", dm: true, messages: [mirrored] },
    { id: "joined", dm: true, messages: [mirrored, sent] },
  ];

  it("drops hits inside a hidden bot-to-bot channel only", () => {
    const hits = [{ botId: "b1" }, { groupId: "room" }, { groupId: "hidden" }, { groupId: "joined" }, { groupId: "unknown" }];
    expect(listedSearchHits(hits, groups)).toEqual([{ botId: "b1" }, { groupId: "room" }, { groupId: "joined" }, { groupId: "unknown" }]);
  });
});

describe("preferredStartupSelectionId", () => {
  const EMPTY_ORDER = { sectionOrder: [], itemOrder: {} };

  it("skips a bot-to-bot channel that leads the saved order", () => {
    const order = {
      sectionOrder: [UNASSIGNED_SECTION_ID],
      itemOrder: { [UNASSIGNED_SECTION_ID]: ["group:dm", "bot:a"] },
    };
    expect(preferredStartupSelectionId([{ id: "a" }], [{ id: "dm", dm: true }], order)).toBe("a");
  });

  it("picks the chief of staff bot over server creation order", () => {
    const bots = [{ id: "b1" }, { id: "chief", chiefOfStaff: true }, { id: "b2" }];
    expect(preferredStartupSelectionId(bots, [], EMPTY_ORDER)).toBe("chief");
  });

  it("falls back to the first ordered item when there is no chief", () => {
    const bots = [{ id: "a" }, { id: "b" }];
    const order = {
      sectionOrder: [UNASSIGNED_SECTION_ID],
      itemOrder: { [UNASSIGNED_SECTION_ID]: ["bot:b", "bot:a"] },
    };
    expect(preferredStartupSelectionId(bots, [], order)).toBe("b");
  });

  it("falls back to a first ordered group when it leads a pinless, chiefless sidebar", () => {
    const bots = [{ id: "a" }];
    const groups = [{ id: "g1" }];
    const order = {
      sectionOrder: [UNASSIGNED_SECTION_ID],
      itemOrder: { [UNASSIGNED_SECTION_ID]: ["group:g1", "bot:a"] },
    };
    expect(preferredStartupSelectionId(bots, groups, order)).toBe("g1");
  });

  it("falls back to bots[0] with no saved order and no chief", () => {
    const bots = [{ id: "a" }, { id: "b" }];
    expect(preferredStartupSelectionId(bots, [], EMPTY_ORDER)).toBe("a");
  });

  it("skips hidden bots when picking the first item", () => {
    const bots = [{ id: "a", hidden: true }, { id: "b" }];
    expect(preferredStartupSelectionId(bots, [], EMPTY_ORDER)).toBe("b");
  });
});
