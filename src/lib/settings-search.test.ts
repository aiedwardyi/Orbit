import { describe, expect, it } from "vitest";
import { settingsSectionMatches } from "./settings-search";

describe("settings section search", () => {
  it("matches Korean section labels and body keywords, not only English nav labels", () => {
    expect(settingsSectionMatches("general", "일반")).toBe(true);
    expect(settingsSectionMatches("general", "업데이트")).toBe(true);
    expect(settingsSectionMatches("general", "도구 호출")).toBe(true);
    expect(settingsSectionMatches("general", "사용 분석")).toBe(false);
    expect(settingsSectionMatches("connections", "연결")).toBe(true);
    expect(settingsSectionMatches("engines", "엔진")).toBe(true);
    expect(settingsSectionMatches("usage", "업데이트")).toBe(false);
  });

  it("still matches English labels and keywords", () => {
    expect(settingsSectionMatches("general", "updates")).toBe(true);
    expect(settingsSectionMatches("general", "analytics")).toBe(false);
    expect(settingsSectionMatches("connections", "keys")).toBe(true);
    expect(settingsSectionMatches("general", "vm")).toBe(true);
    expect(settingsSectionMatches("general", "more services")).toBe(false);
    expect(settingsSectionMatches("connections", "more services")).toBe(false);
    expect(settingsSectionMatches("connections", "box")).toBe(false);
    expect(settingsSectionMatches("connections", "assemblyai")).toBe(false);
    expect(settingsSectionMatches("connections", "vps")).toBe(false);
    expect(settingsSectionMatches("connections", "self-host")).toBe(false);
    expect(settingsSectionMatches("connections", "grok")).toBe(true);
    expect(settingsSectionMatches("connections", "gemini")).toBe(true);
    expect(settingsSectionMatches("connections", "muse")).toBe(true);
    expect(settingsSectionMatches("connections", "opencode")).toBe(false);
    expect(settingsSectionMatches("connections", "cli")).toBe(true);
  });

  it("finds skins on Themes, not General", () => {
    expect(settingsSectionMatches("themes", "skin")).toBe(true);
    expect(settingsSectionMatches("themes", "theme")).toBe(true);
    expect(settingsSectionMatches("themes", "kanagawa")).toBe(true);
    expect(settingsSectionMatches("themes", "haxor")).toBe(true);
    expect(settingsSectionMatches("themes", "hax0r")).toBe(true);
    expect(settingsSectionMatches("themes", "linear")).toBe(true);
    expect(settingsSectionMatches("themes", "notion")).toBe(true);
    expect(settingsSectionMatches("themes", "messages")).toBe(true);
    expect(settingsSectionMatches("themes", "discord")).toBe(true);
    expect(settingsSectionMatches("themes", "github light")).toBe(true);
    expect(settingsSectionMatches("themes", "technical drawing")).toBe(true);
    expect(settingsSectionMatches("themes", "blueprint gray")).toBe(true);
    expect(settingsSectionMatches("themes", "blueprint charcoal")).toBe(true);
    expect(settingsSectionMatches("themes", "중간 회색")).toBe(true);
    expect(settingsSectionMatches("themes", "깊은 차콜")).toBe(true);
    expect(settingsSectionMatches("themes", "instrument")).toBe(true);
    expect(settingsSectionMatches("themes", "matte")).toBe(true);
    expect(settingsSectionMatches("themes", "carbon")).toBe(true);
    expect(settingsSectionMatches("themes", "둥근 서체")).toBe(true);
    expect(settingsSectionMatches("themes", "테마")).toBe(true);
    expect(settingsSectionMatches("general", "skin")).toBe(false);
    expect(settingsSectionMatches("general", "kanagawa")).toBe(false);
    expect(settingsSectionMatches("general", "hax0r")).toBe(false);
    expect(settingsSectionMatches("themes", "updates")).toBe(false);
  });
});
