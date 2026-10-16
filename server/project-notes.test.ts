import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProjectNotesCheck, staleNotesNotice, validateProjectNotes, workerReportTimes } from "./project-notes.ts";

const DAY = 24 * 60 * 60_000;
const NOW = new Date(2026, 9, 16, 12).getTime();
const PATH = join(tmpdir(), "vault", "BRAIN.md");

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("validateProjectNotes", () => {
  it("takes an absolute path and clears on null or empty", () => {
    expect(validateProjectNotes(PATH)).toEqual({ ok: true, path: PATH });
    expect(validateProjectNotes(`  "${PATH}" `)).toEqual({ ok: true, path: PATH });
    expect(validateProjectNotes(null)).toEqual({ ok: true, path: null });
    expect(validateProjectNotes("  ")).toEqual({ ok: true, path: null });
  });

  it("takes a path at the synced 1,024-character cap", () => {
    const path = join(tmpdir(), "x".repeat(1_024)).slice(0, 1_024);
    expect(validateProjectNotes(path)).toEqual({ ok: true, path });
  });

  it("refuses a non-string, a relative path or a long one", () => {
    expect(validateProjectNotes(42)).toEqual({ ok: false, error: "project notes must be a file path" });
    expect(validateProjectNotes("notes/BRAIN.md")).toEqual({ ok: false, error: "project notes must be an absolute path" });
    expect(validateProjectNotes(join(tmpdir(), "x".repeat(1_024)))).toEqual({ ok: false, error: "project notes path must not exceed 1,024 characters" });
  });
});

describe("workerReportTimes", () => {
  it("counts only orbit-msg reports", () => {
    expect(workerReportTimes([
      { kind: "note", at: 1, text: "[pane 1234abcd] [CARD] from Mentor (bot-1): DONE CARD branch=feat/x sha=abc1234 dirty=no\nall green" },
      { kind: "note", at: 2, text: "[pane 1234abcd] from Mentor (bot-1): still working" },
      { kind: "text", at: 3, text: "[pane 1234abcd] from Mentor (bot-1): DONE CARD branch=x sha=y dirty=no" },
      { kind: "note", at: 4, text: "[pane 5678abcd] from Mentor (bot-1): BLOCKED OTHER branch=none sha=none dirty=unknown" },
    ])).toEqual([1, 4]);
  });
});

describe("staleNotesNotice", () => {
  const notice = (mtimeDaysAgo: number, newestDaysAgo: number, reportsSince: number) =>
    staleNotesNotice({ path: PATH, mtime: NOW - mtimeDaysAgo * DAY, newestReportAt: NOW - newestDaysAgo * DAY, reportsSince, now: NOW });

  it("asks for a catch-up when notes trail the newest report by 3+ days", () => {
    expect(notice(9, 1, 4)).toBe("[Project notes check: BRAIN.md was last edited 9 days ago and 4 worker reports landed since. Catch it up this session.]");
    expect(notice(3, 0, 1)).toBe("[Project notes check: BRAIN.md was last edited 3 days ago and 1 worker report landed since. Catch it up this session.]");
  });

  it("stays quiet when notes are close to the reports or none landed since", () => {
    expect(notice(3, 0.5, 2)).toBe("");
    expect(notice(9, 1, 0)).toBe("");
    expect(staleNotesNotice({ path: PATH, mtime: NOW - 9 * DAY, newestReportAt: null, reportsSince: 0, now: NOW })).toBe("");
  });

  it("names a missing file", () => {
    expect(staleNotesNotice({ path: PATH, mtime: null, newestReportAt: null, reportsSince: 0, now: NOW })).toBe(`[Project notes check: ${PATH} is missing.]`);
  });
});

describe("createProjectNotesCheck", () => {
  it("shows a stale notice once per session and drops it once the notes catch up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-notes-"));
    dirs.push(dir);
    const path = join(dir, "BRAIN.md");
    writeFileSync(path, "# Brain\n");
    utimesSync(path, (NOW - 9 * DAY) / 1000, (NOW - 9 * DAY) / 1000);
    let now = NOW;
    const check = createProjectNotesCheck({ notesPath: () => path, reportTimes: () => [NOW - 2 * DAY, NOW - DAY], now: () => now });
    expect(check.take("bot", "t1", undefined)).toBe("");
    await check.refresh("bot");
    expect(check.take("bot", "t1", undefined)).toContain("2 worker reports landed since");
    await check.settled("bot", "t1", { sessionId: "s1" });
    now += 60_000;
    expect(check.take("bot", "t1", { sessionId: "s1" })).toBe("");
    expect(check.take("bot", "t1", { sessionId: "s2" })).toContain("BRAIN.md");
    utimesSync(path, now / 1000, now / 1000);
    await check.settled("bot", "t1", { sessionId: "s3" });
    expect(check.take("bot", "t1", { sessionId: "s3" })).toBe("");
  });

  it("names a missing file and clears with the path", async () => {
    let path: string | undefined = join(tmpdir(), "omb-notes-missing", "BRAIN.md");
    const check = createProjectNotesCheck({ notesPath: () => path, reportTimes: () => [], now: () => NOW });
    await check.refresh("bot");
    expect(check.take("bot", "t1", undefined)).toBe(`[Project notes check: ${path} is missing.]`);
    path = undefined;
    await check.refresh("bot");
    expect(check.take("bot", "t2", undefined)).toBe("");
  });
});
