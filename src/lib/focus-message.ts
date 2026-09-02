// Landing on a message: after a search hit, scroll the row into view and
// flash it. Rows are wrapped in `display: contents` (no box of their own),
// so the wrapper carries data-mid and its last child — the bubble/chip,
// after any day separator — is what gets scrolled and highlighted.
import { useEffect } from "react";
import { api, useStore, type Action, type AppState } from "@/state/store";
import type { SearchHit } from "@/lib/search-hit";

const FLASH_CLASSES = ["ring-2", "ring-accent/70", "rounded-2xl", "transition-shadow"];

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
  container.scrollTop += tRect.top + tRect.height / 2 - (cRect.top + cRect.height / 2);
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

/** Select and prepare the exact conversation represented by a search hit. */
export async function landOnSearchHit(
  hit: SearchHit,
  state: Pick<AppState, "bots" | "groups">,
  dispatch: React.Dispatch<Action>,
): Promise<void> {
  const ownerId = hit.botId ?? hit.groupId;
  const bot = hit.botId ? state.bots.find((candidate) => candidate.id === hit.botId) : undefined;
  const group = hit.groupId ? state.groups.find((candidate) => candidate.id === hit.groupId) : undefined;
  if (!ownerId || (!bot && !group)) throw new Error("That conversation is no longer available.");

  dispatch({ type: "select", id: ownerId });
  if (bot && bot.threadId !== hit.threadId) {
    const result = await api(`/api/bots/${bot.id}/tasks/${hit.threadId}`, { method: "POST" });
    if (result?.bot) dispatch({ type: "taskSwitched", bot: result.bot });
  }
  if (group && group.threadId !== hit.threadId) {
    const result = await api(`/api/groups/${group.id}/tasks/${hit.threadId}`, { method: "POST" });
    if (result?.group) dispatch({ type: "groupPatched", group: result.group });
  }
  if (bot && !hit.onActivePath) {
    const branch = await api(`/api/bots/${bot.id}/active-branch`, {
      method: "POST",
      body: JSON.stringify({ messageId: hit.messageId }),
    });
    if (branch?.activeLeafId) {
      dispatch({ type: "threadActive", threadId: hit.threadId, activeLeafId: branch.activeLeafId });
    }
  }
  dispatch({ type: "focusMessage", threadId: hit.threadId, messageId: hit.messageId });
}

export function useFocusMessage(threadId: string, ready: boolean) {
  const { state, dispatch } = useStore();
  const focus = state.focusMessage;
  useEffect(() => {
    if (!focus || focus.consumed || focus.threadId !== threadId || !ready) return;
    // messages may land a tick after the task switch; try briefly
    let tries = 0;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    let target: HTMLElement | null = null;
    const attempt = () => {
      if (cancelled) return;
      const wrapper = document.querySelector<HTMLElement>(`[data-mid="${CSS.escape(focus.messageId)}"]`);
      target = wrapper?.lastElementChild as HTMLElement | null;
      if (!target) {
        if (tries++ < 20) retryTimer = setTimeout(attempt, 100);
        return;
      }
      const scroller = target.closest("[data-orbit-transcript]");
      if (scroller instanceof HTMLElement) scrollElementIntoContainer(scroller, target);
      else {
        const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        target.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
      }
      restoreChatChrome();
      target.classList.add(...FLASH_CLASSES);
      // Consume only after the target is mounted and the flash has begun.
      // `consumed` is intentionally not an effect dependency, so this active
      // flash survives the bookkeeping update while future remounts ignore it.
      dispatch({ type: "focusMessageConsumed", nonce: focus.nonce });
      flashTimer = setTimeout(() => target?.classList.remove(...FLASH_CLASSES), 1800);
    };
    attempt();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (flashTimer) clearTimeout(flashTimer);
      target?.classList.remove(...FLASH_CLASSES);
    };
  }, [dispatch, focus?.nonce, focus?.threadId, focus?.messageId, threadId, ready]);
}
