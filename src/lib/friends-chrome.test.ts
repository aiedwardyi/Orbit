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
  });
});

describe("friends chrome call sites keep the feature code", () => {
  it("gates Settings search and Advanced instead of deleting them", () => {
    expect(settingsModal).toContain("showSettingsSearch()");
    expect(settingsModal).toContain("showSettingsAdvancedSection()");
    expect(settingsModal).toContain("data-settings-advanced");
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
  });
});
