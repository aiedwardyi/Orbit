import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  showAvatarImageGenerate,
  showAvatarShapeOptions,
  showBotDetailsAdvanced,
  showBotNewTaskControl,
  showChannelCallControl,
  showChannelNewTaskControl,
  showCommunityRepoLink,
  showComputerPanelChrome,
  showSettingsAdvancedSection,
  showSettingsSearch,
  showSettingsMoreServicesSection,
  showSettingsEnginesNav,
  showUsagePerBotTable,
  showEngineRailZoo,
  showSidebarDensityControls,
  showSidebarRoutines,
  showSidebarTeachSkill,
} from "./friends-chrome";

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, "../components");
const app = readFileSync(join(here, "../App.tsx"), "utf8");
const settingsModal = readFileSync(join(components, "SettingsModal.tsx"), "utf8");
const settingsPanel = readFileSync(join(components, "SettingsPanel.tsx"), "utf8");
const chatView = readFileSync(join(components, "ChatView.tsx"), "utf8");
const groupView = readFileSync(join(components, "GroupView.tsx"), "utf8");
const sidebar = readFileSync(join(components, "Sidebar.tsx"), "utf8");
const teamLibrary = readFileSync(join(components, "TeamLibraryPanel.tsx"), "utf8");
const avatarCard = readFileSync(join(components, "BotProfileAvatarCard.tsx"), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from === -1 ? 0 : from + start.length);
  if (from < 0 || to < 0) {
    throw new Error(`missing source markers ${JSON.stringify(start)} .. ${JSON.stringify(end)}`);
  }
  return source.slice(from, to);
}

describe("friends chrome flags", () => {
  it("keeps Advanced, Computer, tasks, call, Teach/Routines, and avatar extras off the idle surface", () => {
    expect(showSettingsSearch()).toBe(false);
    expect(showSettingsAdvancedSection()).toBe(false);
    expect(showBotDetailsAdvanced()).toBe(false);
    expect(showComputerPanelChrome()).toBe(false);
    expect(showBotNewTaskControl()).toBe(false);
    expect(showChannelNewTaskControl()).toBe(false);
    expect(showChannelCallControl()).toBe(false);
    expect(showSidebarTeachSkill()).toBe(false);
    expect(showSidebarRoutines()).toBe(false);
    expect(showCommunityRepoLink()).toBe(false);
    expect(showAvatarImageGenerate()).toBe(false);
    expect(showAvatarShapeOptions()).toBe(false);
    expect(showSidebarDensityControls()).toBe(false);
    expect(showSettingsMoreServicesSection()).toBe(false);
    expect(showSettingsEnginesNav()).toBe(false);
    expect(showUsagePerBotTable()).toBe(false);
    expect(showEngineRailZoo()).toBe(false);
  });
});

