import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("rainbow chat box preference", () => {
  it.each([null, "invalid", "off", "on"])("loads %s with off as the default", async (stored) => {
    vi.stubGlobal("localStorage", { getItem: () => stored });
    const { rainbowBoxEnabled } = await import("./rainbow-box");
    expect(rainbowBoxEnabled()).toBe(stored === "on");
  });

  it("restores the choice after a module reload", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const { saveRainbowBox } = await import("./rainbow-box");
    saveRainbowBox(true);
    vi.resetModules();
    expect((await import("./rainbow-box")).rainbowBoxEnabled()).toBe(true);
  });

  it("keeps the toggle usable when storage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    const { rainbowBoxEnabled, saveRainbowBox } = await import("./rainbow-box");
    expect(rainbowBoxEnabled()).toBe(false);
    saveRainbowBox(true);
    expect(rainbowBoxEnabled()).toBe(true);
  });
});
