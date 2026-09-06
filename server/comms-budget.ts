// One turn's ask_bot budget, keyed by the asking thread and released when
// that turn settles.
//
// MAX_COMMS_DEPTH stops recursion but not breadth: every peer a bot asks
// runs a full turn on its own model with a four-minute ceiling, and under a
// room's "everyone" policy each member can ask every other while they sit
// idle. create_bot and delegate_bot are both capped at four per turn; this
// is ask_bot's half of the same rule.

export const MAX_ASKS_PER_TURN = 4;

const asksThisTurn = new Map<string, number>();

/** Take one of this turn's asks. False once the turn has spent them all. */
export function claimAsk(sourceThreadId: string): boolean {
  const used = asksThisTurn.get(sourceThreadId) ?? 0;
  if (used >= MAX_ASKS_PER_TURN) return false;
  asksThisTurn.set(sourceThreadId, used + 1);
  return true;
}

/** Called on the asking thread's turn.completed, whatever its outcome. */
export function clearAskBudget(sourceThreadId: string): void {
  asksThisTurn.delete(sourceThreadId);
}
