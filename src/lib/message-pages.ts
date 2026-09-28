// Hydrate holds only the newest page of each conversation. Older pages come
// from the scrollback endpoint one at a time, when the reader reaches the top.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, MESSAGE_PAGE, type Action, type Message } from "@/state/store";

export async function fetchOlderPage(threadId: string, before: string): Promise<{ messages: Message[]; hasMore: boolean }> {
  const page = await api(`/api/threads/${threadId}/messages?limit=${MESSAGE_PAGE}&before=${encodeURIComponent(before)}`);
  return { messages: Array.isArray(page?.messages) ? page.messages : [], hasMore: page?.hasMore === true };
}

/** Pixels a paged screen message left out. */
export function screenImageUrl(threadId: string, messageId: string): string {
  return `/api/threads/${threadId}/messages/${messageId}/image`;
}

const lookups = new Map<string, Promise<Message | null>>();

function lookupMessage(threadId: string, messageId: string): Promise<Message | null> {
  const key = `${threadId}:${messageId}`;
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = api(`/api/threads/${threadId}/messages?around=${encodeURIComponent(messageId)}&limit=1`)
      .then((page) => (page?.messages as Message[] | undefined)?.find((message) => message.id === messageId) ?? null)
      .catch(() => {
        lookups.delete(key);
        return null;
      });
    lookups.set(key, lookup);
  }
  return lookup;
}

/** A pinned or quoted message, fetched alone when it is older than every loaded page. */
export function useThreadMessage(threadId: string, messageId: string | undefined, held: Message | undefined): Message | undefined {
  const [fetched, setFetched] = useState<Message | null>(null);
  const missing = Boolean(messageId && !held);
  useEffect(() => {
    if (!missing || !messageId) return;
    let alive = true;
    void lookupMessage(threadId, messageId).then((message) => {
      if (alive) setFetched(message);
    });
    return () => {
      alive = false;
    };
  }, [threadId, messageId, missing]);
  return held ?? (fetched && fetched.id === messageId ? fetched : undefined);
}

/** Loads the page before `oldestId`, one request at a time. `beforeCommit`
 * runs just before the page lands, so a caller can measure the old layout. */
export function useOlderMessages(
  dispatch: React.Dispatch<Action>,
  threadId: string,
  oldestId: string | undefined,
  hasMore: boolean | undefined,
) {
  const inflight = useRef(false);
  return useCallback(
    (beforeCommit?: () => void) => {
      if (!hasMore || !oldestId || inflight.current) return;
      inflight.current = true;
      fetchOlderPage(threadId, oldestId)
        .then((page) => {
          beforeCommit?.();
          dispatch({ type: "olderMessages", threadId, before: oldestId, ...page });
        })
        .catch(() => {})
        .finally(() => {
          inflight.current = false;
        });
    },
    [dispatch, threadId, oldestId, hasMore],
  );
}
