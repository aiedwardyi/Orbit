import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { RepeatDetector, callKey, inputDigest, repeatCall } from "./repeat-detector.ts";

const ask = (command: string): RuntimeEvent => ({
  eventId: "e",
  provider: "claude",
  threadId: "t1",
  createdAt: "",
  type: "request.opened",
  requestType: "permission",
  tool: "Bash",
  summary: command.slice(0, 200),
  inputDigest: inputDigest(command),
});

describe("callKey", () => {
  it("keys on tool plus arguments, normalizing whitespace, and ignores a bare tool name", () => {
    expect(callKey("Bash", "git   status\n")).toBe("Bash:git status");
    expect(callKey("Bash", "  git status ")).toBe("Bash:git status");
    expect(callKey("Bash", undefined)).toBeNull();
    expect(callKey("Bash", "")).toBeNull();
    // ACP titles that are just the tool name again carry no arguments
    expect(callKey("Bash", "Bash")).toBeNull();
    expect(callKey("Read", "Read src/index.ts")).toBe("Read:Read src/index.ts");
  });
});

describe("inputDigest", () => {
  it("hashes the whole object, ignoring key order", () => {
    const fetch = (prompt: string) => ({ url: "https://example.com", prompt, opts: { depth: 1 } });
    expect(inputDigest(fetch("a"))).not.toBe(inputDigest(fetch("b")));
    expect(inputDigest({ opts: { depth: 1 }, prompt: "a", url: "https://example.com" })).toBe(inputDigest(fetch("a")));
    expect(inputDigest({ edits: [{ newText: "a" }] })).not.toBe(inputDigest({ edits: [{ newText: "b" }] }));
  });
});

describe("repeatCall", () => {
  const chips = (commands: string[]) => {
    const d = new RepeatDetector({ thresholds: [5, 10, 20] });
    return commands.flatMap((command) => {
      const call = repeatCall(ask(command));
      return call && d.record("t1", call.key).threshold ? [call.label] : [];
    });
  };
  const opening = `python - <<'EOF'\n${"x = 1\n".repeat(40)}`;

  it("keeps apart asks that share their summary but differ later", () => {
    expect(chips([1, 2, 3, 4, 5].map((n) => `${opening}edit(${n})\nEOF`))).toEqual([]);
  });

  it("still flags the same full call five times", () => {
    const command = `${opening}edit(1)\nEOF`;
    expect(chips(Array(5).fill(command))).toEqual([callKey("Bash", command.slice(0, 200))]);
  });
});

describe("RepeatDetector", () => {
  it("fires once at each threshold for the same call in one thread", () => {
    const d = new RepeatDetector({ thresholds: [5, 10, 20] });
    const hits: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = d.record("t1", "Bash:git status");
      if (r.threshold) hits.push(r.threshold);
    }
    expect(hits).toEqual([5, 10, 20]);
    expect(d.record("t1", "Bash:git status").count).toBe(26);
  });

  it("keeps threads and calls apart", () => {
    const d = new RepeatDetector({ thresholds: [3] });
    for (let i = 0; i < 2; i++) d.record("t1", "Bash:a");
    for (let i = 0; i < 2; i++) d.record("t2", "Bash:a");
    expect(d.record("t1", "Bash:b").threshold).toBeUndefined();
    expect(d.record("t1", "Bash:a").threshold).toBe(3);
    expect(d.record("t2", "Bash:a").threshold).toBe(3);
  });

  it("forgets a thread on settle", () => {
    const d = new RepeatDetector({ thresholds: [3] });
    for (let i = 0; i < 2; i++) d.record("t1", "Bash:a");
    d.settle("t1");
    expect(d.record("t1", "Bash:a").count).toBe(1);
  });

  it("bounds distinct calls per thread and evicts the least recently seen", () => {
    const d = new RepeatDetector({ thresholds: [2], maxKeysPerThread: 2 });
    d.record("t1", "Bash:a");
    d.record("t1", "Bash:b");
    // Refresh a, so b is the least-recently-seen entry.
    expect(d.record("t1", "Bash:a").threshold).toBe(2);
    d.record("t1", "Bash:c");
    expect(d.record("t1", "Bash:a").count).toBe(3);
    expect(d.record("t1", "Bash:b").count).toBe(1);
  });

  it("rejects an invalid memory bound", () => {
    expect(() => new RepeatDetector({ thresholds: [2], maxKeysPerThread: 0 })).toThrow(/positive integer/);
  });
});
