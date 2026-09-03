import { describe, expect, it } from "vitest";

import {
  CONNECTIONS_MORE_SERVICES,
  CONNECTIONS_PRIMARY,
  FRIENDS_APP_SETTINGS_SECTIONS,
  SETTINGS_ADVANCED_BLOCKS,
  friendsAppSettingsNavVisible,
  showMoreServices,
  showSettingsAdvanced,
} from "./settings-chrome";

describe("friends App Settings nav", () => {
  it("keeps General, Connections, Engines, and Usage out front", () => {
    expect(FRIENDS_APP_SETTINGS_SECTIONS).toEqual([
      "general",
      "connections",
      "engines",
      "usage",
    ]);
    expect(friendsAppSettingsNavVisible("general", false)).toBe(true);
    expect(friendsAppSettingsNavVisible("connections", false)).toBe(true);
    expect(friendsAppSettingsNavVisible("engines", false)).toBe(true);
    expect(friendsAppSettingsNavVisible("usage", false)).toBe(true);
  });

  it("does not leave Local VM as a top-level Settings section", () => {
    expect(friendsAppSettingsNavVisible("computer", false)).toBe(false);
    expect(friendsAppSettingsNavVisible("computer", true)).toBe(false);
    expect(FRIENDS_APP_SETTINGS_SECTIONS).not.toContain("computer");
  });

  it("keeps Phone parked unless the host still exposes companion settings", () => {
    expect(friendsAppSettingsNavVisible("companion", false)).toBe(false);
    expect(friendsAppSettingsNavVisible("companion", true)).toBe(true);
    expect(FRIENDS_APP_SETTINGS_SECTIONS).not.toContain("companion");
  });
});

describe("settings Advanced and More services", () => {
  it("keeps Advanced folded until asked", () => {
    expect(showSettingsAdvanced(false)).toBe(false);
    expect(showSettingsAdvanced(true)).toBe(true);
  });

  it("puts Local VM, Channel turns, Experimental, and Diagnostics in one Advanced set", () => {
    expect(SETTINGS_ADVANCED_BLOCKS).toEqual([
      "localVm",
      "channelTurns",
      "experimental",
      "diagnostics",
    ]);
  });

  it("keeps Gemini as the only top-level connection and folds the other four", () => {
    expect(CONNECTIONS_PRIMARY).toBe("gemini");
    expect(CONNECTIONS_MORE_SERVICES).toEqual([
      "transcription",
      "box",
      "vps",
      "opencodeGo",
    ]);
    expect(showMoreServices(false)).toBe(false);
    expect(showMoreServices(true)).toBe(true);
  });
});
