import { describe, expect, it } from "vitest";

import { UTILITY_SHUTDOWN_TYPE, isUtilityShutdownMessage } from "./utility-parent.ts";

describe("utility parent shutdown messages", () => {
  it("recognizes the graceful stop request from Electron", () => {
    expect(isUtilityShutdownMessage({ type: UTILITY_SHUTDOWN_TYPE })).toBe(true);
    expect(isUtilityShutdownMessage({ type: "openmausbot:managed-composio" })).toBe(false);
    expect(isUtilityShutdownMessage(null)).toBe(false);
    expect(isUtilityShutdownMessage("openmausbot:shutdown")).toBe(false);
  });
});
