import { describe, expect, it } from "vitest";

import { defaultModelSelection } from "./default-engine";
import type { InstanceInfo } from "@/state/store";

const RETIRED_KINDS = ["grok", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent", "qwenAgent", "hermesAgent", "openai-compat", "piAgent", "minimax", "opencodeGo"];

const engine = (
  instanceId: string,
  extra: Partial<InstanceInfo> = {},
): InstanceInfo =>
  // SAFETY: the resolver reads only snapshot.state, models.default and rateLimits.windows.
  ({
    instanceId,
    driverKind: "testAgent",
    displayName: instanceId,
    snapshot: { state: "available" },
    models: { default: `${instanceId}-model`, options: [] },
    ...extra,
  }) as InstanceInfo;

describe("defaultModelSelection", () => {
  it("returns null with no snapshot yet", () => {
    expect(defaultModelSelection(undefined)).toBeNull();
    expect(defaultModelSelection([])).toBeNull();
  });

  it("skips unavailable engines and ones with no default model", () => {
    const instances = [
      engine("down", { snapshot: { state: "unavailable", reason: "no CLI" } }),
      engine("empty", { models: { default: "", options: [] } }),
      engine("ready"),
    ];
    expect(defaultModelSelection(instances)).toEqual({
      mode: "automatic",
      instanceId: "ready",
      model: "ready-model",
    });
  });

  it.each(RETIRED_KINDS)("never picks a retired %s engine a cached snapshot calls available", (driverKind) => {
    expect(defaultModelSelection([engine("old", { driverKind }), engine("ready")])?.instanceId).toBe("ready");
    expect(defaultModelSelection([engine("old", { driverKind })])).toBeNull();
  });

  it("prefers a non-exhausted engine but still falls back to an eligible one", () => {
    const spent = engine("spent", {
      rateLimits: {
        windows: [{ id: "five_hour", usedPercent: 100, resetsAt: null }],
        observedAt: new Date(0).toISOString(),
      },
    });
    expect(defaultModelSelection([spent, engine("fresh")])?.instanceId).toBe("fresh");
    expect(defaultModelSelection([spent])?.instanceId).toBe("spent");
  });

  it("keeps an engine whose only spent window is model-specific", () => {
    const opus = engine("opus", {
      rateLimits: {
        windows: [{ id: "five_hour", usedPercent: 20, resetsAt: null }, { id: "seven_day_opus", usedPercent: 100, resetsAt: null }],
        observedAt: new Date(0).toISOString(),
      },
    });
    expect(defaultModelSelection([opus, engine("other")])?.instanceId).toBe("opus");
  });

  it("treats a past reset as usable again", () => {
    const reset = engine("reset", {
      rateLimits: {
        windows: [{ id: "five_hour", usedPercent: 100, resetsAt: Date.now() - 1_000 }],
        observedAt: new Date(0).toISOString(),
      },
    });
    expect(defaultModelSelection([reset])?.instanceId).toBe("reset");
  });
});
