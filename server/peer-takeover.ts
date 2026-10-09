// A turn a teammate started (delegate_bot, ask_bot) becomes the user's the
// moment the user's own message joins it. From then on nothing that turn says
// is the teammate's answer: an ask settles with what came before, and a
// delegation runs again as its own turn (delegations.ts).
//
// Only user words take a turn over: the send route's steer and the queued
// sends a starting turn folds in. Pane notes, narration notices and other
// control-plane steers never call takeOverPeerTurn.

const peerTurns = new Map<string, () => void>(); // target threadId → takeover

/** Watch one peer-started turn on `threadId` for a user takeover. */
export function onPeerTakeover(threadId: string, handler: () => void): void {
  peerTurns.set(threadId, handler);
}

/** The peer turn on `threadId` ended; a later message is not a takeover. */
export function endPeerTurn(threadId: string): void {
  peerTurns.delete(threadId);
}

/** The user's message joined the running turn on `threadId`. True when that
 * turn was a teammate's. */
export function takeOverPeerTurn(threadId: string): boolean {
  const handler = peerTurns.get(threadId);
  if (!handler) return false;
  peerTurns.delete(threadId);
  handler();
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
    endPeerTurn(threadId);
    resolve(out);
  };
  onPeerTakeover(threadId, () =>
    finish(text || `${botName} switched to ${userName()}'s message before answering. Ask again later.`),
  );
  return {
    add: (step: string) => {
      if (!done) text += (text ? "\n" : "") + step;
    },
    end: (fallback: string) => finish(text || fallback),
  };
}
