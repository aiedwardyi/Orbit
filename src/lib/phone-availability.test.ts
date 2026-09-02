import { describe, expect, it } from "vitest";

import { phoneSettingsAvailable } from "./phone-availability";

describe("phone settings availability", () => {
  it("hides Phone on the packaged Windows build", () => {
    expect(phoneSettingsAvailable({ platform: "win32", packaged: true })).toBe(false);
  });

  it("keeps Phone for unpackaged Windows and other packaged desktops", () => {
    expect(phoneSettingsAvailable({ platform: "win32", packaged: false })).toBe(true);
    expect(phoneSettingsAvailable({ platform: "darwin", packaged: true })).toBe(true);
    expect(phoneSettingsAvailable({ platform: "linux", packaged: true })).toBe(true);
  });
});
