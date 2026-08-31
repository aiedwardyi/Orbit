import { describe, expect, it } from "vitest";

import { buildResumeFallback, buildTurnContext, engineIsFresh, taskRecordBlock } from "./turn-context.ts";

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

  it("is true for an instance that has never run this thread", () => {
    expect(engineIsFresh({ instanceId: "codex", model: "gpt-5.2", lastInstanceId: "claude", lastModel: "sonnet", sessionModelSwitch: "unsupported", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
  });

  it("is false on a brand-new bot: the seeded greeting alone is nothing to join", () => {
    expect(engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "in-session", resumeCursors: {}, transcript: greetingOnly })).toBe(false);
    expect(engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "in-session", resumeCursors: {}, transcript: [] })).toBe(false);
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
