// Which requests arrived through the phone relay. Keyed on socket identity
// (docs/phone-relay-design.md section 9): the relay ingress marks every
// socket it hands to the http.Server, so no header can fake it.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const relaySockets = new WeakSet<Duplex>();

/** Called by the relay ingress for each socket before it reaches http.Server. */
export function markRelaySocket(socket: Duplex): void {
  relaySockets.add(socket);
}

export function isRelayRequest(req: IncomingMessage): boolean {
  return relaySockets.has(req.socket);
}
