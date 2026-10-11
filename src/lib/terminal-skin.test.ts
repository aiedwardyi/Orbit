import { describe, expect, it } from "vitest";

import { termElapsed, termMeter, termResultLine, termStepAria, termStepState, termVerb } from "./terminal-skin";

describe("termVerb", () => {
  it("maps tool names to Claude Code verbs across engines", () => {
    expect(termVerb("Edit")).toBe("Update");
    expect(termVerb("MultiEdit")).toBe("Update");
    expect(termVerb("edit")).toBe("Update");
    expect(termVerb("shell")).toBe("Bash");
    expect(termVerb("web_search")).toBe("Web Search");
    expect(termVerb("WebFetch")).toBe("Fetch");
    expect(termVerb("Agent")).toBe("Task");
  });

  it("keeps names it does not know", () => {
    expect(termVerb("Bash")).toBe("Bash");
    expect(termVerb("browser_click")).toBe("browser_click");
  });
});

describe("termResultLine", () => {
  it("settles into Done or Failed with the duration", () => {
    expect(termResultLine(termStepState(true), 1200)).toBe("Done (1.2s)");
    expect(termResultLine(termStepState(false), 400)).toBe("Failed (0.4s)");
    expect(termResultLine(termStepState(true), 62_000)).toBe("Done (1m 2s)");
  });

  it("is never empty without a duration", () => {
    expect(termResultLine("done", undefined)).toBe("Done");
    expect(termResultLine("failed", undefined)).toBe("Failed");
    expect(termResultLine(termStepState(undefined), 3000)).toBe("Running… (3.0s)");
  });
});

describe("termStepAria", () => {
  it("speaks state and seconds", () => {
    expect(termStepAria("done", 1234)).toEqual({ key: "term.step.ariaDone", seconds: 1.2 });
    expect(termStepAria("failed", undefined)).toEqual({ key: "term.step.ariaFailedBare" });
    expect(termStepAria("running", 500)).toEqual({ key: "term.step.ariaRunning" });
  });
});

describe("termElapsed", () => {
  it("prints the working line's clock", () => {
    expect(termElapsed(12_400)).toBe("12s");
    expect(termElapsed(158_000)).toBe("2m 38s");
    expect(termElapsed(-5)).toBe("0s");
  });
});

describe("termMeter", () => {
  const now = 1_000_000;
  const window = { id: "five_hour", usedPercent: 71, resetsAt: now + 60_000, windowMinutes: 300 };

  it("shows what's left by default", () => {
    expect(termMeter(window, now, "remaining")).toEqual({ id: "five_hour", kind: "session", percent: 29, bar: "▰▱▱▱▱" });
  });

  it("follows the used mode", () => {
    expect(termMeter(window, now, "used")).toMatchObject({ percent: 71, bar: "▰▰▰▰▱" });
  });

  it("empties the bar once the window has reset", () => {
    expect(termMeter({ ...window, resetsAt: now - 1 }, now, "remaining")).toMatchObject({ percent: null, bar: "▱▱▱▱▱" });
  });
});
