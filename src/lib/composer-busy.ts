// How the composer should look while a turn is in flight, and what Enter
// does with the live box.
//
// Rooms hold client-side lines while a member speaks and flush them FIFO
// on settle. A second Enter used to no-op after the first hold — Desktop
// QA then saw only ADV-QUEUE-0. Every busy send now enqueues (or POSTs
// for 1:1). 1:1 already POSTs mid-turn (steer-queue); lecturing the empty
// box about "the turn" made forever-chat feel like supervising an agent.
// Keep the queue; drop the gate-y chrome.
import { t, type MessageKey, type Translate } from "./i18n";

export type ComposerBusySendAction = "block" | "dispatch" | "enqueue";

/** What Enter should do. `heldCount` is informational — a room that
 * already holds a line still enqueues the next one. */
export function composerBusySendAction(input: {
  locked: boolean;
  isRoom: boolean;
  busy: boolean;
  heldCount?: number;
}): ComposerBusySendAction {
  if (input.locked) return "block";
  if (input.isRoom && input.busy) return "enqueue";
  return "dispatch";
}

/** Prefer the live textarea. A fill+Enter burst updates the DOM before
 * React re-renders; reading only the rendered draft resends QUEUE-0 or
 * sends "" and drops QUEUE-1..n. An empty live value wins so a second
 * Enter in the same tick cannot duplicate the line we just cleared. */
export function composerSendSourceText(
  liveValue: string | null | undefined,
  renderedText: string,
): string {
  return typeof liveValue === "string" ? liveValue : renderedText;
}

/** Take the oldest room hold so settle starts one POST at a time. */
export function peelNextBusyRoomSend<T>(queue: readonly T[]): { next: T | undefined; rest: T[] } {
  if (queue.length === 0) return { next: undefined, rest: [] };
  const [next, ...rest] = queue;
  return { next, rest };
}

export interface ComposerBusyInput {
  busy: boolean;
  isRoom: boolean;
  canSteer: boolean;
  name: string;
  idlePlaceholder: string;
}

export interface ComposerBusyChrome {
  placeholder: string;
  /** Clock + muted send — rooms only, where Enter queues instead of interrupting. */
  sendLooksQueued: boolean;
  sendAriaKey: MessageKey;
  sendTitleKey: MessageKey;
}

/** 1:1 pending chips, one per queued send — never joined into one line. */
export function pendingSteerEntries(
  pending: Record<string, Array<{ queueId: string; text: string }>> | undefined,
  threadId: string | undefined,
): Array<{ queueId: string; text: string }> {
  if (!threadId || !pending) return [];
  return pending[threadId] ?? [];
}

export function composerBusyChrome(
  input: ComposerBusyInput,
  translate: Translate = t,
): ComposerBusyChrome {
  if (!input.busy) {
    return {
      placeholder: input.idlePlaceholder,
      sendLooksQueued: false,
      sendAriaKey: "composer.sendMessage",
      sendTitleKey: "composer.send",
    };
  }
  if (input.isRoom) {
    return {
      placeholder: translate("composer.queueHint", { name: input.name }),
      sendLooksQueued: true,
      sendAriaKey: "composer.queueMessage",
      sendTitleKey: "composer.sendsWhenFinished",
    };
  }
  return {
    placeholder: input.idlePlaceholder,
    sendLooksQueued: false,
    sendAriaKey: input.canSteer ? "composer.sendIntoTurn" : "composer.sendMessage",
    sendTitleKey: input.canSteer ? "composer.sendIntoTurn" : "composer.send",
  };
}
