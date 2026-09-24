import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { harnessPlaybookPrompt, loadHarnessPlaybook } from "./harness-playbook.ts";

describe("harness playbook", () => {
  it("is in the system prompt only when the terminal is shared", () => {
    expect(harnessPlaybookPrompt(true)).toContain("<harness_playbook>");
    expect(harnessPlaybookPrompt(true)).toContain("Verify before push");
    expect(harnessPlaybookPrompt(false)).toBe("");
  });

  it("fills the worktree path from the configured root", () => {
    const prompt = loadHarnessPlaybook(undefined, join("D:", "wt"));
    expect(prompt).toContain(join("D:", "wt", "<name>"));
    expect(prompt).not.toContain("{{WORKTREE}}");
  });

  it("routes reports through orbit-msg on Windows and the pane elsewhere", () => {
    const win = loadHarnessPlaybook(undefined, undefined, "win32");
    expect(win).toContain('orbit-msg --report DONE|FAIL|BLOCKED <NICKNAME> "<text>"');
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
