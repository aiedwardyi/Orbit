import { describe, expect, it } from "vitest";

import { initialState, reducer } from "./store";

describe("app settings open on General", () => {
  it("returns the gear to General after a shortcut tab", () => {
    const onUsage = reducer(initialState, { type: "toggleAppSettings", open: true, section: "usage" });
    const closed = reducer(onUsage, { type: "toggleAppSettings", open: false });
    const fromGear = reducer(closed, { type: "toggleAppSettings" });
    expect(fromGear.appSettingsOpen).toBe(true);
    expect(fromGear.appSettingsSection).toBe("general");
    expect(fromGear.appSettingsPage).toBe(false);
  });

  it("still opens the tab a shortcut names", () => {
    const onThemes = reducer(initialState, { type: "toggleAppSettings", open: true, section: "themes" });
    const usage = reducer(onThemes, { type: "toggleAppSettings", open: true, section: "usage" });
    const models = reducer(usage, { type: "toggleAppSettings", open: true, section: "models-index" });
    expect(usage.appSettingsSection).toBe("usage");
    expect(models.appSettingsSection).toBe("models-index");
    expect(usage.appSettingsPage).toBe(true);
    expect(models.appSettingsPage).toBe(true);
  });

  it.each(["general", "connections", "usage"] as const)("distinguishes an explicit %s link from the gear", (section) => {
    const linked = reducer(initialState, { type: "toggleAppSettings", open: true, section });
    expect(linked.appSettingsSection).toBe(section);
    expect(linked.appSettingsPage).toBe(true);
    const list = reducer(linked, { type: "toggleAppSettings", open: true });
    expect(list.appSettingsOpen).toBe(true);
    expect(list.appSettingsPage).toBe(false);
  });
});
