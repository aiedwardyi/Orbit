// Which provider sessions already hold which system text, for engines with no
// system slot: a resumed session that holds the exact text gets only the turn
// text. One ledger per driver instance, so a restart re-sends once.
import { createHash } from "node:crypto";

export function systemLedger() {
  const held = new Map<string, string>();
  const digest = (system: string) => createHash("sha256").update(system).digest("hex");
  return {
    holds: (sessionId: string, system: string) => held.get(sessionId) === digest(system),
    /** Only after the provider accepted a prompt carrying this text. */
    record: (sessionId: string, system: string) => {
      held.set(sessionId, digest(system));
    },
    forget: (sessionId: string) => {
      held.delete(sessionId);
    },
  };
}
