import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("reply style preference", () => {
  it("saves without a browser window", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("localStorage", undefined);
    const { loadReplyStyle, saveReplyStyle } = await import("./reply-style");
    expect(() => saveReplyStyle("live")).not.toThrow();
    expect(loadReplyStyle()).toBe("live");
  });

  it.each([null, "paragraphs"])("keeps the session choice when storage contains %s and writes fail", async (stored) => {
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("localStorage", {
      getItem: () => stored,
      setItem: () => { throw new Error("quota"); },
    });
    const { loadReplyStyle, saveReplyStyle } = await import("./reply-style");
    saveReplyStyle("live");
    expect(loadReplyStyle()).toBe("live");
  });

  it("reads storage again after a successful save", async () => {
    let stored = "paragraphs";
    let blocked = true;
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("localStorage", {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        if (blocked) throw new Error("quota");
        stored = value;
      },
    });
    const { loadReplyStyle, saveReplyStyle } = await import("./reply-style");
    saveReplyStyle("live");
    expect(loadReplyStyle()).toBe("live");
    blocked = false;
    saveReplyStyle("live");
    stored = "paragraphs";
    expect(loadReplyStyle()).toBe("paragraphs");
  });
});
