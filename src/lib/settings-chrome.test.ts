import { describe, expect, it } from "vitest";

import {
  friendsSettingsNavVisible,
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
  it("keeps non-Gemini connections folded until asked", () => {
    expect(showSettingsMoreServices(false)).toBe(false);
    expect(showSettingsMoreServices(true)).toBe(true);
  });
});

describe("friendsSettingsNavVisible", () => {
  it("hides Local VM from the idle nav and Phone when parked", () => {
    expect(friendsSettingsNavVisible("computer", "", { phoneAvailable: false })).toBe(false);
    expect(friendsSettingsNavVisible("computer", "", { phoneAvailable: true })).toBe(false);
    expect(friendsSettingsNavVisible("companion", "", { phoneAvailable: false })).toBe(false);
    expect(friendsSettingsNavVisible("general", "", { phoneAvailable: false })).toBe(true);
    expect(friendsSettingsNavVisible("connections", "", { phoneAvailable: false })).toBe(true);
    expect(friendsSettingsNavVisible("engines", "", { phoneAvailable: false })).toBe(true);
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
