import { statSync } from "node:fs";

import type { GroupRecord, Store } from "./store.ts";

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

export function canChangeRoomCwd(pinned: string | null | undefined): boolean {
  if (pinned === undefined) return true;
  if (pinned === null) return false;
  try {
    return !statSync(pinned).isDirectory();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

export function repinRoomCwd(store: Store, group: GroupRecord, cwd: string | undefined): void {
  if (group.pinnedCwd === undefined) return;
  const task = store.groupTaskByThread(group.id, group.threadId);
  if (!task) return;
  // The caller persists these pins with patchGroup after validating the whole patch.
  task.pinnedCwd = cwd ?? null;
  group.pinnedCwd = task.pinnedCwd;
  for (const botId of group.memberIds) store.clearResumeCursors(botId, task.threadId);
}
