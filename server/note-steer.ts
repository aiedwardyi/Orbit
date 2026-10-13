import { paneNotesForTurn } from "./context-compaction.ts";
import type { Message } from "./store.ts";

export interface NoteSteerDeps {
  enabled(botId: string): boolean;
  paused(botId: string): boolean;
  /** The teacher's turn on this thread, once its dispatch has moved the watermark. */
  liveTurn(botId: string, threadId: string): string | undefined;
  busy(botId: string, threadId: string): boolean;
  /** Undefined when the engine cannot steer. */
  steer(botId: string, threadId: string, text: string): Promise<boolean> | undefined;
  messages(threadId: string): Message[];
  deliveredId(botId: string, threadId: string): string | undefined;
  markDelivered(botId: string, threadId: string, noteId: string | undefined): void;
  wake(botId: string, threadId: string, paneId?: string): void;
}

/** Steers pane notes into the teacher's live turn, one thread at a time; anything else waits for the wake. */
export class NoteSteerer {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly deps: NoteSteerDeps;

  constructor(deps: NoteSteerDeps) {
    this.deps = deps;
  }

  noteArrived(botId: string, threadId: string, paneId?: string): Promise<void> {
    const key = `${botId}\0${threadId}`;
    const run = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.deliver(botId, threadId, paneId))
      .catch(() => this.wake(botId, threadId, paneId));
    this.chains.set(key, run);
    void run.finally(() => {
      if (this.chains.get(key) === run) this.chains.delete(key);
    });
    return run;
  }

  private async deliver(botId: string, threadId: string, paneId?: string): Promise<void> {
    // Sharing off or wakes paused: paneWake holds the note for the user's next turn.
    if (!this.deps.enabled(botId) || this.deps.paused(botId)) return this.wake(botId, threadId, paneId);
    const turnId = this.deps.liveTurn(botId, threadId);
    if (!turnId) return this.wake(botId, threadId, paneId);
    const deliveredId = this.deps.deliveredId(botId, threadId);
    const { notes, newestId } = paneNotesForTurn(this.deps.messages(threadId), new Set(), deliveredId, false);
    if (!notes.length) return;
    const steered = this.deps.steer(botId, threadId, notes.join("\n\n"));
    if (!steered || !(await steered.catch(() => false))) return this.wake(botId, threadId, paneId);
    // A turn started since read these notes for its own prefix, and its dispatch moves the watermark.
    if (this.deps.liveTurn(botId, threadId) !== turnId && this.deps.busy(botId, threadId)) return this.wake(botId, threadId, paneId);
    if (this.deps.deliveredId(botId, threadId) !== deliveredId) return;
    this.deps.markDelivered(botId, threadId, newestId);
  }

  private wake(botId: string, threadId: string, paneId?: string) {
    try {
      this.deps.wake(botId, threadId, paneId);
    } catch (err) {
      console.warn("pane note wake failed:", err instanceof Error ? err.message : String(err));
    }
  }
}