describe("friends chrome call sites keep the feature code", () => {
  it("gates Settings search and Advanced instead of deleting them", () => {
    expect(settingsModal).toContain("showSettingsSearch()");
    expect(settingsModal).toContain("showSettingsAdvancedSection()");
    expect(settingsModal).toContain("showSettingsMoreServicesSection()");
    expect(settingsModal).toContain("showSettingsEnginesNav()");
    expect(settingsModal).toContain("data-settings-advanced");
    expect(settingsModal).toContain("data-settings-more-services");
    expect(settingsModal).toContain("<LocalComputerSection");
    expect(settingsModal).toContain("<ExperimentalFeaturesRow");
    expect(settingsModal).toContain("<DiagnosticsRow");
    expect(settingsModal).toContain("settings.searchAria");
  });

  it("gates Bot details Advanced instead of deleting Chief of Staff, computer, and voice", () => {
    expect(settingsPanel).toContain("showBotDetailsAdvanced()");
    expect(settingsPanel).toContain('aria-label="Chief of Staff"');
    expect(settingsPanel).toContain("<VoiceSettings");
    expect(settingsPanel).toContain("<BotUsageCard");
  });

  it("gates the Usage per-bot table instead of deleting it", () => {
    const usage = readFileSync(join(components, "UsageSection.tsx"), "utf8");
    expect(usage).toContain("showUsagePerBotTable()");
    expect(usage).toContain("Turns");
    expect(usage).toContain("Tokens");
    expect(usage).toContain("Cost");
  });

  it("gates the Computer panel and bot new-task control in chat chrome", () => {
    expect(chatView).toContain("showBotNewTaskControl()");
    expect(chatView).toContain("showComputerPanelChrome()");
    expect(chatView).toContain("<TaskPicker");
    expect(chatView).toContain('type: "toggleComputer"');
    expect(app).toContain("showComputerPanelChrome()");
    expect(app).toContain("<ComputerPanel");
  });

  it("gates channel call and new-task chrome without removing the components", () => {
    expect(groupView).toContain("showChannelNewTaskControl()");
    expect(groupView).toContain("showChannelCallControl()");
    expect(groupView).toContain("<GroupTaskPicker");
    expect(groupView).toContain("<GroupCallButton");
  });

  it("gates Teach a skill, Routines, community repo, GPT Image 2, and avatar shapes", () => {
    expect(sidebar).toContain("showSidebarTeachSkill()");
    expect(sidebar).toContain("showSidebarRoutines()");
    expect(sidebar).toContain('t("chrome.teachSkill")');
    expect(sidebar).toContain('t("chrome.routines")');
    expect(teamLibrary).toContain("showCommunityRepoLink()");
    expect(teamLibrary).toContain("Community repo");
    expect(avatarCard).toContain("showAvatarImageGenerate()");
    expect(avatarCard).toContain("showAvatarShapeOptions()");
    expect(avatarCard).toContain("Generate with GPT Image 2");
    expect(avatarCard).toContain("BOT_AVATAR_CROPS");
    expect(avatarCard).toContain("Upload image");
    expect(avatarCard).toContain("MAUS_COLOR_NAMES");
  });

  it("gates sidebar density toys and keeps a drag-resize handle plus the create menu", () => {
    expect(sidebar).toContain("showSidebarDensityControls()");
    expect(sidebar).toContain('t("chrome.collapseSidebar")');
    expect(sidebar).toContain('t("chrome.sidebarDensity")');
    expect(sidebar).toContain('t("chrome.densityAvatars")');
    expect(sidebar).toContain('t("chrome.resizeSidebar")');
    expect(sidebar).toContain("data-sidebar-resize");
    const resizeHandle = sourceBetween(
      sidebar,
      "{density !== \"icons\" && (",
      "macOS owns inset traffic lights",
    );
    expect(resizeHandle).toContain("data-sidebar-resize");
    expect(resizeHandle).toContain("tabIndex={0}");
    expect(resizeHandle).toContain("aria-valuenow={sidebarWidth}");
    expect(resizeHandle).toContain("aria-valuemin={SIDEBAR_MIN_WIDTH}");
    expect(resizeHandle).toContain("aria-valuemax={SIDEBAR_MAX_WIDTH}");
    expect(resizeHandle).toContain('t("chrome.sidebarWidthPixels", { width: sidebarWidth })');
    expect(resizeHandle).toContain("onKeyDown={onSidebarResizeKeyDown}");
    expect(resizeHandle).toContain("onPointerUp={onSidebarResizeEnd}");
    expect(resizeHandle).toContain("onPointerCancel={onSidebarResizeCancel}");
    expect(resizeHandle).not.toMatch(/onPointerCancel=\{onSidebarResizeEnd\}/);
    const resizeEnd = sourceBetween(sidebar, "const onSidebarResizeEnd", "const onSidebarResizeCancel");
    expect(resizeEnd).toContain("releasePointerCapture");
    expect(resizeEnd).toContain("saveSidebarWidth");
    const resizeCancel = sourceBetween(sidebar, "const onSidebarResizeCancel", "const onSidebarResizeKeyDown");
    expect(resizeCancel).toContain("restoreSidebarDragWidth");
    expect(resizeCancel).toContain("setSidebarWidth(startWidth)");
    expect(resizeCancel).toContain("sidebarWidthRef.current = startWidth");
    expect(resizeCancel).toContain("setResizing(false)");
    expect(resizeCancel).not.toContain("saveSidebarWidth");
    expect(sidebar).toContain("stepSidebarWidth");
    expect(sidebar).toContain("saveSidebarWidth(next)");
    expect(sidebar).toContain('t("chrome.newOrShare")');
    expect(sidebar).toContain('t("chrome.newBot")');
    expect(sidebar).toContain('t("chrome.newChannel")');
  });

  it("calls the channel folder a shared project folder instead of a per-task pin", () => {
    expect(groupView).toContain('t("room.workingFolder")');
    expect(groupView).toContain('t("room.workingFolderHelp")');
    expect(groupView).toContain('t("room.chooseSharedFolder")');
    expect(groupView).toContain('t("room.projectFolderChip")');
    expect(groupView).toContain("<RoomWorkingFolderChip");
    expect(groupView).not.toMatch(/Start a new task/);
    expect(groupView).not.toMatch(/Fixed for this task/);
  });
});
