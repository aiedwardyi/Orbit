import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { en, ko } from "@/lib/i18n-catalog";

const here = dirname(fileURLToPath(import.meta.url));
const sidebar = readFileSync(join(here, "Sidebar.tsx"), "utf8");

describe("bot list menu", () => {
  it("says Make a copy, 분류, and starts a group with this bot", () => {
    expect(en["chrome.duplicate"]).toBe("Make a copy");
    expect(ko["chrome.duplicate"]).toBe("사본 만들기");
    expect(en["chrome.moveToSection"]).toBe("Move to section");
    expect(ko["chrome.moveToSection"]).toBe("분류로 이동");
    expect(ko["chrome.moveToContext"]).toBe("분류로 이동");
    expect(ko["chrome.newContextName"]).toBe("새 분류 이름");
    expect(ko["chrome.removeFromContext"]).toBe("분류에서 제거");
    expect(en["chrome.newContextName"]).toBe("New section name");
    expect(en["chrome.removeFromContext"]).toBe("Remove from section");
    expect(en["chrome.makeGroupWithBot"]).toBe("Make a group with this bot");
    expect(ko["chrome.makeGroupWithBot"]).toBe("이 봇으로 그룹 만들기");
    expect(en["chrome.copyConversationId"]).toBe("Copy conversation ID");

    expect(sidebar).toContain('t("chrome.makeGroupWithBot")');
    expect(sidebar).toContain("preselectBotId: botId");
    expect(sidebar).toContain("writeText(group.threadId)");
    expect(sidebar).not.toContain("writeText(bot.threadId)");
  });

  it("opens Connections from the profile and leaves the gear on General", () => {
    const start = sidebar.indexOf("data-sidebar-profile-row");
    const row = sidebar.slice(start, sidebar.indexOf("{menu &&", start));
    const profile = row.indexOf('section: "connections"');
    const gear = row.indexOf('dispatch({ type: "toggleAppSettings" })');
    expect(profile).toBeGreaterThan(-1);
    expect(gear).toBeGreaterThan(profile);
    expect(row.slice(gear, gear + 40)).not.toContain("section:");
  });
});
