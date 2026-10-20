// A pane-note turn stays quiet only when it answers worker notes alone.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

describe("pane-note quiet finish", () => {
  it("alerts when a user send folded into the start", () => {
    const at = index.indexOf("opts?.paneNoteWake === true");
    expect(at).toBeGreaterThan(0);
    const line = index.slice(index.lastIndexOf("\n", at) + 1, index.indexOf("\n", at));
    expect(line).toContain("folded");
    expect(line).toMatch(/folded\.length\s*===\s*0|!folded\.length/);
  });

  it("alerts when a late send joins at dispatch", () => {
    const at = index.indexOf("const queued = foldQueuedSends(");
    expect(at).toBeGreaterThan(0);
    expect(index.slice(at, at + 500)).toContain("paneNoteTurnThreads.delete(threadId)");
  });

  it("alerts a continuation adopted after a note, keeps the note turn quiet", () => {
    const at = index.indexOf("adopt: (botId, threadId, turnId) => {");
    expect(at).toBeGreaterThan(0);
    expect(index.slice(at, at + 600)).toContain("paneNoteTurnThreads.delete(threadId)");
    expect(index).toContain("paneNoteTurn: paneNoteTurnThreads.has(event.threadId)");
  });
});
