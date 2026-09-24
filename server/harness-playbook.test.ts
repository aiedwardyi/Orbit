import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("skips a missing playbook file", () => {
    expect(loadHarnessPlaybook(join("missing", "harness-playbook.md"))).toBe("");
  });
});
