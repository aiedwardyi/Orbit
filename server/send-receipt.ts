import type { Message } from "./store.ts";

/** Result of startTurn / startClaimedTurn. A prepare failure still persists
 * the user line, but must not look like a successful dispatch. */
export type StartedTurn = {
  message: Message;
  dispatchFailed?: boolean;
  cancelled?: boolean;
  error?: string;
};

export function startedTurn(
  message: Message,
  extra?: { dispatchFailed?: boolean; cancelled?: boolean; error?: string },
): StartedTurn {
  return {
    message,
    ...(extra?.dispatchFailed ? { dispatchFailed: true as const, error: extra.error } : {}),
    ...(extra?.cancelled ? { cancelled: true as const } : {}),
  };
}

export function sendPostReceipt(started: StartedTurn, threadId: string) {
  return {
    ok: true as const,
    threadId,
    message: started.message,
    ...(started.dispatchFailed ? { dispatchFailed: true as const, error: started.error } : {}),
    ...(started.cancelled ? { cancelled: true as const } : {}),
  };
}
