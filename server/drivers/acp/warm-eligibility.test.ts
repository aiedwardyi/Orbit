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
        { ...base, toolsKey: warmToolsKey({ agents: { command: "a", args: [], env: {} } }) },
        { ...base, toolsKey: warmToolsKey({ agents: { command: "b", args: [], env: {} } }) },
        "sess-1",
        "sess-1",
      ),
    ).toBe(false);
  });

  it("rejects different threads (no cross-bot pooling)", () => {
    expect(canReuseWarmSession(base, { ...base, threadId: "t2" }, "sess-1", "sess-1")).toBe(false);
  });

  it("distinguishes composio.env keys/values that share =/, characters", () => {
    const a = warmToolsKey({ composio: { command: "c", args: [], env: { "a,b": "c" } } });
    const b = warmToolsKey({ composio: { command: "c", args: [], env: { a: "b,c" } } });
    expect(a).not.toBe(b);
  });

  it("distinguishes space-ambiguous args for composio / localComputer / agents", () => {
    // ["a b"] vs ["a","b"] collided under join(" ")
    expect(
      warmToolsKey({ composio: { command: "c", args: ["a b"], env: {} } }),
    ).not.toBe(
      warmToolsKey({ composio: { command: "c", args: ["a", "b"], env: {} } }),
    );
    expect(
      warmToolsKey({ localComputer: { command: "lc", args: ["a b"], env: {} } }),
    ).not.toBe(
      warmToolsKey({ localComputer: { command: "lc", args: ["a", "b"], env: {} } }),
    );
    expect(
      warmToolsKey({ agents: { command: "ag", args: ["a b"], env: {} } }),
    ).not.toBe(
      warmToolsKey({ agents: { command: "ag", args: ["a", "b"], env: {} } }),
    );
    // also the classic flag/value-with-space case from review
    expect(
      warmToolsKey({ composio: { command: "c", args: ["--flag", "value with space"], env: {} } }),
    ).not.toBe(
      warmToolsKey({ composio: { command: "c", args: ["--flag value", "with space"], env: {} } }),
    );
  });

  it("distinguishes browser configs that share only presence", () => {
    // opaque "browser:1" collided every mounted browser MCP
    expect(
      warmToolsKey({
        browser: { command: "node", args: ["proxy.js"], env: { OMB_BOT_ID: "a", OMB_BROWSER_PROFILE: "" } },
      }),
    ).not.toBe(
      warmToolsKey({
        browser: { command: "node", args: ["proxy.js"], env: { OMB_BOT_ID: "b", OMB_BROWSER_PROFILE: "guest" } },
      }),
    );
    expect(
      warmToolsKey({ browser: { command: "node", args: ["a b"], env: {} } }),
    ).not.toBe(
      warmToolsKey({ browser: { command: "node", args: ["a", "b"], env: {} } }),
    );
  });

  it("distinguishes U+001F inside fingerprint fields", () => {
    // prior join("\u001f") collided when a field itself contained U+001F
    const sep = "\u001f";
    expect(
      warmFingerprint({ ...base, threadId: `a${sep}b`, cwd: "c" }),
    ).not.toBe(
      warmFingerprint({ ...base, threadId: "a", cwd: `b${sep}c` }),
    );
    expect(
      warmFingerprint({ ...base, cli: `x${sep}y`, argsKey: "z" }),
    ).not.toBe(
      warmFingerprint({ ...base, cli: "x", argsKey: `y${sep}z` }),
    );
  });


  it("distinguishes phone / dweb / computer token drift", () => {
    expect(
      warmToolsKey({ phone: { command: "adb", args: [], env: { A: "1" } } }),
    ).not.toBe(
      warmToolsKey({ phone: { command: "adb", args: [], env: { A: "2" } } }),
    );
    expect(
      warmToolsKey({ dweb: { url: "http://127.0.0.1:1" } }),
    ).not.toBe(
      warmToolsKey({ dweb: { url: "http://127.0.0.1:2" } }),
    );
    expect(
      warmToolsKey({ computer: { boxId: "b1", token: "t1" } }),
    ).not.toBe(
      warmToolsKey({ computer: { boxId: "b1", token: "t2" } }),
    );
  });

});
