import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("terminal popups preference", () => {
  it.each([null, "invalid", "off", "on"])("loads %s with off as the default", async (stored) => {
    vi.stubGlobal("localStorage", { getItem: () => stored });
    const { terminalPopupsEnabled } = await import("./terminal-popups");
    expect(terminalPopupsEnabled()).toBe(stored === "on");
  });

  it("restores the choice after a module reload", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const { saveTerminalPopups } = await import("./terminal-popups");
    saveTerminalPopups(true);
    vi.resetModules();
    expect((await import("./terminal-popups")).terminalPopupsEnabled()).toBe(true);
  });

  it("keeps the toggle usable when storage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    const { terminalPopupsEnabled, saveTerminalPopups } = await import("./terminal-popups");
    expect(terminalPopupsEnabled()).toBe(false);
    saveTerminalPopups(true);
    expect(terminalPopupsEnabled()).toBe(true);
  });
});
