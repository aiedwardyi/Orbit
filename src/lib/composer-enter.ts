/** What a composer Enter should do. Shift+Enter stays a newline. IME
 * confirm (Hangul and friends) must not send — keyCode 229 and
 * composition start/end are the reliable signals. A stale isComposing
 * flag after composition has ended must not block a real Enter. */

export type ComposerEnterIntent = "send" | "newline" | "none";

export type ComposerEnterEvent = {
  key: string;
  code?: string;
  shiftKey: boolean;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

export type ComposerImeState = {
  composing: boolean;
  justEnded: boolean;
};

export function isComposerEnterKey(event: Pick<ComposerEnterEvent, "key" | "code">): boolean {
  return event.key === "Enter" || event.code === "NumpadEnter";
}

export function composerEnterIntent(event: ComposerEnterEvent, ime: ComposerImeState): ComposerEnterIntent {
  if (!isComposerEnterKey(event)) return "none";
  if (event.shiftKey) return "newline";

  const keyCode = event.keyCode ?? event.nativeEvent?.keyCode;
  const nativeComposing = event.isComposing ?? event.nativeEvent?.isComposing ?? false;

  // Windows IME reports the confirm-Enter as keyCode 229 (Process).
  if (keyCode === 229) return "none";
  if (ime.composing || ime.justEnded) return "none";
  // Stuck isComposing after commit: only a real Enter (keyCode 13) sends.
  // A missing keyCode is not 13 — do not take the send-through.
  if (nativeComposing) return keyCode === 13 ? "send" : "none";
  return "send";
}
