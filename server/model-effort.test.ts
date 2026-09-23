import { describe, expect, it } from "vitest";

import { grokModelTakesXhigh, isEffortOffered, offeredEffortLevels } from "../shared/model-effort.ts";
import type { EffortLevel } from "./contracts.ts";

const GROK_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh"];

describe("grok xhigh model gate", () => {
  it("takes xhigh on the 4.6 family only", () => {
    expect(grokModelTakesXhigh("grok-4.6")).toBe(true);
    expect(grokModelTakesXhigh("GROK-4.6-turbo")).toBe(true);
    expect(grokModelTakesXhigh("grok-4.5")).toBe(false);
    expect(grokModelTakesXhigh("grok-4.5-fast")).toBe(false);
    expect(grokModelTakesXhigh("custom-slug")).toBe(false);
    expect(grokModelTakesXhigh("")).toBe(false);
  });

  it("offers xhigh on 4.6 and rejects it on 4.5", () => {
    expect(isEffortOffered("grokAgent", "grok-4.6", "xhigh", GROK_LEVELS)).toBe(true);
    expect(isEffortOffered("grokAgent", "grok-4.5", "xhigh", GROK_LEVELS)).toBe(false);
    expect(isEffortOffered("grokAgent", "grok-4.5", "high", GROK_LEVELS)).toBe(true);
    expect(isEffortOffered("grokAgent", "custom-slug", "xhigh", GROK_LEVELS)).toBe(false);
  });

  it("still requires the engine-level declaration", () => {
    expect(isEffortOffered("grokAgent", "grok-4.6", "xhigh", ["low", "medium", "high"])).toBe(false);
    expect(isEffortOffered("grokAgent", "grok-4.6", "max", [...GROK_LEVELS, "max"])).toBe(true);
  });

  it("leaves non-Grok drivers untouched", () => {
    const levels: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
    expect(isEffortOffered("claudeAgent", "claude-opus-5-5", "xhigh", levels)).toBe(true);
    expect(isEffortOffered("codex", "gpt-6-sol", "low", levels)).toBe(true);
    expect(isEffortOffered("museAgent", "muse-spark-1.3", "xhigh", [])).toBe(false);
  });

  it("filters declared levels per model for picker options", () => {
    expect(offeredEffortLevels("grokAgent", "grok-4.6", GROK_LEVELS)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(offeredEffortLevels("grokAgent", "grok-4.5", GROK_LEVELS)).toEqual(["low", "medium", "high"]);
    expect(offeredEffortLevels("claudeAgent", "claude-opus-5-5", GROK_LEVELS)).toEqual(["low", "medium", "high", "xhigh"]);
  });
});
