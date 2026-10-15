// `deliver: "after"` keeps a busy bot's send in the steer queue for its own turn.
import type { ProviderAdapter } from "./contracts.ts";

type SteerAdapter = { capabilities: { queueing?: boolean }; steer?: ProviderAdapter["steer"] };

/** The send joins the running turn: busy, a steering engine, and not sent "after this turn". */
export function steersSend<A extends SteerAdapter>(
  adapter: A | undefined,
  busy: boolean | undefined,
  after: boolean,
): adapter is A & { steer: NonNullable<A["steer"]> } {
  return busy === true && !after && adapter?.capabilities.queueing === true && adapter.steer !== undefined;
}
