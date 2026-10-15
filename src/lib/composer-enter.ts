/** What a composer Enter should do. Shift+Enter stays a newline. IME
 * confirm (Hangul and friends) must not send: keyCode 229 and
 * composition start/end are the reliable signals. A stale isComposing
 * flag after composition has ended must not block a real Enter. */

/** "send-after": Ctrl/Cmd+Enter, which waits for the running turn instead of joining it. */
export type ComposerEnterIntent = "send" | "send-after" | "newline" | "none";

export type ComposerEnterEvent = {
  key: string;
  code?: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

export type ComposerImeState = {
  composing: boolean;
  justEnded: boolean;
  /** Phone keyboards have no Shift+Enter, so Enter stays a newline there. */
  touch?: boolean;
};

export function isComposerEnterKey(event: Pick<ComposerEnterEvent, "key" | "code">): boolean {
  return event.key === "Enter" || event.code === "NumpadEnter";
}

export function composerEnterIntent(event: ComposerEnterEvent, ime: ComposerImeState): ComposerEnterIntent {
  if (!isComposerEnterKey(event)) return "none";
  if (event.shiftKey || (ime.touch && !event.ctrlKey && !event.metaKey)) return "newline";

  const keyCode = event.keyCode ?? event.nativeEvent?.keyCode;
  const nativeComposing = event.isComposing ?? event.nativeEvent?.isComposing ?? false;

  // Windows IME reports the confirm-Enter as keyCode 229 (Process).
  if (keyCode === 229) return "none";
  if (ime.composing || ime.justEnded) return "none";
  // Stuck isComposing after commit: only a real Enter (keyCode 13) sends.
  // A missing keyCode is not 13, so do not take the send-through.
  const send = event.ctrlKey || event.metaKey ? "send-after" : "send";
  if (nativeComposing) return keyCode === 13 ? send : "none";
  return send;
}
