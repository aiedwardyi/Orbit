// Sidebar search and the in-chat find bar share one matcher: every copy of
// the query is marked, and a click starts on the row the person chose.
import { useCallback, useEffect, useState } from "react";

import { useStore, type AppState } from "@/state/store";

const FIND_HIGHLIGHT = "orbit-find";

interface FindHighlights {
  delete(name: string): void;
  set(name: string, value: Highlight): void;
}

interface HighlightHost {
  CSS?: { highlights?: FindHighlights };
  Highlight?: typeof Highlight;
}

function highlightHost(): HighlightHost {
  // SAFETY: HighlightRegistry only types forEach. Chromium's registry is a Map; happy-dom omits it and Highlight.
  return globalThis as HighlightHost;
}

export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const phrase = query.trim().toLowerCase();
  if (!text) return [];
  if (!phrase) return [{ text, match: false }];
  if (text.toLowerCase().includes(phrase)) return markAll(text, [phrase]);
  const words = [...new Set(phrase.split(/\s+/).filter((word) => word.length > 1))];
  if (words.length < 2) return [{ text, match: false }];
  return markAll(text, words);
}

function markAll(text: string, needles: string[]): Array<{ text: string; match: boolean }> {
  const lower = text.toLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    let bestAt = -1;
    let bestLen = 0;
    for (const needle of needles) {
      const at = lower.indexOf(needle, cursor);
      if (at < 0) continue;
      if (bestAt < 0 || at < bestAt || (at === bestAt && needle.length > bestLen)) {
        bestAt = at;
        bestLen = needle.length;
      }
    }
    if (bestAt < 0) break;
    if (bestAt > cursor) parts.push({ text: text.slice(cursor, bestAt), match: false });
    parts.push({ text: text.slice(bestAt, bestAt + bestLen), match: true });
    cursor = bestAt + bestLen;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

/** Index of the clicked message. Null when that row is not in this result set. */
export function findHitIndex(
  hits: readonly { messageId: string }[],
  messageId: string | null | undefined,
): number | null {
  if (!hits.length) return null;
  if (!messageId) return 0;
  const index = hits.findIndex((hit) => hit.messageId === messageId);
  return index < 0 ? null : index;
}

/** Seed for a sidebar landing in this chat. A consumed landing stays shut on return. */
export function findSeedFor(
  focus: AppState["focusMessage"],
  threadId: string,
): { query: string; messageId: string; nonce: number } | null {
  if (!focus?.query || focus.consumed || focus.threadId !== threadId) return null;
  return { query: focus.query, messageId: focus.messageId, nonce: focus.nonce };
}

export function clearChatFindHighlight(): void {
  highlightHost().CSS?.highlights?.delete(FIND_HIGHLIGHT);
}

export function paintChatFindHighlight(root: ParentNode, query: string): void {
  clearChatFindHighlight();
  const host = highlightHost();
  const registry = host.CSS?.highlights;
  const HighlightCtor = host.Highlight;
  if (!registry || !HighlightCtor) return;
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = node.textContent ?? "";
    let offset = 0;
    for (const part of highlightParts(value, query)) {
      if (part.match) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + part.text.length);
        ranges.push(range);
      }
      offset += part.text.length;
    }
    node = walker.nextNode();
  }
  if (ranges.length) registry.set(FIND_HIGHLIGHT, new HighlightCtor(...ranges));
}

export function watchChatFindHighlight(root: HTMLElement, query: string): () => void {
  let frame = 0;
  const apply = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => paintChatFindHighlight(root, query));
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(root, { subtree: true, childList: true, characterData: true });
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    clearChatFindHighlight();
  };
}

export function useSearchFindSeed(threadId: string) {
  const { state } = useStore();
  const [findOpen, setFindOpen] = useState(false);
  const [findSeed, setFindSeed] = useState<{ query: string; messageId: string; nonce: number } | null>(null);

  useEffect(() => {
    setFindOpen(false);
    setFindSeed(null);
  }, [threadId]);

  useEffect(() => {
    const seed = findSeedFor(state.focusMessage, threadId);
    if (!seed) return;
    setFindSeed(seed);
    setFindOpen(true);
  }, [state.focusMessage, threadId]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindSeed(null);
  }, []);
  const toggleFind = useCallback(() => {
    setFindOpen((open) => {
      if (open) setFindSeed(null);
      return !open;
    });
  }, []);
  const openFind = useCallback(() => setFindOpen(true), []);

  return { findOpen, findSeed, closeFind, toggleFind, openFind };
}
