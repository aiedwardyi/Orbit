import { describe, expect, it } from "vitest";

import {
  firstLaunchConnectInstances,
  isEmptyEngineLaunch,
  splitEngineRail,
  splitFriendsEngines,
  starterConnectEngines,
} from "./engine-rail";

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
  it("keeps the four friends engines, across five drivers, out front", () => {
    const { friends, rest } = splitFriendsEngines([
      { instanceId: "claude", driverKind: "claudeAgent" },
      { instanceId: "kimi", driverKind: "kimiAgent" },
      { instanceId: "codex", driverKind: "codex" },
      { instanceId: "qwen", driverKind: "qwenAgent" },
      { instanceId: "grok", driverKind: "grokAgent" },
      { instanceId: "gemini", driverKind: "geminiAgent" },
      { instanceId: "antigravity", driverKind: "antigravityAgent" },
      { instanceId: "cursor", driverKind: "cursorAgent" },
    ]);
    // Gemini counts once as an engine but twice as a driver.
    expect(friends.map((row) => row.instanceId)).toEqual(["claude", "codex", "grok", "gemini", "antigravity"]);
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

describe("empty-engine first launch", () => {
  it("is empty only after instances arrive and none can run a bot", () => {
    expect(isEmptyEngineLaunch([])).toBe(false);
    expect(isEmptyEngineLaunch([
      { snapshot: { state: "unavailable" } },
      { snapshot: { state: "available" } },
    ])).toBe(false);
    expect(isEmptyEngineLaunch([
      { snapshot: { state: "unavailable" } },
      { snapshot: { state: "unavailable" } },
    ])).toBe(true);
  });

  it("keeps only Grok and Claude, Grok first, from the default-fleet zoo", () => {
    const starter = starterConnectEngines([
      { instanceId: "gemini", driverKind: "geminiAgent", install: { docsUrl: "https://gemini" } },
      { instanceId: "claude", driverKind: "claudeAgent", install: { docsUrl: "https://claude" } },
      { instanceId: "kimi", driverKind: "kimiAgent", install: { docsUrl: "https://kimi" } },
      { instanceId: "codex", driverKind: "codex", install: { docsUrl: "https://codex" } },
      { instanceId: "grok", driverKind: "grokAgent", install: { docsUrl: "https://grok" } },
      { instanceId: "antigravity", driverKind: "antigravityAgent", install: { docsUrl: "https://antigravity" } },
      { instanceId: "cursor", driverKind: "cursorAgent" },
    ]);
    expect(starter.map((row) => row.instanceId)).toEqual(["grok", "claude"]);
  });

  it("drops a starter engine that has no connect flow", () => {
    expect(
      firstLaunchConnectInstances([
        { instanceId: "grok", driverKind: "grokAgent" },
        { instanceId: "claude", driverKind: "claudeAgent", install: { docsUrl: "https://claude" } },
        { instanceId: "codex", driverKind: "codex", install: { docsUrl: "https://codex" } },
      ]).map((row) => row.instanceId),
    ).toEqual(["claude"]);
  });
});
