import { describe, expect, it } from "vitest";

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

describe("resolveAutomaticSelection", () => {
  it("uses configured order without provider-name preferences", () => {
    expect(
      resolveAutomaticSelection({ candidates: [candidate("second"), candidate("claude")] }),
    ).toMatchObject({ mode: "automatic", instanceId: "second", model: "second-default" });
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
