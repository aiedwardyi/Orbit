import { useSyncExternalStore } from "react";

export type ReplyStyle = "paragraphs" | "live";
export const REPLY_STYLE_KEY = "omb-reply-style";
const CHANGE_EVENT = "orbit-reply-style";
let fallback: ReplyStyle = "paragraphs";

export function loadReplyStyle(): ReplyStyle {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return fallback;
    const value = storage.getItem(REPLY_STYLE_KEY);
    return value === "live" ? "live" : "paragraphs";
  } catch {
    return fallback;
  }
}

export function saveReplyStyle(style: ReplyStyle): void {
  fallback = style;
  try {
    globalThis.localStorage?.setItem(REPLY_STYLE_KEY, style);
  } catch {
    // Keep the choice for this session when storage is blocked.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useReplyStyle(): ReplyStyle {
  return useSyncExternalStore(subscribe, loadReplyStyle, loadReplyStyle);
}
