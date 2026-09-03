import { describe, expect, it } from "vitest";

import { splitEngineRail, splitFriendsEngines } from "./engine-rail";

describe("splitEngineRail", () => {
  it("keeps Cloud engines above Local engines", () => {
    const { subscription, custom } = splitEngineRail([
      { access: "subscription", instanceId: "claude" },
      { access: "custom", instanceId: "hermes" },
      { instanceId: "grok" },
      { access: "custom", instanceId: "qwen" },
    ]);
    expect(subscription.map((row) => row.instanceId)).toEqual(["claude", "grok"]);
    expect(custom.map((row) => row.instanceId)).toEqual(["hermes", "qwen"]);
  });

  it("hides the second group when nothing is custom-only", () => {
    const rows = [{ instanceId: "claude" }];
    expect(splitEngineRail(rows).custom).toEqual([]);
  });
});

describe("splitFriendsEngines", () => {
  it("keeps the four friends engines out front and folds the rest", () => {
    const { friends, rest } = splitFriendsEngines([
      { instanceId: "claude", driverKind: "claudeAgent" },
      { instanceId: "kimi", driverKind: "kimiAgent" },
      { instanceId: "codex", driverKind: "codex" },
      { instanceId: "qwen", driverKind: "qwenAgent" },
      { instanceId: "grok", driverKind: "grokAgent" },
      { instanceId: "antigravity", driverKind: "antigravityAgent" },
      { instanceId: "cursor", driverKind: "cursorAgent" },
    ]);
    expect(friends.map((row) => row.instanceId)).toEqual(["claude", "codex", "grok", "antigravity"]);
    expect(rest.map((row) => row.instanceId)).toEqual(["kimi", "qwen", "cursor"]);
  });

  it("never folds away an engine the user pointed at a binary", () => {
    const { friends, rest } = splitFriendsEngines([
      { instanceId: "hermes", driverKind: "hermesAgent", cli: "/opt/hermes/bin/hermes" },
      { instanceId: "pi", driverKind: "piAgent" },
    ]);
    expect(friends.map((row) => row.instanceId)).toEqual(["hermes"]);
    expect(rest.map((row) => row.instanceId)).toEqual(["pi"]);
  });
});
