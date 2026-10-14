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
    expect(harnessPlaybookPrompt(true)).toContain("report BLOCKED with the question instead of guessing");
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
  });

  it("keeps a progress file beside the card and hands it on", () => {
    const prompt = harnessPlaybookPrompt(true);
    expect(prompt).toContain("## Progress\nKeep <card path minus .md>.progress.md current at each milestone:");
    expect(prompt).toContain("Claude workers compact at about 500k and get their card and progress file back.");
    expect(prompt).toContain("its progress file and \"continue from the uncommitted changes already here\"");
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
