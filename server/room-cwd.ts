// How a room member's turn picks its working folder. The room's pinned
// folder is a shared desk — it overrides the member's own default so every
// member works on the same files — except for a member whose engine runs
// with no host filesystem (Grok API, cloud box): its turn happens
// elsewhere, so handing it a host path would point it at a folder it
// cannot reach. Lives outside the dispatch path so the rule is testable
// without booting the server.

/** `memberDefault` is the private workspace the member falls back to;
 * undefined = the engine runs off-host. `memberPin` is the member's own
 * project folder: a bot pinned to a repo keeps working there in a room that
 * has no desk of its own, exactly as it does 1:1. `pinRoomCwd` is a callback
 * so off-host turns cannot accidentally decide the room's pin. */
export function groupTurnCwd(
  memberDefault: string | undefined,
  pinRoomCwd: () => string | null,
  memberPin?: string,
): string | undefined {
  if (memberDefault === undefined) return undefined;
  return pinRoomCwd() ?? memberPin ?? memberDefault;
}
