// The Terminal skin's reading of a transcript: Claude Code's tool verbs, the
// one ⎿ line a step settles into, and the status line's meters.
import type { RateLimitWindow } from "../../server/contracts.ts";
import type { MessageKey } from "./i18n-catalog";
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
]);

export function termVerb(name: string): string {
  return VERBS.get(name) ?? name;
}

export type TermStepState = "running" | "done" | "failed";

export function termStepState(ok: boolean | undefined): TermStepState {
  return ok === undefined ? "running" : ok ? "done" : "failed";
}

export function termDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

/** Status and duration are always known, so the ⎿ line is never empty. */
export function termResultLine(state: TermStepState, elapsedMs: number | undefined): string {
  const word = state === "running" ? "Running…" : state === "done" ? "Done" : "Failed";
  return elapsedMs === undefined ? word : `${word} (${termDuration(elapsedMs)})`;
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
