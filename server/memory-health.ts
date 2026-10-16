// A bot's memory check: long lines, side files with no pointer, auto notes
// a full file turned away. Computed after a reply settles, never at send.
import { setImmediate } from "node:timers/promises";

import type { DroppedNotes } from "./memory-pass.ts";
import { sessionNoticeDue, type SessionNoticeMarks } from "./session-notice.ts";
import { MEMORY_LINE_MAX_BYTES, type MemoryHealth } from "./workspace.ts";

const LISTED_ORPHANS = 3;

const monthDay = (ms: number) => {
  const date = new Date(ms);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

function listed(names: string[]): string {
  const shown = names.slice(0, LISTED_ORPHANS);
  const more = names.length - shown.length;
  const items = more ? [...shown, `${more} more`] : shown;
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function memoryNotice(health: MemoryHealth, dropped?: DroppedNotes): string {
  const { longLines, orphans } = health;
  const parts = [
    longLines === 1 ? `1 line is over ${MEMORY_LINE_MAX_BYTES} bytes` : longLines ? `${longLines} lines are over ${MEMORY_LINE_MAX_BYTES} bytes` : "",
    orphans.length
      ? `${listed(orphans.map((name) => `memory/${name}`))} ${orphans.length === 1 ? "has" : "have"} no pointer line here`
      : "",
    dropped?.dropped
      ? `${dropped.dropped === 1 ? "1 auto note" : `${dropped.dropped} auto notes`} since ${monthDay(dropped.since)} ${dropped.dropped === 1 ? "was" : "were"} not saved because the file is full`
      : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  const fix = longLines || dropped?.dropped ? "Trim it this session." : "Add the pointer lines this session.";
  return `[Memory check: ${parts.join("; ")}. ${fix}]`;
}

export interface MemoryHealthCheckDeps {
  health: (botId: string) => MemoryHealth;
  dropped: (botId: string) => DroppedNotes | undefined;
  now?: () => number;
}

/* oxlint-disable anti-slop/no-unknown-parameters -- provider resume cursors are opaque. */
export interface MemoryHealthCheck {
  refresh(botId: string): void;
  /** One bot per event-loop turn, so boot never waits on file reads. */
  refreshAll(botIds: string[]): Promise<void>;
  /** The cached notice when due in this provider session, else "". No I/O. */
  take(botId: string, threadId: string, cursor: unknown): string;
  settled(botId: string, threadId: string, cursor: unknown): void;
}

const cursorKey = (cursor: unknown) => (cursor === undefined || cursor === null ? "" : JSON.stringify(cursor));
/* oxlint-enable anti-slop/no-unknown-parameters */

export function createMemoryHealthCheck(deps: MemoryHealthCheckDeps): MemoryHealthCheck {
  const now = deps.now ?? Date.now;
  const notices = new Map<string, string>();
  const shown: SessionNoticeMarks = {};
  const key = (threadId: string) => `memory-health:${threadId}`;
  const refresh = (botId: string) => {
    const notice = memoryNotice(deps.health(botId), deps.dropped(botId));
    if (notice) notices.set(botId, notice);
    else notices.delete(botId);
  };
  return {
    refresh,
    async refreshAll(botIds) {
      for (const botId of botIds) {
        await setImmediate();
        refresh(botId);
      }
    },
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
      refresh(botId);
    },
  };
}
