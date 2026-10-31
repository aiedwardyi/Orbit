import { afterEach, describe, expect, it, vi } from "vitest";
import { loadModelPickerView, saveModelPickerView } from "./model-picker-view";

afterEach(() => vi.unstubAllGlobals());

describe("model picker view", () => {
  it("defaults to the dial for missing and invalid preferences", () => {
    for (const value of [null, "unknown", "dial"]) {
      vi.stubGlobal("localStorage", { getItem: () => value });
      expect(loadModelPickerView()).toBe("dial");
    }
  });

  it("loads the last view from storage without a store instance", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    saveModelPickerView("list");
    expect(loadModelPickerView()).toBe("list");
    saveModelPickerView("dial");
    expect(loadModelPickerView()).toBe("dial");
  });

  it("tolerates unavailable storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(loadModelPickerView()).toBe("dial");
    expect(() => saveModelPickerView("list")).not.toThrow();
  });
});
