import { describe, expect, it } from "vitest";

import {
  buildResumeFallback,
  buildTurnContext,
  countLastTurnToolRounds,
  countSessionToolRounds,
  engineIsFresh,
  nativeSessionTokenBudget,
  PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT,
  PRE_COMPACT_TOOL_ROUND_LIMIT,
  shouldRecycleProviderSession,
  taskRecordBlock,
} from "./turn-context.ts";

const transcript = [
  { role: "user" as const, text: "my dog is named Biscuit" },
  { role: "assistant" as const, text: "Noted — Biscuit." },
];

describe("buildTurnContext", () => {
  it("passes text through untouched on a plain resumed turn", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: true });
  });

  it("replays inline on rewind, exactly like the existing behaviour", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: true, fresh: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("rewound this conversation");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("replays inline for a fresh engine with prior history — the model-switch fix", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: true, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound"); // distinct marker, distinct preamble
    expect(out.turnText).toContain("Assistant: Noted — Biscuit.");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("never wraps for native-replay drivers — they get history via SendTurnInput.transcript", () => {
    for (const flags of [{ rewound: true, fresh: false }, { rewound: false, fresh: true }]) {
      const out = buildTurnContext({ text: "hi", transcript, ...flags, replaysNatively: true });
      expect(out.turnText).toBe("hi");
    }
  });

  it("does not wrap a fresh engine on an empty thread — nothing to replay", () => {
    const out = buildTurnContext({ text: "hi", transcript: [], rewound: false, fresh: true, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: false });
  });

  it("recycles the provider session when Orbit compacted the transcript", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      recycled: true,
      recycleReason: "compaction",
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("Orbit compacted this conversation");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText).not.toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound this conversation");
    expect(out.turnText.endsWith("continue")).toBe(true);
  });

  it("keeps Stop recovery on an uncompacted thread as a native resume", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      recycled: false,
      replaysNatively: false,
      recovering: true,
      taskRecord: {
        goal: "Publish the weekly brief",
        plan: [{ step: "Verify citations", status: "active" as const }],
        completed: [],
        blockers: [],
        nextAction: "Verify citations",
      },
    });
    expect(out.resume).toBe(true);
    expect(out.turnText).toContain("Orbit task record");
  });

  it("injects compacted history plus the task record after Stop on a compacted thread", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      recycled: true,
      recycleReason: "compaction",
      replaysNatively: false,
      recovering: true,
      taskRecord: {
        goal: "Publish the weekly brief",
        plan: [{ step: "Verify citations", status: "active" as const }],
        completed: [],
        blockers: [],
        nextAction: "Verify citations",
      },
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("Orbit compacted this conversation");
    expect(out.turnText).toContain("Orbit task record");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
  });

  it("keeps the recycle preamble on a later compacted turn after cursors were cleared", () => {
    const out = buildTurnContext({
      text: "next",
      transcript,
      rewound: false,
      fresh: true,
      recycled: true,
      recycleReason: "compaction",
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("Orbit compacted this conversation");
    expect(out.turnText).not.toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound this conversation");
    expect(out.turnText.endsWith("next")).toBe(true);
  });

  it("lets a rewind preamble win over session recycle", () => {
    const out = buildTurnContext({
      text: "hi",
      transcript,
      rewound: true,
      fresh: false,
      recycled: true,
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("rewound this conversation");
    expect(out.turnText).not.toContain("Orbit compacted this conversation");
  });

  it("uses a session-bound preamble when recycling before the first compact", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      recycled: true,
      recycleReason: "session-fat",
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("fresh provider session");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText).not.toContain("Orbit compacted this conversation");
    expect(out.turnText).not.toContain("joining this conversation");
    expect(out.turnText.endsWith("continue")).toBe(true);
  });

  it("does not claim compaction when recycled without a reason", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      recycled: true,
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("fresh provider session");
    expect(out.turnText).not.toContain("Orbit compacted this conversation");
  });

  it("injects the durable task record at recovery boundaries", () => {
    const taskRecord = {
      goal: "Publish the weekly brief",
      plan: [{ step: "Verify citations", status: "active" as const }],
      completed: [{ note: "Drafted five sections" }],
      blockers: [],
      nextAction: "Verify citations",
    };
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      replaysNatively: false,
      taskRecord,
      recovering: true,
    });

    expect(out.resume).toBe(true);
    expect(out.turnText).toContain("Orbit task record");
    expect(out.turnText).toContain("Goal: Publish the weekly brief");
    expect(out.turnText.endsWith("continue")).toBe(true);
  });

  it("injects the task record when the replay tail is capped", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      replaysNatively: true,
      contextCapped: true,
      taskRecord: {
        goal: "Research competitors",
        plan: [],
        completed: [],
        blockers: [],
        nextAction: "Compare pricing",
      },
    });

    expect(out.resume).toBe(true);
    expect(out.turnText).toContain("Next action: Compare pricing");
  });

  it("builds a cursor-failure fallback from the task record, summary, and tail", () => {
    const text = buildResumeFallback({
      text: "continue",
      transcript: [
        { role: "assistant", text: "[Orbit durable context summary]\nEarlier evidence is report.json." },
        { role: "user", text: "The latest result is green." },
      ],
      taskRecord: {
        goal: "Ship the release",
        plan: [{ step: "Run smoke tests", status: "active" }],
        completed: [{ note: "Built the installer" }],
        evidence: [{ kind: "file", ref: "reports/smoke.json", note: "all checks passed" }],
        artifacts: [{ ref: "dist/orbit.exe", label: "Windows installer" }],
        blockers: [],
        nextAction: "Run smoke tests",
      },
    });

    expect(text).toContain("provider session could not be resumed");
    expect(text).toContain("Goal: Ship the release");
    expect(text).toContain("1. active: Run smoke tests");
    expect(text).toContain("reports/smoke.json");
    expect(text).toContain("dist/orbit.exe");
    expect(text).toContain("Earlier evidence is report.json");
    expect(text).toContain("The latest result is green.");
    expect(text.endsWith("continue")).toBe(true);
  });

  it("bounds the task record while retaining every continuity field", () => {
    const secret = `sk-${"q".repeat(32)}`;
    const text = taskRecordBlock({
      goal: `Ship the release ${"detail ".repeat(100)}`,
      plan: [{ step: "Run smoke tests", status: "active" }],
      completed: [{ note: "Built the installer" }],
      evidence: [{ kind: "file", ref: `reports/${secret}.json` }],
      artifacts: [{ ref: "dist/orbit.exe", label: "Windows installer" }],
      blockers: [{ note: "Signing approval" }],
      nextAction: `Use ${secret}`,
    }, 512);

    expect(Array.from(text).length).toBeLessThanOrEqual(512);
    for (const label of ["Goal:", "Plan:", "Next action:", "Done recently:", "Evidence:", "Artifacts:", "Blockers:"]) {
      expect(text).toContain(label);
    }
    expect(text).not.toContain(secret);
  });
});

