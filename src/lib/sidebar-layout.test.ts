import { describe, expect, it } from "vitest";

import {
  mergeSectionOrder,
  moveSection,
  orderedSidebarSections,
  placeSection,
  sameSectionOrder,
  userSectionId,
  userSectionName,
} from "./sidebar-layout";

describe("sidebar section ordering", () => {
  const work = userSectionId("Work");
  const personal = userSectionId("Personal");

  it("restores saved order while inserting new sections at their natural slot", () => {
    expect(orderedSidebarSections([work, personal], [personal, work])).toEqual([personal, work]);
    expect(orderedSidebarSections([work, personal, userSectionId("Home")], [personal, work])).toEqual([
      personal,
      userSectionId("Home"),
      work,
    ]);
  });

  it("moves sections with keyboard or drag placement without wrapping", () => {
    const ids = [work, personal, userSectionId("Ideas")];
    expect(moveSection(ids, work, -1)).toBe(ids);
    expect(moveSection(ids, work, 1)).toEqual([personal, work, userSectionId("Ideas")]);
    expect(placeSection(ids, userSectionId("Ideas"), work, "before")).toEqual([
      userSectionId("Ideas"),
      work,
      personal,
    ]);
    expect(placeSection(ids, personal, personal, "after")).toBe(ids);
  });

  it("keeps temporarily empty sections in their saved slot", () => {
    expect(mergeSectionOrder([personal, work], [work])).toEqual([personal, work]);
    expect(sameSectionOrder([personal, work], [personal, work])).toBe(true);
    expect(userSectionName(work)).toBe("Work");
  });
});
