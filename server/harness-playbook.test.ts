import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { harnessPlaybookPrompt, loadHarnessPlaybook } from "./harness-playbook.ts";

describe("harness playbook", () => {
  it("is in the system prompt only when the terminal is shared", () => {
    expect(harnessPlaybookPrompt(true)).toContain("<harness_playbook>");
    expect(harnessPlaybookPrompt(true)).toContain("Verify before push");
    expect(harnessPlaybookPrompt(false)).toBe("");
  });

  it("hands big jobs to workers and keeps quick asks", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("Hand big jobs to workers");
    expect(prompt).toContain("Do quick asks");
    expect(prompt).toContain("small edits yourself");
    expect(prompt).toContain("big jobs too when no worker can start");
    expect(prompt).toContain("needs tools only you have, like connected apps or the browser");
  });

  it("gives an editing job in a plain folder one worker in place", () => {
    expect(harnessPlaybookPrompt(true)).toContain("An editing job in a plain folder gets no worktree: one worker edits it in place");
  });

  it("edits a checkout with uncommitted changes in place and checks its files", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("The same goes for a checkout with uncommitted changes");
    expect(prompt).toContain("An in-place worker has no branch: instead of steps 1 and 2, compare the files it");
    expect(prompt).toContain("steps 6 and 9, and never stash, reset or check out over the user's files");
  });

  it("requires a safety copy before an in-place worker and compares against it", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("Before an in-place worker, copy what git cannot restore into a new folder in the system temp folder");
    expect(prompt).toContain("`wink-safety-<NICKNAME>-<time>`");
    expect(prompt).toContain("save the `git status --short` output there");
    expect(prompt).toContain("copy any ignored file the job may change");
    expect(prompt).toContain("changed with the safety copy, or with `git diff` for files that were clean");
    expect(prompt).not.toContain("%TEMP%");
  });

  it("keeps a built list, checked before feature claims and updated on landing", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("Keep one line per user-facing feature in `built.md`");
    expect(prompt).toContain("`- Name | where: device, size, setting | files | PRs`");
    expect(prompt).toContain("then read the code it names. No line: search the code.");
    expect(prompt).toContain("When you land a user-facing change, add or edit its one line");
  });

  it("verifies a scratch-copy review by its findings and deletes the copy", () => {
    expect(harnessPlaybookPrompt(true)).toContain("A read-only review in a scratch copy has no branch either: instead of the");
  });

  it("lands only the worker's own commit from a clean worktree", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("the worker's own new commit is on");
    expect(prompt).toContain('`git -C "<worktree>" status --short` prints nothing');
  });

  it("checks for changes before writing the card and keeps cards out of the repo", () => {
    expect(harnessPlaybookPrompt(true)).toContain("Check before you write the card, and keep cards outside the repo");
  });

  it("lands a verified result uncommitted unless the user asked for a branch", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("Land the result unless the user asked for a branch, push or PR");
    expect(prompt).toContain('git -C "<repo>" merge --squash <branch>');
    expect(prompt).toContain("Landing a verified result in step 9 is part of the job");
  });

  it("has a Clean up section with the junction warning and per-card scratch folder", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("## Clean up");
    expect(prompt).toContain("follows every junction inside it");
    expect(prompt).toContain("-Attributes ReparsePoint | % { [System.IO.Directory]::Delete(");
    expect(prompt).toContain("wipes their targets");
    expect(prompt).toContain("wink-<NICKNAME>");
    expect(prompt).toContain("Scratch is removed with `orbit-clean <NICKNAME>`.");
    expect(prompt).toContain("Never delete by wildcard, age or folder size");
    expect(prompt).not.toContain("Remove it once the branch has landed");
  });

  it("quotes worktree paths", () => {
    expect(loadHarnessPlaybook(undefined, join("D:", "my wt"))).toContain(`worktree add "${join("D:", "my wt", "<name>")}"`);
  });

  it("says worker reports from a group room reach the bot's own chat", () => {
    expect(harnessPlaybookPrompt(true)).toContain("worker reports reach your own chat, not the room");
  });

  it("sends long follow-ups as a file, one line", () => {
    expect(harnessPlaybookPrompt(true)).toContain("Follow-ups use the card rule: write long instructions to a file");
  });

  it("has workers ask through BLOCKED instead of guessing", () => {
    expect(harnessPlaybookPrompt(true)).toContain("- If a choice this card does not cover would change the result, stop and report BLOCKED with the question.");
  });

  it("tells parallel cards to split shared names and to end with an INTEGRATE card", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("split shared ids, routes and names between them up front");
    expect(prompt).toContain("end with one INTEGRATE card");
  });

  it("keeps workers small, fresh and on high effort", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("finishes under about 200k tokens of context");
    expect(prompt).toContain("A new task gets a FRESH worker");
    expect(prompt).toContain("CURRENT gets at most one short follow-up on");
    expect(prompt).toContain("anything more goes to a FRESH worker in the same worktree");
    expect(prompt).toContain("Default workers to high effort");
    expect(prompt.replace(/\s+/g, " ")).toContain("Only when the user turns max mode on, use max for hard bugs, QA (Opus 5.5), verification and audits. Fable: code audits only.");
    expect(prompt.replace(/\s+/g, " ")).toContain("Save Gemini 4 Argon for big jobs that gain from a second model family's view, like a whole-codebase audit or 3D and graphic design. Routine work goes to the other engines.");
  });

  it("matches the model to the job", () => {
    expect(harnessPlaybookPrompt(true).replace(/\s+/g, " ")).toContain("Match the model to the job: the strongest for architecture, audits and hard bugs; a mid model for routine builds; the cheapest for searches and mechanical edits. Spread jobs across engines so no single plan runs out.");
  });

  it("keeps a progress file beside the card and hands it on", () => {
    const prompt = harnessPlaybookPrompt(true).replace(/\r\n/g, "\n");
    expect(prompt).toContain("## Progress\nKeep <card path minus .md>.progress.md current at each milestone:");
    expect(prompt).toContain("Claude workers compact at about 300k and get their card and progress file back.");
    expect(prompt).toContain("its progress file and \"continue from the uncommitted changes already here\"");
  });

  it("respawns workers after an app restart and leaves other bots' processes alone", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("An app update or restart closes every pane mid-run:");
    expect(prompt).toContain("tell the user which of your workers it would stop");
    expect(prompt).toContain("close only the ones you can prove it started");
  });

  it("reads the pane before calling a worker still running", () => {
    expect(harnessPlaybookPrompt(true)).toContain("read the pane before you say a worker is still running");
  });

  it("sends work that must outlive the turn to a pane worker", () => {
    expect(harnessPlaybookPrompt(true)).toContain("Background subagents end with your turn");
  });

  it("gates timing runs on a quiet machine", () => {
    expect(harnessPlaybookPrompt(true)).toContain("Timing runs need a quiet machine");
  });

  it("keeps worker processes off the user's screen", () => {
    expect(harnessPlaybookPrompt(true)).toContain("- Keep processes off the user's screen: run in the pane, start servers hidden, and wait for checks in the foreground: a hidden process sends no alert when it ends.");
  });

  it("carries the four house rules", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("- Launch only cards that serve the current goal or that the user asked for. A new idea is a one-line proposal that waits for a yes.");
    expect(prompt).toContain("- Before a fan-out, check each engine's usage left; never put several workers on a low engine.");
    expect(prompt).toContain("10. After a merge, deploy or release, check the live result yourself before you call it done.");
    expect(prompt).toContain("- Never stop a worker or others' processes unless the user names it.");
  });

  it("stays within its size budget", () => {
    const prompt = loadHarnessPlaybook(undefined, join("D:", "wt"), "win32").replace(/\r\n/g, "\n");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(12824);
  });

  it("fills the worktree path from the configured root", () => {
    const prompt = loadHarnessPlaybook(undefined, join("D:", "wt"));
    expect(prompt).toContain(join("D:", "wt", "<name>"));
    expect(prompt).not.toContain("{{WORKTREE}}");
  });

  it("routes reports through orbit-msg on Windows and the pane elsewhere", () => {
    const win = loadHarnessPlaybook(undefined, undefined, "win32");
    expect(win).toContain('orbit-msg --report DONE|FAIL|BLOCKED <NICKNAME> "<text>"');
    expect(win).toContain("For text with quotes or pipes, use `--file`.");
    expect(win).not.toContain("{{REPORTS}}");
    const linux = loadHarnessPlaybook(undefined, undefined, "linux");
    expect(linux).toContain("orbit-msg is not installed on this platform");
    expect(linux).not.toContain("--report");
  });

  it("names no one user's machine or remotes", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(loadHarnessPlaybook(undefined, join("D:", "wt"), platform)).not.toMatch(/checkpoint|origin|C:\\Users|mredw|orbit-wt/);
    }
  });

  it("warns on and skips a missing playbook file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = join("missing", "harness-playbook.md");
    expect(loadHarnessPlaybook(file)).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(file));
    warn.mockRestore();
  });
});