describe("shouldRecycleProviderSession", () => {
  it("recycles once Orbit has a compacted projection and the branch is current", () => {
    expect(shouldRecycleProviderSession({ compacted: true, rewound: false })).toBe(true);
    expect(shouldRecycleProviderSession({ compacted: true })).toBe(true);
  });

  it("leaves native resume in place before compaction and after a rewind", () => {
    expect(shouldRecycleProviderSession({ compacted: false, rewound: false })).toBe(false);
    expect(shouldRecycleProviderSession({ compacted: true, rewound: true })).toBe(false);
    expect(shouldRecycleProviderSession({ compacted: false, rewound: true })).toBe(false);
  });

  it("recycles a new user turn after a heavy tool soak, before the first compact", () => {
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnToolRounds: PRE_COMPACT_TOOL_ROUND_LIMIT,
    })).toBe(true);
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnToolRounds: PRE_COMPACT_TOOL_ROUND_LIMIT - 1,
    })).toBe(false);
  });

  it("recycles when settled tools since the last compact exceed the session budget", () => {
    expect(shouldRecycleProviderSession({
      compacted: false,
      sessionToolRounds: PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT,
    })).toBe(true);
    expect(shouldRecycleProviderSession({
      compacted: false,
      sessionToolRounds: PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT - 1,
    })).toBe(false);
  });

  it("recycles when the last turn's reported native input exceeds the session budget", () => {
    const nativeTokenBudget = nativeSessionTokenBudget(200_000);
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnInputTokens: nativeTokenBudget + 1,
      nativeTokenBudget,
    })).toBe(true);
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnInputTokens: nativeTokenBudget,
      nativeTokenBudget,
    })).toBe(false);
  });

  it("does not treat an unknown catalog window as an 8k native budget", () => {
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnInputTokens: 20_000,
      nativeTokenBudget: 0,
    })).toBe(false);
  });

  it("does not recycle Stop recovery on an uncompacted fat session", () => {
    expect(shouldRecycleProviderSession({
      compacted: false,
      recovering: true,
      lastTurnToolRounds: PRE_COMPACT_TOOL_ROUND_LIMIT + 8,
      sessionToolRounds: PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT + 8,
      lastTurnInputTokens: 200_000,
      nativeTokenBudget: 4_096,
    })).toBe(false);
  });

  it("still recycles Stop recovery after Orbit compacted", () => {
    expect(shouldRecycleProviderSession({
      compacted: true,
      recovering: true,
      lastTurnToolRounds: PRE_COMPACT_TOOL_ROUND_LIMIT,
    })).toBe(true);
  });
});

