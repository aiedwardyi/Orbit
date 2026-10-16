// A teacher bot's notes file: the PATCH check and a once-per-session stale
// notice. The file is stat'ed after a reply settles, never at send.
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { sessionNoticeDue, type SessionNoticeMarks } from "./session-notice.ts";

export const PROJECT_NOTES_MAX_CHARS = 1_024;
const DAY_MS = 24 * 60 * 60_000;
const STALE_DAYS = 3;
// orbit-msg --report leads with "STATUS NICK branch= sha= dirty="; plain notes and Stop hooks don't.
const REPORT_NOTE = /^\[pane [^\]]+\](?: \[[^\]]*\])? from .+? \([^)]+\): \S+ \S+ branch=\S* sha=\S* dirty=\S*/;

export type ProjectNotesValidation = { ok: true; path: string | null } | { ok: false; error: string };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- PATCH bodies and synced ops are parsed here.
export function validateProjectNotes(input: unknown): ProjectNotesValidation {
  const parsed = z.string().nullable().safeParse(input);
  if (!parsed.success) return { ok: false, error: "project notes must be a file path" };
  if (parsed.data === null) return { ok: true, path: null };
  // Explorer's Copy as path wraps it in quotes
  const path = parsed.data.trim().replace(/^"(.*)"$/, "$1").trim();
  if (!path) return { ok: true, path: null };
  if (path.length >= PROJECT_NOTES_MAX_CHARS) return { ok: false, error: "project notes path must be under 1,024 characters" };
  if (!isAbsolute(path)) return { ok: false, error: "project notes must be an absolute path" };
  return { ok: true, path };
}

export function workerReportTimes(messages: ReadonlyArray<{ kind?: string; text?: string; at?: number }>): number[] {
  return messages.flatMap((message) =>
    message.kind === "note" && message.at !== undefined && REPORT_NOTE.test(message.text ?? "") ? [message.at] : []);
}

export function staleNotesNotice(input: {
  path: string;
  /** null when the file is missing. */
  mtime: number | null;
  newestReportAt: number | null;
  reportsSince: number;
  now: number;
}): string {
  const { path, mtime, newestReportAt, reportsSince, now } = input;
  if (mtime === null) return `[Project notes check: ${path} is missing.]`;
  if (newestReportAt === null || reportsSince < 1 || newestReportAt - mtime < STALE_DAYS * DAY_MS) return "";
  const name = path.split(/[\\/]/).at(-1);
  const days = Math.floor((now - mtime) / DAY_MS);
  const reports = reportsSince === 1 ? "1 worker report" : `${reportsSince} worker reports`;
  return `[Project notes check: ${name} was last edited ${days} days ago and ${reports} landed since. Catch it up this session.]`;
}

export interface ProjectNotesCheckDeps {
  notesPath: (botId: string) => string | undefined;
  reportTimes: (botId: string) => number[];
  now?: () => number;
}

/* oxlint-disable anti-slop/no-unknown-parameters -- provider resume cursors are opaque. */
export interface ProjectNotesCheck {
  refresh(botId: string): Promise<void>;
  /** The cached notice when due in this provider session, else "". No I/O. */
  take(botId: string, threadId: string, cursor: unknown): string;
  settled(botId: string, threadId: string, cursor: unknown): Promise<void>;
}

const cursorKey = (cursor: unknown) => (cursor === undefined || cursor === null ? "" : JSON.stringify(cursor));
/* oxlint-enable anti-slop/no-unknown-parameters */

export function createProjectNotesCheck(deps: ProjectNotesCheckDeps): ProjectNotesCheck {
  const now = deps.now ?? Date.now;
  const notices = new Map<string, string>();
  const shown: SessionNoticeMarks = {};
  const key = (threadId: string) => `project-notes:${threadId}`;
  const refresh = async (botId: string) => {
    const path = deps.notesPath(botId);
    if (!path) {
      notices.delete(botId);
      return;
    }
    const mtime = await stat(path).then((info) => info.mtimeMs, () => null);
    if (deps.notesPath(botId) !== path) return;
    const times = deps.reportTimes(botId);
    notices.set(botId, staleNotesNotice({
      path,
      mtime,
      newestReportAt: times.length ? Math.max(...times) : null,
      reportsSince: mtime === null ? 0 : times.filter((at) => at > mtime).length,
      now: now(),
    }));
  };
  return {
    refresh,
    take(botId, threadId, cursor) {
      const notice = notices.get(botId);
      if (!notice) return "";
      const at = now();
      const session = cursorKey(cursor);
      if (!sessionNoticeDue(shown, session, key(threadId), at)) return "";
      shown[key(threadId)] = { cursor: session, at };
      return notice;
    },
    settled(botId, threadId, cursor) {
      // a fresh session has a cursor only once the turn that carried the notice ran
      const mark = shown[key(threadId)];
      if (mark?.cursor === "") mark.cursor = cursorKey(cursor);
      return refresh(botId);
    },
  };
}
