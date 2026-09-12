import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("usage mode preference", () => {
  it("defaults to remaining on a clean localStorage", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    const { getUsageMode } = await import("./usage-preferences");
    expect(getUsageMode()).toBe("remaining");
  });

  it.each([null, "invalid", "used", "remaining"])("loads %s with remaining as the default", async (stored) => {
    vi.stubGlobal("localStorage", { getItem: () => stored });
    const { getUsageMode } = await import("./usage-preferences");
    expect(getUsageMode()).toBe(stored === "used" ? "used" : "remaining");
  });

  it("restores the choice after a module reload", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const { setUsageMode } = await import("./usage-preferences");
    setUsageMode("remaining");
    vi.resetModules();
    expect((await import("./usage-preferences")).getUsageMode()).toBe("remaining");
  });

  it("keeps the toggle usable when storage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    const { getUsageMode, setUsageMode } = await import("./usage-preferences");
    expect(getUsageMode()).toBe("remaining");
    setUsageMode("used");
    expect(getUsageMode()).toBe("used");
  });
});
