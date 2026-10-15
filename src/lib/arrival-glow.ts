// One glow when a live reply lands in a chat that is not open. Per-chat
// state outside the store, so one chat's arrival never re-renders another
// row: rows subscribe to their own chat id only, while the controls that
// hide rows (phone menu, collapsed sidebar, section headers) subscribe to
// all and watch the ids they stand for.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AnimationEvent as ReactAnimationEvent } from "react";

import { isShownMessage } from "@/lib/shown-message";

/** Keyframes name in styles.css; the end handler ignores other animations. */
export const ARRIVAL_GLOW_ANIMATION = "arrival-glow-once";
/** A turn posting several bubbles glows once. */
export const ARRIVAL_GLOW_THROTTLE_MS = 10_000;

type Entry = { nonce: number; at: number };
const entries = new Map<string, Entry>();
const chatListeners = new Map<string, Set<() => void>>();
const allListeners = new Set<() => void>();
let nonceCounter = 0;
let version = 0;

/** Record an arrival for a chat. False when throttled to the previous glow. */
export function noteArrival(chatId: string, now: number = Date.now()): boolean {
  const prev = entries.get(chatId);
  if (prev && now - prev.at < ARRIVAL_GLOW_THROTTLE_MS) return false;
  nonceCounter += 1;
  entries.set(chatId, { nonce: nonceCounter, at: now });
  version += 1;
  chatListeners.get(chatId)?.forEach((notify) => notify());
  allListeners.forEach((notify) => notify());
  return true;
}

export function subscribeArrival(chatId: string, notify: () => void): () => void {
  let set = chatListeners.get(chatId);
  if (!set) {
    set = new Set();
    chatListeners.set(chatId, set);
  }
  set.add(notify);
  return () => {
    set.delete(notify);
    if (set.size === 0 && chatListeners.get(chatId) === set) chatListeners.delete(chatId);
  };
}

function subscribeArrivalAll(notify: () => void): () => void {
  allListeners.add(notify);
  return () => {
    allListeners.delete(notify);
  };
}

export function arrivalNonce(chatId: string): number {
  return entries.get(chatId)?.nonce ?? 0;
}

function arrivalVersion(): number {
  return version;
}

/** Tests only: forget every recorded arrival. */
export function resetArrivalGlow(): void {
  entries.clear();
  chatListeners.clear();
  allListeners.clear();
  nonceCounter = 0;
  version = 0;
}

export interface ArrivalFrame {
  threadId?: string;
  replayed?: boolean;
  imported?: boolean;
  message?: { role?: string; kind?: string; summarized?: boolean } | null;
}

export interface ArrivalChats {
  hydrated: boolean;
  selectedId: string;
  bots: Array<{ id: string; threadId: string; hidden?: boolean }>;
  groups: Array<{ id: string; threadId: string }>;
}

/** The chat id to glow for a live SSE frame, or null. Mirrors messageAdded's
 * thread lookup, so the glow tracks transcripts that actually update. */
export function arrivalChatForFrame(frame: ArrivalFrame, chats: ArrivalChats): string | null {
  if (!chats.hydrated) return null;
  if (!frame || frame.replayed || frame.imported) return null;
  const message = frame.message;
  if (!message || message.role !== "bot" || message.kind !== "text") return null;
  if (!isShownMessage(message)) return null;
  if (!frame.threadId) return null;
  const bot = chats.bots.find((candidate) => candidate.threadId === frame.threadId);
  if (bot) {
    if (bot.hidden || bot.id === chats.selectedId) return null;
    return bot.id;
  }
  const group = chats.groups.find((candidate) => candidate.threadId === frame.threadId);
  if (group) {
    if (group.id === chats.selectedId) return null;
    return group.id;
  }
  return null;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** True while this element's one-shot arrival glow plays. Single ids
 * subscribe per-chat; several ids (a control hiding rows) subscribe to all
 * and only react to the ids they stand for. Past arrivals never replay: ids
 * seen first adopt the current nonce without glowing. */
export function useArrivalGlow(
  chatIds: readonly string[],
  { enabled = true, asking = false }: { enabled?: boolean; asking?: boolean } = {},
): { playing: boolean; onAnimationEnd: (event: ReactAnimationEvent) => void } {
  const idsKey = chatIds.join("\n");
  const single = idsKey.includes("\n") ? null : idsKey;
  const subscribe = useCallback(
    (notify: () => void) => (single === null ? subscribeArrivalAll(notify) : subscribeArrival(single, notify)),
    [single],
  );
  const getSnapshot = useCallback(
    () => (single === null ? arrivalVersion() : arrivalNonce(single)),
    [single],
  );
  const tick = useSyncExternalStore(subscribe, getSnapshot);
  const [playing, setPlaying] = useState(false);
  const seenRef = useRef<Map<string, number> | null>(null);
  if (!seenRef.current) seenRef.current = new Map();
  const seen = seenRef.current;
  useEffect(() => {
    const ids = idsKey === "" ? [] : idsKey.split("\n");
    let fresh = false;
    for (const id of ids) {
      const nonce = arrivalNonce(id);
      const prev = seen.get(id);
      if (prev === undefined) seen.set(id, nonce);
      else if (prev !== nonce) {
        seen.set(id, nonce);
        fresh = true;
      }
    }
    for (const id of [...seen.keys()]) {
      if (!ids.includes(id)) seen.delete(id);
    }
    if (!enabled || asking) {
      setPlaying(false);
      return;
    }
    if (fresh && !prefersReducedMotion()) setPlaying(true);
  }, [tick, idsKey, enabled, asking, seen]);
  const onAnimationEnd = useCallback((event: ReactAnimationEvent) => {
    if (event.target !== event.currentTarget) return;
    const name = (event.nativeEvent as globalThis.AnimationEvent | undefined)?.animationName;
    if (name && name !== ARRIVAL_GLOW_ANIMATION) return;
    setPlaying(false);
  }, []);
  return { playing, onAnimationEnd };
}
