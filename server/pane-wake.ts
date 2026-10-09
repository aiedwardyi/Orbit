import type { Message } from "./store.ts";

export const PANE_WAKE_PROMPT = "A pane note arrived. Act on it.";
export const PANE_WAKE_DEBOUNCE_MS = 3_000;
export const PANE_WAKE_HOURLY_CAP = 20;
const HOUR_MS = 60 * 60 * 1000;

export interface PaneWakeDeps {
  enabled(botId: string): boolean;
  busy(botId: string, threadId: string): boolean;
  paused?(botId: string): boolean;
  /** A user turn since the note already delivered it. */
  hasNotes(threadId: string): boolean;
  /** Every pane was closed by this bot's own terminal_close. */
  closedByBot?(botId: string, paneIds: string[]): Promise<boolean>;
  /** A burst was dropped because the bot closed all its panes. */
  skipped?(botId: string, threadId: string): void;
  wake(botId: string, threadId: string): void;
  warn(line: string): void;
  now?(): number;
}

export function hasLocalUndeliveredPaneNote(messages: Message[], deliveredId: string | undefined, deviceId: string, skippedId?: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.id === deliveredId || message.id === skippedId) break;
    if (message.role === "user" && message.kind === "text" && message.text?.trim() && !message.steered) break;
    if (message.kind === "note" && message.text?.trim() && message.origin === deviceId) return true;
  }
  return false;
}

interface Pending {
  botId: string;
  threadId: string;
  timer: ReturnType<typeof setTimeout> | null;
  panes: Set<string>;
  /** A note with no known pane joined: always wake. */
  unknownPane: boolean;
  notes: number;
  checking: boolean;
}

/** One teacher turn per burst of pane notes, only once the bot is idle. */
export class PaneWakeScheduler {
  private readonly pending = new Map<string, Pending>();
  private readonly wakes = new Map<string, number[]>();
  private readonly deps: PaneWakeDeps;

  constructor(deps: PaneWakeDeps) {
    this.deps = deps;
  }

  noteArrived(botId: string, threadId: string, paneId?: string): void {
    if (!this.deps.enabled(botId) || this.deps.paused?.(botId)) return;
    const key = `${botId}\0${threadId}`;
    const entry = this.pending.get(key) ?? { botId, threadId, timer: null, panes: new Set(), unknownPane: false, notes: 0, checking: false };
    if (paneId) entry.panes.add(paneId);
    else entry.unknownPane = true;
    entry.notes++;
    this.pending.set(key, entry);
    this.arm(key, entry);
  }

  /** Any turn settled: retry every burst that found its bot busy. */
  settled(): void {
    for (const [key, entry] of this.pending) this.arm(key, entry);
  }

  forgetBot(botId: string): void {
    for (const [key, entry] of this.pending) {
      if (entry.botId !== botId) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(key);
    }
    this.wakes.delete(botId);
  }

  private arm(key: string, entry: Pending): void {
    if (entry.timer) return;
    entry.timer = setTimeout(() => this.fire(key, entry), PANE_WAKE_DEBOUNCE_MS);
    entry.timer.unref?.();
  }

  private fire(key: string, entry: Pending): void {
    entry.timer = null;
    // the check in flight re-arms if it needs to
    if (entry.checking) return;
    const { botId, threadId } = entry;
    if (this.deps.busy(botId, threadId)) return;
    if (!this.deps.enabled(botId) || this.deps.paused?.(botId) || !this.deps.hasNotes(threadId)) {
      this.pending.delete(key);
      return;
    }
    if (!entry.unknownPane && entry.panes.size > 0 && this.deps.closedByBot) {
      void this.check(key, entry, this.deps.closedByBot);
      return;
    }
    this.pending.delete(key);
    this.wake(key, entry);
  }

  /** Drops a burst whose panes the bot closed itself; any doubt wakes. */
  private async check(key: string, entry: Pending, closedByBot: NonNullable<PaneWakeDeps["closedByBot"]>): Promise<void> {
    const { botId, threadId } = entry;
    const notes = entry.notes;
    entry.checking = true;
    let closed = false;
    try {
      closed = await closedByBot(botId, [...entry.panes]);
    } catch {}
    entry.checking = false;
    if (this.pending.get(key) !== entry) return;
    if (entry.notes !== notes) return this.arm(key, entry);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (this.deps.busy(botId, threadId)) return;
    this.pending.delete(key);
    if (!this.deps.enabled(botId) || this.deps.paused?.(botId) || !this.deps.hasNotes(threadId)) return;
    if (closed) return this.deps.skipped?.(botId, threadId);
    this.wake(key, entry);
  }

  private wake(key: string, entry: Pending): void {
    const { botId, threadId } = entry;
    const now = this.deps.now?.() ?? Date.now();
    const recent = (this.wakes.get(botId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= PANE_WAKE_HOURLY_CAP) {
      this.wakes.set(botId, recent);
      // a dropped wake strands the note until the user writes; retry once the oldest wake ages out
      const retryMs = recent[0]! + HOUR_MS - now + PANE_WAKE_DEBOUNCE_MS;
      this.deps.warn(`pane wake: ${botId} hit ${PANE_WAKE_HOURLY_CAP} wakes this hour; retrying in ${Math.ceil(retryMs / 60_000)} min`);
      this.pending.set(key, entry);
      entry.timer = setTimeout(() => this.fire(key, entry), retryMs);
      entry.timer.unref?.();
      return;
    }
    this.wakes.set(botId, [...recent, now]);
    this.deps.wake(botId, threadId);
  }
}
