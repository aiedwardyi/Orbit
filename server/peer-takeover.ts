import type { Message } from "./store.ts";

// A turn a teammate started (delegate_bot, ask_bot) becomes the user's the
// moment the user's own message joins it. From then on nothing that turn says
// is the teammate's answer: an ask settles with what came before, and a
// delegation runs again as its own turn (delegations.ts).
//
// Only user words take a turn over: the send route's steer and the queued
// sends a starting turn folds in. Pane notes, narration notices and other
// control-plane steers never call takeOverPeerTurn.

const peerTurns = new Map<string, Set<(afterReply: boolean) => void>>(); // target threadId → takeovers

/** True while a teammate's turn on `threadId` still waits for its reply. */
export function hasPeerWatch(threadId: string): boolean {
  return peerTurns.has(threadId);
}

/** The stamp for a peer turn's assistant text row: its pending comm, once,
 * while the watch is live. Blank and summarized rows stay bare. */
export function takePeerReplyStamp(
  pending: Map<string, NonNullable<Message["comm"]>>,
  threadId: string,
  message: { text?: string; summarized?: boolean },
): NonNullable<Message["comm"]> | undefined {
  const comm = pending.get(threadId);
  if (!comm || message.summarized || !message.text?.trim()) return undefined;
  if (!hasPeerWatch(threadId)) return undefined;
  pending.delete(threadId);
  return comm;
}

/** Watch one peer-started turn on `threadId` for a user takeover. Call the
 * returned function when that turn ends; other watches on the thread stay. */
export function onPeerTakeover(threadId: string, handler: (afterReply: boolean) => void): () => void {
  const handlers = peerTurns.get(threadId) ?? new Set();
  handlers.add(handler);
  peerTurns.set(threadId, handlers);
  return () => {
    handlers.delete(handler);
    if (!handlers.size && peerTurns.get(threadId) === handlers) peerTurns.delete(threadId);
  };
}

/** The user's message joined the running turn on `threadId`. True when that
 * turn was a teammate's. `afterReply` means its reply had already finished. */
export function takeOverPeerTurn(threadId: string, afterReply = false): boolean {
  const handlers = peerTurns.get(threadId);
  if (!handlers) return false;
  peerTurns.delete(threadId);
  for (const handler of handlers) handler(afterReply);
  return true;
}

/** One mid-turn steer's takeover: when the model reads it and the route
 * accepts it, in either order. Without a read signal it takes over at accept. */
export function steerTakeover(threadId: string, signaled: boolean): {
  consumed: (taken: boolean, afterReply?: boolean) => void;
  accepted: () => void;
} {
  let signal: { taken: boolean; afterReply: boolean } | null = null;
  let accepted = false;
  let fired = false;
  const fire = () => {
    if (fired || !accepted) return;
    if (signaled && !signal) return;
    fired = true;
    takeOverPeerTurn(threadId, signal?.taken ? signal.afterReply : false);
  };
  return {
    consumed: (taken, afterReply) => {
      signal = { taken, afterReply: afterReply === true };
      fire();
    },
    accepted: () => {
      accepted = true;
      fire();
    },
  };
}

export const askSwitchedText = (botName: string, userName: string) =>
  `${botName} switched to ${userName}'s message before answering. Ask again later.`;

/** ask_bot's answer: the turn's text until it ends, or until the user takes it over. */
export function peerAnswer(
  threadId: string,
  botName: string,
  userName: () => string,
  resolve: (text: string, replied: boolean) => void,
) {
  let text = "";
  let done = false;
  const finish = (out: string, replied = true) => {
    if (done) return;
    done = true;
    endTakeover();
    resolve(out, replied && Boolean(text.trim()));
  };
  const endTakeover = onPeerTakeover(threadId, () =>
    finish(text || askSwitchedText(botName, userName())),
  );
  return {
    add: (step: string) => {
      if (!done) text += (text ? "\n" : "") + step;
    },
    end: (fallback: string, replied = true) => finish(text || fallback, replied),
  };
}
