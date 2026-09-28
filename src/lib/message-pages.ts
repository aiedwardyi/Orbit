// Hydrate holds only the newest page of each conversation. Older pages come
// from the scrollback endpoint one at a time, when the reader reaches the top.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type JumpWindow = { key: string; targetId: string; messages: Message[]; hasMore: boolean };

/** The branch through `targetId` in a fetched window: its ancestors, then the newest child at each fork. */
function windowBranch(messages: Message[], targetId: string): Message[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const children = new Map<string, Message>();
  for (const message of messages) if (message.parentId) children.set(message.parentId, message);
  const seen = new Set<string>();
  const path: Message[] = [];
  for (let cur = byId.get(targetId); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    path.unshift(cur);
  }
  for (let cur = children.get(targetId); cur && !seen.has(cur.id); cur = children.get(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
  }
  return path;
}

/** A bounded page around an old message, held apart from the live pages so a
 * jump never downloads the history in between. `key` scopes it to one view. */
export function useJumpWindow(
  dispatch: React.Dispatch<Action>,
  key: string,
  threadId: string,
  head: string | undefined,
  branched: boolean,
) {
  const [held, setHeld] = useState<JumpWindow | null>(null);
  const inflight = useRef(false);
  const latest = useRef(0);
  const current = held?.key === key ? held : null;
  const messages = useMemo(
    () => (current ? (branched ? windowBranch(current.messages, current.targetId) : current.messages) : null),
    [current, branched],
  );
  const open = useCallback(
    (messageId: string) => {
      const generation = ++latest.current;
      api(`/api/threads/${threadId}/messages?around=${encodeURIComponent(messageId)}&limit=${MESSAGE_PAGE}`)
        .then((page) => {
          if (generation !== latest.current) return;
          const rows: Message[] = Array.isArray(page?.messages) ? page.messages : [];
          const hasMore = page?.hasMore === true;
          // reaches the loaded pages: join them instead of opening a detached window
          const joins = head ? rows.findIndex((message) => message.id === head) : -1;
          if (joins >= 0) dispatch({ type: "olderMessages", threadId, before: head!, messages: rows.slice(0, joins), hasMore });
          else setHeld({ key, targetId: messageId, messages: rows, hasMore });
        })
        .catch(() => {});
    },
    [dispatch, key, threadId, head],
  );
  const older = useCallback(
    (beforeCommit?: () => void) => {
      const before = current?.messages[0]?.id;
      if (!current?.hasMore || !before || inflight.current) return;
      inflight.current = true;
      fetchOlderPage(threadId, before)
        .then((page) => {
          beforeCommit?.();
          setHeld((w) => {
            if (!w || w.key !== key || w.messages[0]?.id !== before) return w;
            const ids = new Set(w.messages.map((message) => message.id));
            return { ...w, messages: [...page.messages.filter((message) => !ids.has(message.id)), ...w.messages], hasMore: page.hasMore };
          });
        })
        .catch(() => {})
        .finally(() => (inflight.current = false));
    },
    [current, key, threadId],
  );
  const close = useCallback(() => setHeld(null), []);
  return { messages, hasMore: Boolean(current?.hasMore), open, older, close };
}

/** Loads the page before `oldestId`, one request at a time. `beforeCommit`
 * runs just before the page lands, so a caller can measure the old layout. */
export function useOlderMessages(
  dispatch: React.Dispatch<Action>,
  threadId: string,
  oldestId: string | undefined,
  hasMore: boolean | undefined,
) {
  // One view serves many threads; a page still loading for one must not block another.
  const inflight = useRef(new Set<string>());
  return useCallback(
    (beforeCommit?: () => void) => {
      if (!hasMore || !oldestId || inflight.current.has(threadId)) return;
      inflight.current.add(threadId);
      fetchOlderPage(threadId, oldestId)
        .then((page) => {
          beforeCommit?.();
          dispatch({ type: "olderMessages", threadId, before: oldestId, ...page });
        })
        .catch(() => {})
        .finally(() => inflight.current.delete(threadId));
    },
    [dispatch, threadId, oldestId, hasMore],
  );
}
