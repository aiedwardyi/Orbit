import { describe, expect, it } from "vitest";

import {
  firstLaunchConnectInstances,
  isEmptyEngineLaunch,
  isEngineRailOpen,
  splitEngineRail,
  splitFriendsEngines,
  showFriendsLocalZoo,
  starterConnectEngines,
  visibleFriendsRail,
} from "./engine-rail";

describe("isEngineRailOpen", () => {
  it("keeps the engine rail folded when idle", () => {
    expect(isEngineRailOpen({ instanceCount: 5, railOpen: false })).toBe(false);
  });

  it("does not open a rail when there is only one engine", () => {
    expect(isEngineRailOpen({ instanceCount: 1, railOpen: true })).toBe(false);
  });

  it("opens the rail when the user asks and more than one engine is present", () => {
    expect(isEngineRailOpen({ instanceCount: 2, railOpen: true })).toBe(true);
  });
});

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
  it("keeps the friends engines, including both Gemini routes and OpenCode, out front", () => {
    const { friends, rest } = splitFriendsEngines([
      { instanceId: "claude", driverKind: "claudeAgent" },
      { instanceId: "kimi", driverKind: "kimiAgent" },
      { instanceId: "codex", driverKind: "codex" },
      { instanceId: "qwen", driverKind: "qwenAgent" },
      { instanceId: "grok", driverKind: "grokAgent" },
      { instanceId: "gemini", driverKind: "geminiAgent" },
      { instanceId: "antigravity", driverKind: "antigravityAgent" },
      { instanceId: "cursor", driverKind: "cursorAgent" },
      { instanceId: "opencode", driverKind: "opencodeGo" },
      { instanceId: "hermes", driverKind: "hermesAgent" },
    ]);
    // Gemini counts once as an engine but twice as a driver. OpenCode is a
    // real driver (opencodeGo); Muse is not in the repo and stays out.
    expect(friends.map((row) => row.instanceId)).toEqual([
      "claude",
      "codex",
      "grok",
      "gemini",
      "antigravity",
      "opencode",
    ]);
    expect(rest.map((row) => row.instanceId)).toEqual(["kimi", "qwen", "cursor", "hermes"]);
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

describe("visibleFriendsRail", () => {
  const fleet = [
    { instanceId: "claude", driverKind: "claudeAgent" },
    { instanceId: "kimi", driverKind: "kimiAgent" },
    { instanceId: "codex", driverKind: "codex" },
    { instanceId: "grok", driverKind: "grokAgent" },
    { instanceId: "opencode", driverKind: "opencodeGo" },
    { instanceId: "cursor", driverKind: "cursorAgent" },
  ];

  it("hides the rest until Show all, and always keeps the active engine", () => {
    const folded = visibleFriendsRail(fleet, { showAll: false, activeId: "grok" });
    expect(folded.visible.map((row) => row.instanceId)).toEqual(["claude", "codex", "grok", "opencode"]);
    expect(folded.hiddenCount).toBe(2);

    const withActiveRest = visibleFriendsRail(fleet, { showAll: false, activeId: "kimi" });
    expect(withActiveRest.visible.map((row) => row.instanceId)).toEqual([
      "claude",
      "codex",
      "grok",
      "opencode",
      "kimi",
    ]);
    expect(withActiveRest.hiddenCount).toBe(1);
  });

  it("reveals the rest after Show all without reordering the friends already on the rail", () => {
    const opened = visibleFriendsRail(fleet, { showAll: true, activeId: "grok" });
    expect(opened.visible.map((row) => row.instanceId)).toEqual([
      "claude",
      "codex",
      "grok",
      "opencode",
      "kimi",
      "cursor",
    ]);
    expect(opened.hiddenCount).toBe(0);
  });
});

describe("showFriendsLocalZoo", () => {
  it("keeps the local zoo off the idle friends picker when overflow exists", () => {
    expect(showFriendsLocalZoo({
      showAllEngines: false,
      railShown: false,
      hasOverflow: true,
      canSwitchEngine: true,
    })).toBe(false);
  });

  it("opens the local zoo behind Show all, or when there is no overflow left to disclose", () => {
    expect(showFriendsLocalZoo({
      showAllEngines: true,
      railShown: true,
      hasOverflow: true,
      canSwitchEngine: true,
    })).toBe(true);
    expect(showFriendsLocalZoo({
      showAllEngines: false,
      railShown: true,
      hasOverflow: false,
      canSwitchEngine: true,
    })).toBe(true);
    expect(showFriendsLocalZoo({
      showAllEngines: false,
      railShown: false,
      hasOverflow: false,
      canSwitchEngine: false,
    })).toBe(true);
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
