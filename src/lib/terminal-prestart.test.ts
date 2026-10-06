import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadOpenedTerminals, prestartSize, rememberTerminalOpened, schedulePrestart, TERMINAL_OPENED_KEY } from "./terminal-prestart";

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.tsx"), "utf8");

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

const box = () => ({ width: 1000, height: 600 });

afterEach(() => {
  vi.useRealTimers();
});

describe("opened-terminal flag", () => {
  it("remembers each bot once and survives a reload", () => {
    const storage = memoryStorage();
    rememberTerminalOpened("bot-1", storage);
    rememberTerminalOpened("bot-1", storage);
    rememberTerminalOpened("bot-2", storage);
    expect(storage.getItem(TERMINAL_OPENED_KEY)).toBe('["bot-1","bot-2"]');
    expect(loadOpenedTerminals(storage)).toEqual(new Set(["bot-1", "bot-2"]));
  });

  it("reads a corrupt or blocked store as nothing opened", () => {
    expect(loadOpenedTerminals(memoryStorage({ [TERMINAL_OPENED_KEY]: "{bad" }))).toEqual(new Set());
    expect(loadOpenedTerminals(memoryStorage({ [TERMINAL_OPENED_KEY]: '[1,"bot-1"]' }))).toEqual(new Set(["bot-1"]));
    expect(loadOpenedTerminals({ getItem: () => { throw new Error("blocked"); } })).toEqual(new Set());
    expect(() => rememberTerminalOpened("bot-1", { getItem: () => null, setItem: () => { throw new Error("full"); } })).not.toThrow();
  });
});

describe("pre-start policy", () => {
  it("pre-starts an opened bot's shell after the chat has been open 1.5 s, at the chat's size", async () => {
    vi.useFakeTimers();
    const prestart = vi.fn(async () => true);
    schedulePrestart({ bridge: { prestart }, botId: "bot-1", projectCwd: "C:\\repo", measure: box, storage: memoryStorage({ [TERMINAL_OPENED_KEY]: '["bot-1"]' }) });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(prestart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(prestart).toHaveBeenCalledWith({ botId: "bot-1", ...prestartSize(1000, 600), projectCwd: "C:\\repo" });
  });

  it("never pre-starts a bot whose terminal was never opened here", async () => {
    vi.useFakeTimers();
    const prestart = vi.fn(async () => true);
    schedulePrestart({ bridge: { prestart }, botId: "bot-2", projectCwd: null, measure: box, storage: memoryStorage({ [TERMINAL_OPENED_KEY]: '["bot-1"]' }) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(prestart).not.toHaveBeenCalled();
  });

  it("never pre-starts in a remote browser without the desktop bridge", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage({ [TERMINAL_OPENED_KEY]: '["bot-1"]' });
    expect(() => schedulePrestart({ bridge: undefined, botId: "bot-1", projectCwd: null, measure: box, storage })()).not.toThrow();
    expect(() => schedulePrestart({ bridge: {}, botId: "bot-1", projectCwd: null, measure: box, storage })()).not.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it("drops the pre-start when the chat closes first or has no room", async () => {
    vi.useFakeTimers();
    const prestart = vi.fn(async () => true);
    const storage = memoryStorage({ [TERMINAL_OPENED_KEY]: '["bot-1"]' });
    const cancel = schedulePrestart({ bridge: { prestart }, botId: "bot-1", projectCwd: null, measure: box, storage });
    await vi.advanceTimersByTimeAsync(1_000);
    cancel();
    schedulePrestart({ bridge: { prestart }, botId: "bot-1", projectCwd: null, measure: () => undefined, storage });
    schedulePrestart({ bridge: { prestart }, botId: "bot-1", projectCwd: null, measure: () => ({ width: 0, height: 0 }), storage });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(prestart).not.toHaveBeenCalled();
  });

  it("swallows a refused pre-start", async () => {
    vi.useFakeTimers();
    const prestart = vi.fn(async () => { throw new Error("Untrusted terminal caller"); });
    schedulePrestart({ bridge: { prestart }, botId: "bot-1", projectCwd: null, measure: box, storage: memoryStorage({ [TERMINAL_OPENED_KEY]: '["bot-1"]' }) });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(prestart).toHaveBeenCalledOnce();
  });

  it("sizes within the host's terminal limits", () => {
    expect(prestartSize(1000, 600)).toEqual({ cols: 123, rows: 31 });
    expect(prestartSize(10_000, 10_000)).toEqual({ cols: 500, rows: 300 });
    expect(prestartSize(40, 600)).toBeNull();
  });

  it("is wired to the chat being shown and remembers every terminal open", () => {
    expect(app).toContain('const chatShown = Boolean(bot && state.activeView === "chat" && !terminalOpen);');
    expect(app).toContain("if (bot && terminalOpen) rememberTerminalOpened(bot.id);");
    expect(app).toContain("bridge: window.ogb?.terminal,");
    expect(app).toContain("measure: () => conversationRef.current?.getBoundingClientRect(),");
  });
});
