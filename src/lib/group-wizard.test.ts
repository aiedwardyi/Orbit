import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import {
  botNameFromJob,
  groupCreatePayload,
  isEngineConnected,
  newBotPayload,
  suggestEngine,
} from "./group-wizard";

const engine = (
  instanceId: string,
  driverKind: string,
  state: "available" | "unavailable" = "available",
  authenticated?: boolean,
): InstanceInfo => ({
  instanceId,
  driverKind,
  displayName: instanceId,
  snapshot: authenticated === undefined ? { state } : { state, authenticated },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
});

describe("wizard engine suggestion", () => {
  it("prefers Gemini first and Codex second when both are connected", () => {
    const instances = [engine("codex-1", "codex"), engine("gem-1", "geminiAgent")];
    expect(suggestEngine(instances, ["geminiAgent"])?.instance.instanceId).toBe("gem-1");
    expect(suggestEngine(instances, ["codex"])?.instance.instanceId).toBe("codex-1");
  });

  it("skips a disconnected preferred engine and marks the substitute", () => {
    const instances = [engine("gem-1", "geminiAgent", "available", false), engine("codex-1", "codex")];
    const pick = suggestEngine(instances, ["geminiAgent"])!;
    expect(pick.instance.instanceId).toBe("codex-1");
    expect(pick.substituted).toBe(true);
  });

  it("returns null when nothing is connected", () => {
    expect(suggestEngine([engine("gem-1", "geminiAgent", "unavailable")], ["geminiAgent"])).toBeNull();
    expect(suggestEngine([], ["codex"])).toBeNull();
  });

  it("treats missing auth as connected but explicit false as not", () => {
    expect(isEngineConnected(engine("a", "codex", "available", undefined))).toBe(true);
    expect(isEngineConnected(engine("b", "codex", "available", false))).toBe(false);
  });
});

describe("wizard naming and payloads", () => {
  it("names a bot from the first words of the job", () => {
    expect(botNameFromJob("help me plan a trip to japan soon")).toBe("Help me plan a trip");
    expect(botNameFromJob("  ")).toBe("");
  });

  it("posts the inline bot with its engine default model", () => {
    expect(newBotPayload("  review my code ", { instanceId: "gem-1", model: "gemini-3" })).toEqual({
      job: "review my code",
      name: "Review my code",
      modelSelection: { instanceId: "gem-1", model: "gemini-3" },
    });
  });

  it("creates everyone-replies groups with completed setup and no extras", () => {
    expect(groupCreatePayload("New group", ["b1", "b2"])).toEqual({
      name: "New group",
      memberIds: ["b1", "b2"],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    });
  });
});
