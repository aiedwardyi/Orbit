import { describe, expect, it, vi } from "vitest";

import { createMemoryHealthCheck, memoryNotice } from "./memory-health.ts";
import type { MemoryHealth } from "./workspace.ts";

const NOW = new Date(2026, 9, 16, 12).getTime();
const SINCE = new Date(2026, 9, 14, 9).getTime();
const HEALTHY: MemoryHealth = { longLines: 0, orphans: [] };

describe("memoryNotice", () => {
  it("names every problem in one line", () => {
    expect(memoryNotice({ longLines: 26, orphans: ["x.md"] }, { dropped: 4, since: SINCE })).toBe(
      "[Memory check: 26 lines are over 300 bytes; memory/x.md has no pointer line here; 4 auto notes since 10-14 were not saved because the file is full. Trim it this session.]",
    );
  });

  it("keeps only the parts that apply", () => {
    expect(memoryNotice({ longLines: 1, orphans: [] })).toBe("[Memory check: 1 line is over 300 bytes. Trim it this session.]");
    expect(memoryNotice(HEALTHY, { dropped: 1, since: SINCE })).toBe(
      "[Memory check: 1 auto note since 10-14 was not saved because the file is full. Trim it this session.]",
    );
    expect(memoryNotice({ longLines: 0, orphans: ["a.md", "b.md"] })).toBe(
      "[Memory check: memory/a.md and memory/b.md have no pointer line here. Add the pointer lines this session.]",
    );
    expect(memoryNotice({ longLines: 0, orphans: ["a.md", "b.md", "c.md", "d.md", "e.md"] })).toContain(
      "memory/a.md, memory/b.md, memory/c.md and 2 more have no pointer line here",
    );
  });

  it("is empty for a healthy bot", () => {
    expect(memoryNotice(HEALTHY)).toBe("");
    expect(memoryNotice(HEALTHY, undefined)).toBe("");
  });
});

describe("createMemoryHealthCheck", () => {
  it("shows the notice once per session and only while it holds", () => {
    let health: MemoryHealth = { longLines: 2, orphans: [] };
    const check = createMemoryHealthCheck({ health: () => health, dropped: () => undefined, now: () => NOW });
    expect(check.take("bot", "t1", undefined)).toBe("");
    check.refresh("bot");
    expect(check.take("bot", "t1", undefined)).toContain("2 lines are over 300 bytes");
    check.settled("bot", "t1", { sessionId: "s1" });
    expect(check.take("bot", "t1", { sessionId: "s1" })).toBe("");
    expect(check.take("bot", "t1", { sessionId: "s2" })).toContain("Memory check");
    health = HEALTHY;
    check.settled("bot", "t1", { sessionId: "s3" });
    expect(check.take("bot", "t1", { sessionId: "s4" })).toBe("");
  });

  it("refreshAll reads nothing on the calling turn", async () => {
    const health = vi.fn(() => ({ longLines: 2, orphans: [] }));
    const check = createMemoryHealthCheck({ health, dropped: () => undefined, now: () => NOW });
    const done = check.refreshAll(["a", "b"]);
    expect(health).not.toHaveBeenCalled();
    await done;
    expect(health.mock.calls).toEqual([["a"], ["b"]]);
    expect(check.take("b", "t1", undefined)).toContain("Memory check");
  });

  it("take reads only the cached notice", () => {
    const health = vi.fn(() => ({ longLines: 2, orphans: [] }));
    const dropped = vi.fn(() => undefined);
    const check = createMemoryHealthCheck({ health, dropped, now: () => NOW });
    check.refresh("bot");
    health.mockClear();
    dropped.mockClear();
    expect(check.take("bot", "t1", { sessionId: "s1" })).toContain("Memory check");
    expect(check.take("bot", "t2", { sessionId: "s1" })).toContain("Memory check");
    expect(check.take("bot", "t1", { sessionId: "s1" })).toBe("");
    expect(health).not.toHaveBeenCalled();
    expect(dropped).not.toHaveBeenCalled();
  });
});
