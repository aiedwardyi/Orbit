import { describe, expect, it } from "vitest";
import { canReuseWarmSession, warmFingerprint, warmToolsKey } from "./warm-eligibility.ts";

describe("warm-eligibility", () => {
  const base = {
    threadId: "t1",
    cwd: "C:\\work",
    sessionCwd: "C:\\work",
    model: "grok-4.6",
    effort: "high",
    approval: "ask",
    fullAuto: false,
    identity: "auth-hash",
    cli: "grok",
    argsKey: "agent|-m|grok-4.6|stdio",
    toolsKey: "",
  };

  it("matches identical follow-ups with the same resumeCursor", () => {
    expect(canReuseWarmSession(base, { ...base }, "sess-1", "sess-1")).toBe(true);
    expect(warmFingerprint(base)).toBe(warmFingerprint({ ...base }));
  });

  it("rejects missing resumeCursor (compaction starts a new session)", () => {
    expect(canReuseWarmSession(base, { ...base }, "sess-1", undefined)).toBe(false);
    expect(canReuseWarmSession(base, { ...base }, "sess-1", "")).toBe(false);
  });

  it("rejects a different resumeCursor (rewind / other session)", () => {
    expect(canReuseWarmSession(base, { ...base }, "sess-1", "sess-other")).toBe(false);
  });

  it("rejects cwd / model / effort / approval / tools / identity drift", () => {
    expect(canReuseWarmSession(base, { ...base, cwd: "D:\\other" }, "sess-1", "sess-1")).toBe(false);
    expect(canReuseWarmSession(base, { ...base, model: "grok-4.5" }, "sess-1", "sess-1")).toBe(false);
    expect(canReuseWarmSession(base, { ...base, effort: "low" }, "sess-1", "sess-1")).toBe(false);
    expect(canReuseWarmSession(base, { ...base, approval: "auto" }, "sess-1", "sess-1")).toBe(false);
    expect(canReuseWarmSession(base, { ...base, identity: "other-auth" }, "sess-1", "sess-1")).toBe(false);
    expect(
      canReuseWarmSession(
        { ...base, toolsKey: warmToolsKey({ agents: { command: "a", args: [] } }) },
        { ...base, toolsKey: warmToolsKey({ agents: { command: "b", args: [] } }) },
        "sess-1",
        "sess-1",
      ),
    ).toBe(false);
  });

  it("rejects different threads (no cross-bot pooling)", () => {
    expect(canReuseWarmSession(base, { ...base, threadId: "t2" }, "sess-1", "sess-1")).toBe(false);
  });

  it("distinguishes composio.env keys/values that share =/, characters", () => {
    const a = warmToolsKey({ composio: { command: "c", env: { "a,b": "c" } } });
    const b = warmToolsKey({ composio: { command: "c", env: { a: "b,c" } } });
    expect(a).not.toBe(b);
  });
});
