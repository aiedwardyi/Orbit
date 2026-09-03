import { describe, expect, it } from "vitest";
import { settingsSectionMatches } from "./settings-search";

describe("settings section search", () => {
  it("matches Korean section labels and body keywords, not only English nav labels", () => {
    expect(settingsSectionMatches("general", "일반")).toBe(true);
    expect(settingsSectionMatches("general", "업데이트")).toBe(true);
    expect(settingsSectionMatches("general", "도구 호출")).toBe(true);
    expect(settingsSectionMatches("general", "사용 분석")).toBe(true);
    expect(settingsSectionMatches("connections", "연결")).toBe(true);
    expect(settingsSectionMatches("engines", "엔진")).toBe(true);
    expect(settingsSectionMatches("usage", "업데이트")).toBe(false);
  });

  it("still matches English labels and keywords", () => {
    expect(settingsSectionMatches("general", "updates")).toBe(true);
    expect(settingsSectionMatches("general", "analytics")).toBe(true);
    expect(settingsSectionMatches("connections", "keys")).toBe(true);
  });

  it("finds folded Local VM and extra services from General and Connections search", () => {
    expect(settingsSectionMatches("general", "vm")).toBe(true);
    expect(settingsSectionMatches("general", "로컬 VM")).toBe(true);
    expect(settingsSectionMatches("general", "advanced")).toBe(true);
    expect(settingsSectionMatches("connections", "more services")).toBe(true);
    expect(settingsSectionMatches("connections", "opencode")).toBe(true);
  });
});
