import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAutomaticSelection, type AutomaticCandidate } from "./automatic-selection.ts";

const candidate = (
  instanceId: string,
  overrides: Partial<AutomaticCandidate> = {},
): AutomaticCandidate => ({
  instanceId,
  defaultModel: `${instanceId}-default`,
  available: true,
  capabilities: {},
  ...overrides,
});

describe("automatic usage ranking", () => {
  const now = Date.parse("2026-09-12T12:00:00Z");
  const window = (usedPercent: number, resetsAt: number | null = now + 60_000, id = "seven_day") => ({ id, usedPercent, resetsAt });
  const used = (instanceId: string, usedPercent: number, overrides: Partial<AutomaticCandidate> = {}) =>
    candidate(instanceId, { rateLimits: [window(usedPercent)], ...overrides });
  const pick = (candidates: AutomaticCandidate[]) => resolveAutomaticSelection({ candidates })?.instanceId;

  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps configured order when all usage is below exhaustion", () => {
    expect(pick([used("first", 99.9), used("second", 0)])).toBe("first");
  });

  it.each(["grokAgent", "codex", "claudeAgent", "future-driver"])("deprioritizes a live exhausted weekly window for any provider: %s", (driverKind) => {
    for (const percent of [100, 125]) {
      expect(pick([used("first", percent, { driverKind }), used("second", 30)])).toBe("second");
      expect(pick([used("first", percent, { driverKind, rateLimits: [window(percent, now + 1, "custom-pool")] }), used("second", 30)])).toBe("second");
    }
  });

  it("keeps usage isolated between accounts on the same driver", () => {
    expect(pick([used("account-a", 100, { driverKind: "claudeAgent" }), used("account-b", 10, { driverKind: "claudeAgent" })])).toBe("account-b");
  });

  it("deprioritizes an exhausted short window when weekly usage is fresh", () => {
    expect(pick([candidate("first", { rateLimits: [window(10), window(100, now + 1, "five_hour")] }), used("second", 0)])).toBe("second");
  });

  it("keeps the first eligible engine when every engine is exhausted", () => {
    expect(pick([used("first", 125), used("second", 100)])).toBe("first");
  });

  it("keeps an exhausted engine when it is the only eligible candidate", () => {
    expect(pick([used("only", 100)])).toBe("only");
  });

  it.each([undefined, []])("treats missing and empty usage like fresh usage: %j", (rateLimits) => {
    const silent = candidate("silent", { rateLimits });
    expect(pick([silent, used("fresh", 0)])).toBe("silent");
    expect(pick([used("fresh", 1), silent])).toBe("fresh");
    expect(pick([used("full", 100), silent])).toBe("silent");
  });

  it.each([0, -1])("ignores expired exhaustion at and before reset time: %i", (offset) => {
    expect(pick([candidate("first", { rateLimits: [window(100, now + offset)] }), used("second", 0)])).toBe("first");
  });

  it.each([null, NaN, Infinity])("retains exhaustion when the reset time is unknown: %s", (resetsAt) => {
    expect(pick([candidate("first", { rateLimits: [window(100, resetsAt)] }), used("second", 0)])).toBe("second");
  });

  it.each([NaN, Infinity, -Infinity])("ignores nonfinite usage percentages: %s", (percent) => {
    expect(pick([used("first", percent), used("second", 0)])).toBe("first");
  });

  it("preserves exhausted continuity ahead of a fresh current selection", () => {
    expect(resolveAutomaticSelection({
      candidates: [used("fresh", 0), used("steady", 100)],
      current: { mode: "automatic", instanceId: "fresh", model: "fresh-default" },
      continuity: { instanceId: "steady", model: "saved-model" },
    })).toMatchObject({ instanceId: "steady", model: "saved-model" });
  });

  it("preserves an exhausted current selection and supported effort without continuity", () => {
    expect(resolveAutomaticSelection({
      candidates: [used("fresh", 0), used("steady", 100, { effortLevels: ["high"] })],
      current: { mode: "automatic", instanceId: "steady", model: "saved-model", effort: "high" },
    })).toMatchObject({ instanceId: "steady", model: "saved-model", effort: "high" });
  });

  it("does not let fresh usage bypass availability or required capabilities", () => {
    const ineligible = [used("offline", 0, { available: false }), used("empty", 0, { defaultModel: "" }), used("incapable", 0)];
    const input = { required: ["browserMcp"] as const };
    expect(resolveAutomaticSelection({ ...input, candidates: [...ineligible, used("full", 100, { capabilities: { browserMcp: true } })] })?.instanceId).toBe("full");
    expect(resolveAutomaticSelection({ ...input, candidates: ineligible })).toBeNull();
  });
});

describe("resolveAutomaticSelection", () => {
  it.each([
    ["claudeAgent", "claude-sonnet-5", "high"],
    ["codex", "gpt-6-astra", "low"],
    ["codex", "gpt-5.6-terra", "medium"],
    ["grokAgent", "grok-4.6", "high"],
  ])("gives a new bot the %s default effort", (driverKind, defaultModel, effort) => {
    expect(resolveAutomaticSelection({ candidates: [candidate("engine", {
      driverKind, defaultModel, effortLevels: ["low", "medium", "high", "xhigh", "max"],
    })] })).toEqual({ instanceId: "engine", model: defaultModel, mode: "automatic", effort });
  });

  it("uses configured order without provider-name preferences", () => {
    expect(
      resolveAutomaticSelection({ candidates: [candidate("second"), candidate("claude")] }),
    ).toMatchObject({ mode: "automatic", instanceId: "second", model: "second-default" });
  });

  it("preserves a supported saved effort", () => {
    expect(resolveAutomaticSelection({
      candidates: [candidate("grok", { driverKind: "grokAgent", defaultModel: "grok-4.6", effortLevels: ["low", "medium", "high"] })],
      current: { instanceId: "grok", model: "grok-4.6", mode: "automatic", effort: "medium" },
    })?.effort).toBe("medium");
  });

  it("keeps the engine and model that last ran this task", () => {
    expect(
      resolveAutomaticSelection({
        candidates: [candidate("first"), candidate("steady")],
        current: { mode: "automatic", instanceId: "first", model: "first-default" },
        continuity: { instanceId: "steady", model: "steady-long-task" },
      }),
    ).toMatchObject({ instanceId: "steady", model: "steady-long-task" });
  });

  it("filters unavailable and incapable engines", () => {
    expect(
      resolveAutomaticSelection({
        candidates: [
          candidate("offline", { available: false, capabilities: { browserMcp: true } }),
          candidate("plain"),
          candidate("browser", { capabilities: { browserMcp: true } }),
        ],
        required: ["browserMcp"],
      }),
    ).toMatchObject({ instanceId: "browser" });
  });

  it("returns null when no working engine meets the job", () => {
    expect(
      resolveAutomaticSelection({
        candidates: [candidate("plain")],
        required: ["computerMcp"],
      }),
    ).toBeNull();
  });
});