describe("countLastTurnToolRounds", () => {
  it("counts settled tools after the previous user line, skipping the new send", () => {
    const messages = [
      { id: "u1", role: "user" as const, kind: "text" as const },
      { id: "t1", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "t2", kind: "activity" as const, tool: { name: "Bash", ok: true } },
      { id: "a1", role: "bot" as const, kind: "text" as const },
      { id: "u2", role: "user" as const, kind: "text" as const },
    ];
    expect(countLastTurnToolRounds(messages, new Set(["u2"]))).toBe(2);
  });

  it("ignores in-flight chips and tools from earlier turns", () => {
    const messages = [
      { id: "u0", role: "user" as const, kind: "text" as const },
      { id: "old", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "u1", role: "user" as const, kind: "text" as const },
      { id: "pending", kind: "activity" as const, tool: { name: "Read" } },
      { id: "t1", kind: "activity" as const, tool: { name: "Grep", ok: false } },
    ];
    expect(countLastTurnToolRounds(messages)).toBe(1);
  });
});

describe("countSessionToolRounds", () => {
  it("counts settled tools after the latest compaction marker", () => {
    const messages = [
      { id: "old", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "c1", kind: "compaction" as const },
      { id: "t1", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "t2", kind: "activity" as const, tool: { name: "Bash", ok: true } },
      { id: "u2", role: "user" as const, kind: "text" as const },
    ];
    expect(countSessionToolRounds(messages, new Set(["u2"]))).toBe(2);
  });

  it("counts the whole uncompacted thread when there is no marker", () => {
    const messages = [
      { id: "t1", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "t2", kind: "activity" as const, tool: { name: "Bash", ok: true } },
      { id: "skip", kind: "activity" as const, tool: { name: "Grep", ok: true } },
    ];
    expect(countSessionToolRounds(messages, new Set(["skip"]))).toBe(2);
  });

  it("restarts the session count after a recycle watermark", () => {
    const messages = [
      { id: "old", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "bound", role: "user" as const, kind: "text" as const },
      { id: "t1", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "next", role: "user" as const, kind: "text" as const },
    ];
    expect(countSessionToolRounds(messages, new Set(["next"]), "bound")).toBe(1);
  });

  it("lets a later compaction marker win over an earlier recycle watermark", () => {
    const messages = [
      { id: "old", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "bound", role: "user" as const, kind: "text" as const },
      { id: "mid", kind: "activity" as const, tool: { name: "Bash", ok: true } },
      { id: "c1", kind: "compaction" as const },
      { id: "t1", kind: "activity" as const, tool: { name: "Grep", ok: true } },
    ];
    expect(countSessionToolRounds(messages, undefined, "bound")).toBe(1);
  });
});

describe("nativeSessionTokenBudget", () => {
  it("returns zero for an unknown or invalid window instead of the 16k fallback", () => {
    expect(nativeSessionTokenBudget(0)).toBe(0);
    expect(nativeSessionTokenBudget(-1)).toBe(0);
    expect(nativeSessionTokenBudget(200_000)).toBe(100_000);
  });
});

