import type { MessageKey, Translate } from "@/lib/i18n";
import type { PaneNote, PaneNoteStatus } from "../../shared/pane-note";

export const NOTE_STATUS_KEY = { done: "chat.noteDone", failed: "chat.noteFailed", blocked: "chat.noteBlocked" } as const satisfies Record<PaneNoteStatus, MessageKey>;

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
