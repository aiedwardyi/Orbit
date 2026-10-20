import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("rainbow chat box preference", () => {
  it.each([
    [null, "off"],
    ["invalid", "off"],
    ["off", "off"],
    ["on", "rainbow"],
    ["theme", "theme"],
  ])("loads %s as %s", async (stored, mode) => {
    vi.stubGlobal("localStorage", { getItem: () => stored });
    const { rainbowBoxMode } = await import("./rainbow-box");
    expect(rainbowBoxMode()).toBe(mode);
  });

  it("restores the choice after a module reload", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const { saveRainbowBox } = await import("./rainbow-box");
    saveRainbowBox("rainbow");
    expect(values.get("omb-rainbow-box")).toBe("on");
    vi.resetModules();
    expect((await import("./rainbow-box")).rainbowBoxMode()).toBe("rainbow");
    (await import("./rainbow-box")).saveRainbowBox("theme");
    vi.resetModules();
    expect((await import("./rainbow-box")).rainbowBoxMode()).toBe("theme");
  });

  it("keeps the toggle usable when storage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    const { rainbowBoxMode, saveRainbowBox } = await import("./rainbow-box");
    expect(rainbowBoxMode()).toBe("off");
    saveRainbowBox("theme");
    expect(rainbowBoxMode()).toBe("theme");
  });
});