describe("engineIsFresh", () => {
  const withUser = transcript;
  const greetingOnly = [{ role: "assistant" as const, text: "Hey — I'm Wren. Nice to meet you." }];

  it("is false when the same instance ran the last turn and has a cursor", () => {
    expect(engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: "claude", lastModel: "sonnet", sessionModelSwitch: "in-session", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
  });

  it("is true when the same instance ran last but there is no cursor to resume", () => {
    expect(engineIsFresh({ instanceId: "pi", model: "pi", lastInstanceId: "pi", lastModel: "pi", sessionModelSwitch: "in-session", resumeCursors: {}, transcript: withUser })).toBe(true);
  });

  it("starts fresh when an unsupported engine changes model", () => {
    expect(engineIsFresh({ instanceId: "codex", model: "gpt-5.2", lastInstanceId: "codex", lastModel: "gpt-5.1", sessionModelSwitch: "unsupported", resumeCursors: { codex: "thread-1" }, transcript: withUser })).toBe(true);
  });

  it("keeps the native session when its engine supports model changes", () => {
    expect(engineIsFresh({ instanceId: "claude", model: "opus", lastInstanceId: "claude", lastModel: "sonnet", sessionModelSwitch: "in-session", resumeCursors: { claude: "session-1" }, transcript: withUser })).toBe(false);
  });

  it("keeps legacy sessions whose last model was not recorded", () => {
    expect(engineIsFresh({ instanceId: "codex", model: "gpt-5.2", lastInstanceId: "codex", lastModel: undefined, sessionModelSwitch: "unsupported", resumeCursors: { codex: "thread-1" }, transcript: withUser })).toBe(false);
  });

  it("is true when another instance ran the last turn — even if this one has an older cursor", () => {
    // the user's bug: claude had a session from days ago, antigravity took the
    // latest turn, switching back to claude must NOT resume the stale session
    expect(
      engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: "antigravity", lastModel: "gemini", sessionModelSwitch: "in-session", resumeCursors: { claude: "old", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });

  it("keeps continuity through an A to B to A engine sequence", () => {
    const cursors = { a: "a-old", b: "b-current" };
    expect(engineIsFresh({ instanceId: "b", model: "b1", lastInstanceId: "a", lastModel: "a1", sessionModelSwitch: "unsupported", resumeCursors: cursors, transcript: withUser })).toBe(true);
    expect(engineIsFresh({ instanceId: "a", model: "a1", lastInstanceId: "b", lastModel: "b1", sessionModelSwitch: "in-session", resumeCursors: cursors, transcript: withUser })).toBe(true);
  });

  it("replays after compaction when the bounded tail contains only assistant entries", () => {
    expect(engineIsFresh({
      instanceId: "a",
      model: "a1",
      lastInstanceId: "b",
      lastModel: "b1",
      sessionModelSwitch: "in-session",
      resumeCursors: { a: "a-old", b: "b-current" },
      transcript: [{ role: "assistant", text: "summary and tool outcomes" }],
      hasPriorUserTurn: true,
    })).toBe(true);
  });

  it("is true for an instance that has never run this thread", () => {
    expect(engineIsFresh({ instanceId: "codex", model: "gpt-5.2", lastInstanceId: "claude", lastModel: "sonnet", sessionModelSwitch: "unsupported", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
  });

  it("is false on a brand-new bot: the seeded greeting alone is nothing to join", () => {
    expect(engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "in-session", resumeCursors: {}, transcript: greetingOnly })).toBe(false);
    expect(engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "in-session", resumeCursors: {}, transcript: [] })).toBe(false);
  });

  it("replays a stateless engine only after a prior user turn", () => {
    const stateless = {
      instanceId: "box",
      model: "box",
      lastInstanceId: "box",
      lastModel: "box",
      sessionModelSwitch: "in-session" as const,
      resumeCursors: { box: "ignored" },
      resumeCursor: false,
    };
    expect(engineIsFresh({ ...stateless, transcript: greetingOnly })).toBe(false);
    expect(engineIsFresh({ ...stateless, transcript: withUser })).toBe(true);
  });

  it("legacy task without lastInstanceId: trusts a lone cursor for this instance, replays otherwise", () => {
    // one cursor, ours — pre-upgrade single-engine thread, keep resuming
    expect(engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "in-session", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
    // one cursor, someone else's — we never ran here
    expect(engineIsFresh({ instanceId: "codex", model: "gpt-5.2", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "unsupported", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
    // two cursors — can't tell who ran last; replaying is the safe side
    expect(
      engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "in-session", resumeCursors: { claude: "s1", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });
});
