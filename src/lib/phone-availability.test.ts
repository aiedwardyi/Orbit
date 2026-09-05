import { describe, expect, it } from "vitest";

import { phoneSettingsAvailable } from "./phone-availability";

describe("phone settings availability", () => {
  it("hides Phone on every packaged desktop", () => {
    expect(phoneSettingsAvailable({ platform: "win32", packaged: true })).toBe(false);
    expect(phoneSettingsAvailable({ platform: "darwin", packaged: true })).toBe(false);
    expect(phoneSettingsAvailable({ platform: "linux", packaged: true })).toBe(false);
  });

  it("keeps Phone for unpackaged development builds", () => {
    expect(phoneSettingsAvailable({ platform: "win32", packaged: false })).toBe(true);
    expect(phoneSettingsAvailable({ platform: "darwin", packaged: false })).toBe(true);
  });
});
