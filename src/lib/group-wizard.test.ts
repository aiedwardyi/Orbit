import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import {
  botNameFromJob,
  groupCreatePayload,
  isEngineConnected,
  newBotPayload,
  suggestEngine,
  wizardEngineOptions,
} from "./group-wizard";

const RETIRED_KINDS = ["grok", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent", "qwenAgent", "hermesAgent", "openai-compat", "piAgent", "minimax", "opencodeGo"];

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
  it.each(RETIRED_KINDS)("never prefers a connected retired %s engine", (kind) => {
    const instances = [engine("old-1", kind), engine("codex-1", "codex")];
    expect(suggestEngine(instances, [kind])).toEqual({ instance: instances[1], substituted: true });
    expect(suggestEngine(instances, ["codex"])?.instance.instanceId).toBe("codex-1");
  });

  it("skips a disconnected preferred engine and marks the substitute", () => {
    const instances = [engine("muse-1", "museAgent", "available", false), engine("codex-1", "codex")];
    const pick = suggestEngine(instances, ["museAgent"])!;
    expect(pick.instance.instanceId).toBe("codex-1");
    expect(pick.substituted).toBe(true);
  });

  it("returns null when nothing is connected", () => {
    expect(suggestEngine([engine("gem-1", "geminiAgent", "unavailable")], ["geminiAgent"])).toBeNull();
    expect(suggestEngine([], ["codex"])).toBeNull();
  });

  it.each(RETIRED_KINDS)("skips a retired %s engine when substituting for a missing preferred kind", (kind) => {
    const instances = [engine("old-1", kind), engine("ag-1", "antigravityAgent")];
    const pick = suggestEngine(instances, ["codex"])!;
    expect(pick.instance.instanceId).toBe("ag-1");
    expect(pick.substituted).toBe(true);
  });

  it.each(RETIRED_KINDS)("returns null when only a retired %s fallback engine is connected", (kind) => {
    expect(suggestEngine([engine("old-1", kind)], ["codex"])).toBeNull();
  });

  it("still substitutes a foreign unknown engine", () => {
    expect(suggestEngine([engine("future-1", "futureAgent")], ["codex"])?.instance.instanceId).toBe("future-1");
  });

  it.each(RETIRED_KINDS)("never lists a retired %s engine, even as the current pick", (kind) => {
    const instances = [engine("old-1", kind), engine("codex-1", "codex")];
    expect(wizardEngineOptions(instances, instances[0]!).map((i) => i.instanceId)).toEqual(["codex-1"]);
  });

  it("keeps a foreign unknown current pick selectable", () => {
    const instances = [engine("future-1", "futureAgent", "unavailable"), engine("codex-1", "codex")];
    expect(wizardEngineOptions(instances, instances[0]!).map((i) => i.instanceId)).toEqual(["future-1", "codex-1"]);
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
