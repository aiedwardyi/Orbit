import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SERVER_ROOT } from "./proxy-paths.ts";

// server/ in dev, Resources/server once packaged; docs/ is a sibling in both.
const PLAYBOOK_PATH = join(SERVER_ROOT, "..", "docs", "harness-playbook.md");

export function loadHarnessPlaybook(
  file = PLAYBOOK_PATH,
  worktreeRoot = process.env.ORBIT_WORKTREE_ROOT || join(homedir(), "orbit-wt"),
): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
  return `\n<harness_playbook>\n${text.replaceAll("{{WORKTREE}}", join(worktreeRoot, "<name>"))}\n</harness_playbook>`;
}

const HARNESS_PLAYBOOK = loadHarnessPlaybook();

/** Only a bot with the shared terminal mounted gets the worker playbook. */
export function harnessPlaybookPrompt(terminalShared: boolean, playbook = HARNESS_PLAYBOOK): string {
  return terminalShared ? playbook : "";
}
