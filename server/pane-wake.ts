export const PANE_WAKE_PROMPT = "A pane note arrived. Act on it.";
export const PANE_WAKE_DEBOUNCE_MS = 3_000;
export const PANE_WAKE_HOURLY_CAP = 20;
const HOUR_MS = 60 * 60 * 1000;

export interface PaneWakeDeps {
  enabled(botId: string): boolean;
  busy(botId: string, threadId: string): boolean;
  /** A user turn since the note already delivered it. */
  hasNotes(threadId: string): boolean;
  wake(botId: string, threadId: string): void;
  warn(line: string): void;
  now?(): number;
}

interface Pending {
  botId: string;
  threadId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One teacher turn per burst of pane notes, only once the bot is idle. */
export class PaneWakeScheduler {
  private readonly pending = new Map<string, Pending>();
  private readonly wakes = new Map<string, number[]>();
  private readonly deps: PaneWakeDeps;

  constructor(deps: PaneWakeDeps) {
    this.deps = deps;
  }

  noteArrived(botId: string, threadId: string): void {
    if (!this.deps.enabled(botId)) return;
    const key = `${botId}\0${threadId}`;
    const entry = this.pending.get(key) ?? { botId, threadId, timer: null };
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
    const { botId, threadId } = entry;
    if (this.deps.busy(botId, threadId)) return;
    this.pending.delete(key);
    if (!this.deps.enabled(botId) || !this.deps.hasNotes(threadId)) return;
    const now = this.deps.now?.() ?? Date.now();
    const recent = (this.wakes.get(botId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= PANE_WAKE_HOURLY_CAP) {
      this.wakes.set(botId, recent);
      this.deps.warn(`pane wake: ${botId} hit ${PANE_WAKE_HOURLY_CAP} wakes this hour; note stored, no turn started`);
      return;
    }
    this.wakes.set(botId, [...recent, now]);
    this.deps.wake(botId, threadId);
  }
}
