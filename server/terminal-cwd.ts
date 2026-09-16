// Authoritative local folder for the integrated terminal. Kept on the server
// so Electron does not invent workspace paths or silently rewrite bot.cwd.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { ensureWorkspace } from "./workspace.ts";

export type TerminalFolderResolution =
  | { cwd: string; source: "project" | "workspace" }
  | { needsFolder: true; reason: "explicit-unavailable" | "unknown-bot"; explicitCwd?: string };

function isLocalDirectory(candidate: string): boolean {
  if (!candidate || !isAbsolute(candidate)) return false;
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Fresh local terminal folder for a bot. Never opens a chooser and never
 * silently substitutes the private workspace for an explicit missing pin. */
export function resolveBotTerminalFolder(bot: { id: string; cwd?: string | null } | null | undefined): TerminalFolderResolution {
  if (!bot || typeof bot.id !== "string" || !bot.id) {
    return { needsFolder: true, reason: "unknown-bot" };
  }
  const pinned = typeof bot.cwd === "string" && bot.cwd.trim() ? bot.cwd.trim() : null;
  if (pinned) {
    if (isLocalDirectory(pinned)) return { cwd: resolve(pinned), source: "project" };
    return { needsFolder: true, reason: "explicit-unavailable", explicitCwd: pinned };
  }
  const cwd = ensureWorkspace(bot.id);
  // ensureWorkspace creates the desk; defend against a non-dir collision.
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return { cwd, source: "workspace" };
}
