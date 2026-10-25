import { describe, expect, it } from "vitest";

import {
  firstLaunchConnectInstances,
  friendsDriverRank,
  isEmptyEngineLaunch,
  isEngineRailOpen,
  isFriendsCliEngine,
  isFriendsEngine,
  splitEngineRail,
  splitFriendsEngines,
  showFriendsLocalZoo,
  starterConnectEngines,
  visibleFriendsRail,
} from "./engine-rail";

const RETIRED_KINDS = ["grok", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent", "qwenAgent", "hermesAgent", "openai-compat", "piAgent", "minimax", "opencodeGo"];

describe("isEngineRailOpen", () => {
  it("shows the Models rail when more than one featured engine is present", () => {
    expect(isEngineRailOpen({ featuredCount: 5 })).toBe(true);
  });

  it("does not open a rail when there is only one featured engine", () => {
    expect(isEngineRailOpen({ featuredCount: 1 })).toBe(false);
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

  it("drops retired kinds from both groups and keeps foreign ones", () => {
    const { subscription, custom } = splitEngineRail([
      { instanceId: "claude", driverKind: "claudeAgent" },
      ...RETIRED_KINDS.map((driverKind) => ({ instanceId: driverKind, driverKind })),
      ...RETIRED_KINDS.map((driverKind) => ({ access: "custom", instanceId: `${driverKind}-local`, driverKind })),
      { access: "custom", instanceId: "future", driverKind: "futureAgent" },
    ]);
    expect(subscription.map((row) => row.instanceId)).toEqual(["claude"]);
    expect(custom.map((row) => row.instanceId)).toEqual(["future"]);
  });
});

describe("splitFriendsEngines", () => {
  it("keeps the featured rail in Claude → Codex → Grok → Antigravity → Meta Muse order", () => {
    const { friends, rest } = splitFriendsEngines([
      { instanceId: "claude", driverKind: "claudeAgent" },
      { instanceId: "kimi", driverKind: "kimiAgent" },
      { instanceId: "codex", driverKind: "codex" },
      { instanceId: "qwen", driverKind: "qwenAgent" },
      { instanceId: "grok", driverKind: "grokAgent" },
      { instanceId: "gemini", driverKind: "geminiAgent" },
      { instanceId: "antigravity", driverKind: "antigravityAgent" },
      { instanceId: "cursor", driverKind: "cursorAgent" },
      { instanceId: "muse", driverKind: "museAgent" },
      { instanceId: "hermes", driverKind: "hermesAgent" },
    ]);
    expect(friends.map((row) => row.instanceId)).toEqual([
      "claude",
      "codex",
      "grok",
      "antigravity",
      "muse",
    ]);
    expect(rest.map((row) => row.instanceId)).toEqual([]);
  });

  it("does not promote a local CLI override onto the featured rail", () => {
    const { friends, rest } = splitFriendsEngines([
      { instanceId: "local", driverKind: "localAgent", cli: "/opt/local/bin/agent" },
      { instanceId: "pi", driverKind: "piAgent" },
    ]);
    expect(friends.map((row) => row.instanceId)).toEqual([]);
    expect(rest.map((row) => row.instanceId)).toEqual(["local"]);
  });

  it("drops every retired kind and keeps foreign ones in the rest", () => {
    const { friends, rest } = splitFriendsEngines([
      { instanceId: "claude", driverKind: "claudeAgent" },
      ...RETIRED_KINDS.map((driverKind) => ({ instanceId: driverKind, driverKind })),
      { instanceId: "future", driverKind: "futureAgent" },
    ]);
    expect(friends.map((row) => row.instanceId)).toEqual(["claude"]);
    expect(rest.map((row) => row.instanceId)).toEqual(["future"]);
  });

  it("treats Gemini API as off-rail and Antigravity as the Gemini CLI slot", () => {
    expect(isFriendsEngine({ driverKind: "geminiAgent" })).toBe(false);
    expect(isFriendsEngine({ driverKind: "antigravityAgent" })).toBe(true);
    expect(isFriendsCliEngine({ driverKind: "antigravityAgent" })).toBe(true);
    expect(isFriendsCliEngine({ driverKind: "museAgent" })).toBe(true);
    expect(friendsDriverRank("claudeAgent")).toBeLessThan(friendsDriverRank("codex"));
    expect(friendsDriverRank("codex")).toBeLessThan(friendsDriverRank("grokAgent"));
    expect(friendsDriverRank("grokAgent")).toBeLessThan(friendsDriverRank("antigravityAgent"));
    expect(friendsDriverRank("antigravityAgent")).toBeLessThan(friendsDriverRank("museAgent"));
  });
});

describe("visibleFriendsRail", () => {
  const fleet = [
    { instanceId: "claude", driverKind: "claudeAgent" },
    { instanceId: "kimi", driverKind: "kimiAgent" },
    { instanceId: "codex", driverKind: "codex" },
    { instanceId: "grok", driverKind: "grokAgent" },
    { instanceId: "gemini", driverKind: "geminiAgent" },
    { instanceId: "muse", driverKind: "museAgent" },
    { instanceId: "antigravity", driverKind: "antigravityAgent" },
    { instanceId: "cursor", driverKind: "cursorAgent" },
  ];

  it("shows only the featured five, in order, with no zoo expander", () => {
    const folded = visibleFriendsRail(fleet, { showAll: false, activeId: "grok" });
    expect(folded.visible.map((row) => row.instanceId)).toEqual([
      "claude",
      "codex",
      "grok",
      "antigravity",
      "muse",
    ]);
    expect(folded.hiddenCount).toBe(0);

    const withActiveRest = visibleFriendsRail(fleet, { showAll: false, activeId: "kimi" });
    expect(withActiveRest.visible.map((row) => row.instanceId)).toEqual([
      "claude",
      "codex",
      "grok",
      "antigravity",
      "muse",
    ]);
    expect(withActiveRest.hiddenCount).toBe(0);
  });

  it("does not reveal the rest after Show all while the zoo flag is off", () => {
    const opened = visibleFriendsRail(fleet, { showAll: true, activeId: "grok" });
    expect(opened.visible.map((row) => row.instanceId)).toEqual([
      "claude",
      "codex",
      "grok",
      "antigravity",
      "muse",
    ]);
    expect(opened.hiddenCount).toBe(0);
  });
});

describe("showFriendsLocalZoo", () => {
  it("keeps Use a local model quiet unless the selected engine already has local options", () => {
    expect(showFriendsLocalZoo({ customCount: 0 })).toBe(false);
    expect(showFriendsLocalZoo({ customCount: 2 })).toBe(true);
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

  it("stays empty when only retired engines claim to be available", () => {
    expect(isEmptyEngineLaunch(RETIRED_KINDS.map((driverKind) => ({ driverKind, snapshot: { state: "available" } })))).toBe(true);
    expect(isEmptyEngineLaunch([{ driverKind: "futureAgent", snapshot: { state: "available" } }])).toBe(false);
  });

  it("keeps the five shipped engines, in fleet order, from the default-fleet zoo", () => {
    const starter = starterConnectEngines([
      { instanceId: "gemini", driverKind: "geminiAgent", install: { docsUrl: "https://gemini" } },
      { instanceId: "claude", driverKind: "claudeAgent", install: { docsUrl: "https://claude" } },
      { instanceId: "kimi", driverKind: "kimiAgent", install: { docsUrl: "https://kimi" } },
      { instanceId: "codex", driverKind: "codex", install: { docsUrl: "https://codex" } },
      { instanceId: "grok", driverKind: "grokAgent", install: { docsUrl: "https://grok" } },
      { instanceId: "antigravity", driverKind: "antigravityAgent", install: { docsUrl: "https://antigravity" } },
      { instanceId: "muse", driverKind: "museAgent", install: { docsUrl: "https://muse" } },
      { instanceId: "cursor", driverKind: "cursorAgent" },
    ]);
    expect(starter.map((row) => row.instanceId)).toEqual(["claude", "codex", "grok", "antigravity", "muse"]);
  });

  it("leads the first-launch connect screen with Claude whatever order the zoo arrives in", () => {
    const starter = starterConnectEngines([
      { instanceId: "muse", driverKind: "museAgent", install: { docsUrl: "https://muse" } },
      { instanceId: "grok", driverKind: "grokAgent", install: { docsUrl: "https://grok" } },
      { instanceId: "antigravity", driverKind: "antigravityAgent", install: { docsUrl: "https://antigravity" } },
      { instanceId: "codex", driverKind: "codex", install: { docsUrl: "https://codex" } },
      { instanceId: "claude", driverKind: "claudeAgent", install: { docsUrl: "https://claude" } },
    ]);
    expect(starter.map((row) => row.instanceId)).toEqual(["claude", "codex", "grok", "antigravity", "muse"]);
  });

  it("drops a starter engine that has no connect flow", () => {
    expect(
      firstLaunchConnectInstances([
        { instanceId: "grok", driverKind: "grokAgent" },
        { instanceId: "claude", driverKind: "claudeAgent", install: { docsUrl: "https://claude" } },
        { instanceId: "codex", driverKind: "codex", install: { docsUrl: "https://codex" } },
      ]).map((row) => row.instanceId),
    ).toEqual(["claude", "codex"]);
  });
});
