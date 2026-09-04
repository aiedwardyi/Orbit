import { describe, expect, it } from "vitest";

import {
  friendsSettingsNavVisible,
  resolvedAppSettingsSection,
  showSettingsAdvancedControls,
  showSettingsMoreServices,
} from "./settings-chrome";

describe("showSettingsAdvancedControls", () => {
  it("keeps Local VM, channel turns, experimental, and diagnostics off the friends surface", () => {
    expect(showSettingsAdvancedControls(false)).toBe(false);
    expect(showSettingsAdvancedControls(true)).toBe(false);
  });
});

describe("showSettingsMoreServices", () => {
  it("keeps AssemblyAI, Box, VPS, and self-host off the friends Connections page", () => {
    expect(showSettingsMoreServices(false)).toBe(false);
    expect(showSettingsMoreServices(true)).toBe(false);
  });
});

describe("friendsSettingsNavVisible", () => {
  it("hides Local VM, Phone, and the Engines tab", () => {
    expect(friendsSettingsNavVisible("computer", "", { phoneAvailable: false })).toBe(false);
    expect(friendsSettingsNavVisible("computer", "", { phoneAvailable: true })).toBe(false);
    expect(friendsSettingsNavVisible("companion", "", { phoneAvailable: false })).toBe(false);
    expect(friendsSettingsNavVisible("general", "", { phoneAvailable: false })).toBe(true);
    expect(friendsSettingsNavVisible("connections", "", { phoneAvailable: false })).toBe(true);
    expect(friendsSettingsNavVisible("engines", "", { phoneAvailable: false })).toBe(false);
    expect(friendsSettingsNavVisible("usage", "", { phoneAvailable: false })).toBe(true);
  });

  it("never surfaces Local VM from search — Advanced is off this surface", () => {
    expect(friendsSettingsNavVisible("computer", "vm", { phoneAvailable: false })).toBe(false);
    expect(friendsSettingsNavVisible("computer", "local vm", { phoneAvailable: false })).toBe(false);
  });

  it("keeps Phone off the idle surface even when the host would otherwise show it", () => {
    expect(friendsSettingsNavVisible("companion", "", { phoneAvailable: true })).toBe(false);
    expect(friendsSettingsNavVisible("companion", "phone", { phoneAvailable: true })).toBe(false);
  });
});

describe("resolvedAppSettingsSection", () => {
  it("folds Engines into Connections", () => {
    expect(resolvedAppSettingsSection("engines")).toBe("connections");
    expect(resolvedAppSettingsSection("connections")).toBe("connections");
    expect(resolvedAppSettingsSection("usage")).toBe("usage");
  });
});
