// A turn a teammate started (delegate_bot, ask_bot) becomes the user's the
// moment the user's own message joins it. From then on nothing that turn says
// is the teammate's answer: an ask settles with what came before, and a
// delegation runs again as its own turn (delegations.ts).
//
// Only user words take a turn over: the send route's steer and the queued
// sends a starting turn folds in. Pane notes, narration notices and other
// control-plane steers never call takeOverPeerTurn.

const peerTurns = new Map<string, Set<() => void>>(); // target threadId → takeovers

/** Watch one peer-started turn on `threadId` for a user takeover. Call the
 * returned function when that turn ends; other watches on the thread stay. */
export function onPeerTakeover(threadId: string, handler: () => void): () => void {
  const handlers = peerTurns.get(threadId) ?? new Set();
  handlers.add(handler);
  peerTurns.set(threadId, handlers);
  return () => {
    handlers.delete(handler);
    if (!handlers.size && peerTurns.get(threadId) === handlers) peerTurns.delete(threadId);
  };
}

/** The user's message joined the running turn on `threadId`. True when that
 * turn was a teammate's. */
export function takeOverPeerTurn(threadId: string): boolean {
  const handlers = peerTurns.get(threadId);
  if (!handlers) return false;
  peerTurns.delete(threadId);
  for (const handler of handlers) handler();
  return true;
}

/** ask_bot's answer: the turn's text until it ends, or until the user takes it over. */
export function peerAnswer(
  threadId: string,
  botName: string,
  userName: () => string,
  resolve: (text: string) => void,
) {
  let text = "";
  let done = false;
  const finish = (out: string) => {
    if (done) return;
    done = true;
    endTakeover();
    resolve(out);
  };
  const endTakeover = onPeerTakeover(threadId, () =>
    finish(text || `${botName} switched to ${userName()}'s message before answering. Ask again later.`),
  );
  return {
    add: (step: string) => {
      if (!done) text += (text ? "\n" : "") + step;
    },
    end: (fallback: string) => finish(text || fallback),
  };
}
