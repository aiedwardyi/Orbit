// The Terminal skin's reading of a transcript: Claude Code's tool verbs, the
// one ⎿ line a step settles into, and the status line's meters.
import type { RateLimitWindow } from "../../server/contracts.ts";
import type { ToolDetail } from "../../shared/tool-detail";
import type { MessageKey } from "./i18n-catalog";
import type { Translate } from "./i18n";
import type { UsageMode } from "./usage-preferences";
import { windowFillPercent, windowKind, type WindowKind } from "./usage";

// Codex and ACP name the same calls differently; the header reads the same on every engine.
const VERBS = new Map([
  ["Edit", "Update"],
  ["MultiEdit", "Update"],
  ["edit", "Update"],
  ["fileChange", "Update"],
  ["shell", "Bash"],
  ["commandExecution", "Bash"],
  ["WebFetch", "Fetch"],
  ["WebSearch", "Web Search"],
  ["web_search", "Web Search"],
  ["webSearch", "Web Search"],
  ["Agent", "Task"],
  ["bash", "Bash"],
  ["read", "Read"],
  ["write", "Write"],
  ["grep", "Grep"],
  ["find", "Glob"],
  ["ls", "List"],
  ["run_command", "Bash"],
  ["view_file", "Read"],
  ["write_to_file", "Write"],
  ["replace_file_content", "Update"],
  ["multi_replace_file_content", "Update"],
  ["grep_search", "Grep"],
  ["find_by_name", "Glob"],
  ["list_dir", "List"],
  ["search_web", "Web Search"],
  ["read_url_content", "Fetch"],
]);

export function termVerb(name: string): string {
  return VERBS.get(name) ?? name;
}

export type TermStepState = "running" | "done" | "failed";

export function termStepState(ok: boolean | undefined): TermStepState {
  return ok === undefined ? "running" : ok ? "done" : "failed";
}

export const TERM_STEP_WORD = {
  running: "term.step.running",
  done: "term.step.done",
  failed: "term.step.failed",
} as const satisfies Record<TermStepState, MessageKey>;

export function termDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

/** Status and duration are always known, so the ⎿ line is never empty. */
export function termResultLine(word: string, elapsedMs: number | undefined): string {
  return elapsedMs === undefined ? word : `${word} (${termDuration(elapsedMs)})`;
}

// Their captured input is the command or path itself; other tools keep the summary.
const INPUT_HEADERS = new Set(["Bash", "Update", "Write"]);

export function termHeaderArgs(verb: string, summary: string | undefined, detail: ToolDetail | undefined, fallback?: string): string | undefined {
  // fallback is the raw step name, and only when the engine named the kind
  return (INPUT_HEADERS.has(verb) ? detail?.input ?? summary : summary ?? detail?.input) ?? fallback;
}

export type TermRow = { text: string; tone?: "add" | "remove" };

export type TermBlock =
  | { kind: "hidden" }
  | { kind: "lines"; rows: TermRow[]; more?: number; changes?: { additions: number; removals: number } };

/** The ⎿ block a step's captured detail draws; null keeps the one Done line. */
export function termBlock(detail: ToolDetail | undefined, failed: boolean): TermBlock | null {
  if (!detail) return null;
  if (detail.outputHidden) return { kind: "hidden" };
  const diff = !failed && detail.diff?.length ? detail.diff : undefined;
  const lines = diff ?? detail.output;
  if (!lines?.length) return null;
  const rows = lines.map((line): TermRow => {
    if (!diff || (line[0] !== "+" && line[0] !== "-")) return { text: line };
    return { text: `${line[0]} ${line.slice(1)}`, tone: line[0] === "+" ? "add" : "remove" };
  });
  const block: TermBlock = { kind: "lines", rows };
  if (detail.more) block.more = detail.more;
  // `more` doesn't say which hidden lines were added or removed, so only a whole diff is counted.
  else if (diff) block.changes = { additions: rows.filter((row) => row.tone === "add").length, removals: rows.filter((row) => row.tone === "remove").length };
  return block;
}

export function termUpdatedLine(t: Translate, path: string, { additions, removals }: { additions: number; removals: number }): string | undefined {
  const added = additions ? t(additions === 1 ? "term.diff.additionOne" : "term.diff.additionMany", { count: additions }) : "";
  const removed = removals ? t(removals === 1 ? "term.diff.removalOne" : "term.diff.removalMany", { count: removals }) : "";
  const changes = added && removed ? t("term.diff.both", { additions: added, removals: removed }) : added || removed;
  return changes ? t("term.diff.updated", { path, changes }) : undefined;
}

export type TermStepAria = { key: MessageKey; seconds?: number };

export function termStepAria(state: TermStepState, elapsedMs: number | undefined): TermStepAria {
  if (state === "running") return { key: "term.step.ariaRunning" };
  if (elapsedMs === undefined) return { key: state === "done" ? "term.step.ariaDoneBare" : "term.step.ariaFailedBare" };
  return { key: state === "done" ? "term.step.ariaDone" : "term.step.ariaFailed", seconds: Math.round(elapsedMs / 100) / 10 };
}

/** Elapsed time on the working line, as Claude Code prints it: `12s`, `2m 38s`. */
export function termElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export type TermMeter = { id: string; kind: WindowKind; percent: number | null; bar: string };

/** Follows the usage mode like every Wink meter, so by default it shows what's left. */
export function termMeter(window: RateLimitWindow, now: number, mode: UsageMode): TermMeter {
  const used = windowFillPercent(window, now);
  const percent = used === null ? null : mode === "remaining" ? Math.max(0, 100 - used) : used;
  const filled = percent === null ? 0 : Math.min(5, Math.round(percent / 20));
  return { id: window.id, kind: windowKind(window.id, window.windowMinutes), percent, bar: "▰".repeat(filled) + "▱".repeat(5 - filled) };
}
