import type { MessageKey, Translate } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { parsePaneNote, type PaneNote, type PaneNoteStatus } from "../../shared/pane-note";

export const NOTE_STATUS_KEY = { done: "chat.noteDone", failed: "chat.noteFailed", blocked: "chat.noteBlocked" } as const satisfies Record<PaneNoteStatus, MessageKey>;
export const LAUNCH_STATUS_KEY = { done: "chat.launchDone", failed: "chat.launchFailed", blocked: "chat.launchBlocked" } as const satisfies Record<PaneNoteStatus, MessageKey>;

/** The worker's words, or a plain sentence for Wink's own watcher notes. */
export function noteText(note: PaneNote, t: Translate): string {
  if (note.alert?.kind === "stalled") return note.alert.minutes === 1 ? t("chat.noteStalledOne") : t("chat.noteStalled", { count: note.alert.minutes });
  if (note.alert?.kind === "waiting") return t("chat.noteWaiting");
  return note.body;
}

export function notePreview(note: PaneNote, t: Translate): string {
  const text = noteText(note, t).replace(/\s+/g, " ").trim();
  if (!note.status) return text;
  const status = t(NOTE_STATUS_KEY[note.status]);
  return text ? t("chat.noteStatusLine", { status, text }) : status;
}

/** Newest report per pane, keyed by the 8-char pane id. */
export function paneReports(messages: readonly Message[]): Map<string, PaneNote> {
  const reports = new Map<string, PaneNote>();
  for (const message of messages) {
    if (message.kind !== "note" || !message.text) continue;
    const note = parsePaneNote(message.text);
    if (note.pane8 && note.status) reports.set(note.pane8, note);
  }
  return reports;
}
