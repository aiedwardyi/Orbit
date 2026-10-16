// Landing on a message: after a search hit, scroll the row into view and
// flash it. Rows are wrapped in `display: contents` (no box of their own),
// so the wrapper carries data-mid and its last child — the bubble/chip,
// after any day separator — is what gets scrolled and highlighted.
import { useLayoutEffect } from "react";
import { api, useStore, type Action } from "@/state/store";
import { findCurrentId, findRowSelector, revealFindMatch, subscribeFindCurrent } from "@/lib/chat-find";
import type { SearchHit } from "@/lib/search-hit";

interface SearchOwner {
  id: string;
  threadId: string;
}

interface SearchLandingState {
  bots: readonly SearchOwner[];
  groups: readonly SearchOwner[];
}

const FLASH_CLASSES = ["ring-2", "ring-accent/70", "rounded-2xl", "transition-shadow"];
// Widens the ring past a bot row's bare text without moving the text.
const BOT_ROW_ROOM = ["box-content", "px-3", "-mx-3"];
const TALL_TARGET_MARGIN = 16;

/** Scroll a message into the transcript pane without moving the window.
 * `scrollIntoView({ block: "center" })` walks every scrollable ancestor,
 * including the Electron visual viewport — that hides the chat header and
 * leaves a black bar at the bottom after in-chat find. */
export function scrollElementIntoContainer(
  container: { scrollTop: number; getBoundingClientRect(): { top: number; height: number } },
  target: { getBoundingClientRect(): { top: number; height: number } },
): void {
  const cRect = container.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();
  container.scrollTop += tRect.height > cRect.height
    ? tRect.top - cRect.top - TALL_TARGET_MARGIN
    : tRect.top + tRect.height / 2 - (cRect.top + cRect.height / 2);
}

/** Pin the window back to the top-left after find closes or a search lands. */
export function restoreChatChrome(
  win: { scrollTo(x: number, y: number): void } = window,
  doc: { documentElement?: { scrollTop: number }; body?: { scrollTop: number } } = document,
): void {
  win.scrollTo(0, 0);
  if (doc.documentElement) doc.documentElement.scrollTop = 0;
  if (doc.body) doc.body.scrollTop = 0;
}

// Rapid landings race: only the latest click may replace the transcript.
let landGeneration = 0;

/** Select and prepare the exact conversation represented by a search hit. */
export async function landOnSearchHit(
  hit: SearchHit,
  state: SearchLandingState,
  dispatch: React.Dispatch<Action>,
  query?: string,
): Promise<void> {
  const generation = ++landGeneration;
  const stale = () => generation !== landGeneration;
  const ownerId = hit.botId ?? hit.groupId;
  const bot = hit.botId ? state.bots.find((candidate) => candidate.id === hit.botId) : undefined;
  const group = hit.groupId ? state.groups.find((candidate) => candidate.id === hit.groupId) : undefined;
  if (!ownerId || (!bot && !group)) throw new Error("That conversation is no longer available.");

  dispatch({ type: "select", id: ownerId });
  if (bot && bot.threadId !== hit.threadId) {
    const result = await api(`/api/bots/${bot.id}/tasks/${hit.threadId}`, { method: "POST" });
    if (stale()) return;
    if (result?.bot) dispatch({ type: "taskSwitched", bot: result.bot });
  }
  if (group && group.threadId !== hit.threadId) {
    const result = await api(`/api/groups/${group.id}/tasks/${hit.threadId}`, { method: "POST" });
    if (stale()) return;
    if (result?.group) dispatch({ type: "groupPatched", group: result.group });
  }
  if (bot && !hit.onActivePath) {
    const branch = await api(`/api/bots/${bot.id}/active-branch`, {
      method: "POST",
      body: JSON.stringify({ messageId: hit.messageId }),
    });
    if (stale()) return;
    if (branch?.activeLeafId) {
      dispatch({ type: "threadActive", threadId: hit.threadId, activeLeafId: branch.activeLeafId });
    }
  }
  if (stale()) return;
  dispatch({
    type: "focusMessage",
    threadId: hit.threadId,
    messageId: hit.messageId,
    query: query?.trim() || undefined,
  });
}

export function useFocusMessage(threadId: string, ready: boolean) {
  const { state, dispatch } = useStore();
  const focus = state.focusMessage;
  // Before paint: a scroll event fired between the window's commit and the landing slides the window back over it.
  useLayoutEffect(() => {
    if (!focus || focus.consumed || focus.threadId !== threadId || !ready) return;
    // messages may land a tick after the task switch; try briefly
    let tries = 0;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let target: HTMLElement | null = null;
    let flash = FLASH_CLASSES;
    const attempt = () => {
      if (cancelled) return;
      const wrapper = document.querySelector<HTMLElement>(findRowSelector(focus.messageId));
      target = wrapper?.lastElementChild as HTMLElement | null;
      if (!target) {
        if (tries++ < 20) retryTimer = setTimeout(attempt, 100);
        return;
      }
      const scroller = target.closest("[data-orbit-transcript]");
      const match = scroller ? revealFindMatch(scroller, focus.messageId) : null;
      if (scroller instanceof HTMLElement) scrollElementIntoContainer(scroller, match ?? target);
      else {
        const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        target.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
      }
      restoreChatChrome();
      if (target.dataset.orbitMessage === "bot") flash = [...FLASH_CLASSES, ...BOT_ROW_ROOM];
      target.classList.add(...flash);
      // Consume only after the target is mounted and the flash has begun.
      // `consumed` is intentionally not an effect dependency, so this active
      // flash survives the bookkeeping update while future remounts ignore it.
      dispatch({ type: "focusMessageConsumed", nonce: focus.nonce });
      const unflash = () => target?.classList.remove(...flash);
      // a find hit with nothing to mark keeps its ring until find moves on
      if (!match && findCurrentId() === focus.messageId) {
        unsubscribe = subscribeFindCurrent(() => {
          if (findCurrentId() !== focus.messageId) unflash();
        });
      } else flashTimer = setTimeout(unflash, 1800);
    };
    attempt();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (flashTimer) clearTimeout(flashTimer);
      unsubscribe?.();
      target?.classList.remove(...flash);
    };
  }, [dispatch, focus?.nonce, focus?.threadId, focus?.messageId, threadId, ready]);
}
