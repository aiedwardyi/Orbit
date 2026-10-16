// Sidebar search and the in-chat find bar share one matcher: every copy of
// the query is marked, and a click starts on the row the person chose.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { useStore, type AppState } from "@/state/store";

const FIND_HIGHLIGHT = "orbit-find";
const CURRENT_HIGHLIGHT = "orbit-find-current";
const UNCLAMP = "data-find-unclamp";

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

/** Exact-phrase matches only, like /api/search, so highlights agree with N/M. */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const phrase = query.trim();
  if (!text) return [];
  if (!phrase) return [{ text, match: false }];
  const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index), match: false });
    parts.push({ text: match[0], match: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}

export interface FindStop<T extends { messageId: string; matches?: number }> {
  hit: T;
  /** which copy inside the row, top to bottom */
  occurrence: number;
}

/** One stop per copy, newest first, so each message runs bottom copy to top. */
export function findStops<T extends { messageId: string; matches?: number }>(hits: readonly T[]): FindStop<T>[] {
  return hits.flatMap((hit) => {
    const count = Math.max(1, hit.matches ?? 1);
    return Array.from({ length: count }, (_, i) => ({ hit, occurrence: count - 1 - i }));
  });
}

/** Older is +1, up the page; newer is -1. No wrap: null at an end, "more" when an older page is left. */
export function stepFind(index: number, delta: 1 | -1, total: number, more: boolean): number | "more" | null {
  const next = index + delta;
  if (next < 0) return null;
  if (next >= total) return more ? "more" : null;
  return next;
}

/** The newest stop, or the clicked message's first copy. Null when that row is not in this result set. */
export function findHitIndex(
  stops: readonly FindStop<{ messageId: string; matches?: number }>[],
  messageId: string | null | undefined,
): number | null {
  if (!stops.length) return null;
  if (!messageId) return 0;
  const index = stops.findIndex((stop) => stop.hit.messageId === messageId && stop.occurrence === 0);
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

// The hit find last landed on. Transcripts reveal its row; paints mark its copy strong.
let current: { messageId: string; query: string; occurrence?: number } | null = null;
let unclamped: Element[] = [];
const currentListeners = new Set<() => void>();

function sameQuery(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function setFindCurrent(next: { messageId: string; query: string; occurrence?: number } | null): void {
  if (
    current?.messageId === next?.messageId &&
    current?.occurrence === next?.occurrence &&
    sameQuery(current?.query ?? "", next?.query ?? "")
  ) return;
  current = next;
  for (const element of unclamped) element.removeAttribute(UNCLAMP);
  unclamped = [];
  for (const listener of currentListeners) listener();
}

export function findCurrentId(): string | null {
  return current?.messageId ?? null;
}

export function subscribeFindCurrent(listener: () => void): () => void {
  currentListeners.add(listener);
  return () => currentListeners.delete(listener);
}

export function useFindCurrentId(): string | null {
  return useSyncExternalStore(subscribeFindCurrent, findCurrentId, findCurrentId);
}

/** The landed copy inside the row, else a link whose href holds the phrase. */
function currentRange(wrapper: Element, query: string, ranges: readonly Range[], occurrence = 0): Range | null {
  const inRow = ranges.filter((range) => wrapper.contains(range.startContainer));
  if (inRow.length) return inRow[Math.min(occurrence, inRow.length - 1)];
  const phrase = query.trim().toLowerCase();
  const link = [...wrapper.querySelectorAll("a[href]")].find((anchor) =>
    (anchor.getAttribute("href") ?? "").toLowerCase().includes(phrase),
  );
  if (!link) return null;
  const range = document.createRange();
  range.selectNodeContents(link);
  return range;
}

export function clearChatFindHighlight(): void {
  highlightHost().CSS?.highlights?.delete(FIND_HIGHLIGHT);
  highlightHost().CSS?.highlights?.delete(CURRENT_HIGHLIGHT);
}

/** The landed row, or the step an approval notice was folded onto. */
export function findRowSelector(messageId: string): string {
  const id = CSS.escape(messageId);
  return `[data-mid="${id}"], [data-find-for~="${id}"]`;
}

/** Paints every match soft and the current one strong; returns the current range. */
export function paintChatFindHighlight(root: ParentNode, query: string): Range | null {
  clearChatFindHighlight();
  const host = highlightHost();
  const registry = host.CSS?.highlights;
  const HighlightCtor = host.Highlight;
  if (!registry || !HighlightCtor) return null;
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
  const wrapper = current && sameQuery(current.query, query)
    ? root.querySelector(findRowSelector(current.messageId))
    : null;
  const strong = wrapper ? currentRange(wrapper, query, ranges, current?.occurrence) : null;
  const soft = ranges.filter((range) => range !== strong);
  if (soft.length) registry.set(FIND_HIGHLIGHT, new HighlightCtor(...soft));
  if (strong) registry.set(CURRENT_HIGHLIGHT, new HighlightCtor(strong));
  return strong;
}

/** Unclamps what hides the current match, paints, and returns the range to scroll to. */
export function revealFindMatch(root: ParentNode, messageId: string): Range | null {
  if (current?.messageId !== messageId) return null;
  const range = paintChatFindHighlight(root, current.query);
  const wrapper = range && root.querySelector(findRowSelector(messageId));
  if (!range || !wrapper) return range;
  for (let element = range.startContainer.parentElement; element && element !== wrapper; element = element.parentElement) {
    const style = getComputedStyle(element);
    const clips = [style.overflowX, style.overflowY].some((value) => value === "hidden" || value === "clip");
    const isTextParent = element === range.startContainer.parentElement;
    if (clips || style.whiteSpace === "nowrap" || (style.maxHeight || "none") !== "none" || (isTextParent && style.flexShrink === "0")) {
      element.setAttribute(UNCLAMP, "");
      unclamped.push(element);
    }
  }
  return range;
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
