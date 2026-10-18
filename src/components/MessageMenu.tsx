// Right-click menu on chat messages: react, reply or copy on a bot reply,
// reply or copy on his own, and Copy on selected text. Links, inputs and the
// composer keep the native menu. Same dismiss contract as the sidebar menus.
// On phones a hold opens it, and Select text hands one message back to the
// phone's own selection.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { ArrowUp, Copy, MessageSquareReply, Pin, PinOff, SmilePlus, TextCursor, X } from "lucide-react";
import { EXTENDED_REACTIONS } from "../../shared/reactions";
import { useStore, type Message } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";

declare global {
  interface WindowEventMap {
    "orbit:message-menu": CustomEvent<boolean>;
  }
}

/** Quick row on the bot menu, in Grok's order. */
export const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "😮", "🔥"] as const;

/** Gutter the menu keeps off every window edge. */
const EDGE = 8;
const HOLD_MS = 500;
const HOLD_SLOP = 10;

export function copyShortcutHint(): string {
  const mac = /Mac/i.test(globalThis.navigator?.platform ?? "");
  return mac ? "Cmd+C" : "Ctrl+C";
}

/** Long-press selects text on touch-first devices, so the menu stays off there. */
export function isTouchPrimary(win: Window = window): boolean {
  return win.matchMedia?.("(pointer: coarse)").matches ?? false;
}

/** Links and editable fields keep today's native menu. */
export function keepsNativeMenu(target: Element): boolean {
  return target.closest("a[href], [data-file-link], input, textarea, select, [contenteditable=\"true\"]") !== null;
}

function holdsNative(target: Element): boolean {
  return keepsNativeMenu(target) || target.closest("img, [data-select-mode]") !== null;
}

let selecting: (() => void) | null = null;

export function endSelectMode(): void {
  selecting?.();
}

const words = new Intl.Segmenter(undefined, { granularity: "word" });

interface Word {
  node: Text;
  start: number;
  end: number;
}

function nearestWord(node: Text, offset: number): Word | null {
  let best: Word | null = null;
  let gap = Infinity;
  for (const s of words.segment(node.data)) {
    if (!s.isWordLike) continue;
    const end = s.index + s.segment.length;
    const d = offset < s.index ? s.index - offset : Math.max(0, offset - end);
    if (d < gap) [best, gap] = [{ node, start: s.index, end }, d];
  }
  return best;
}

/** The word at a viewport point inside the message content, or null when none can be found there. */
function wordAt(content: Element, x: number, y: number): Word | null {
  const box = content.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
  const caret = document.caretRangeFromPoint?.(x, y);
  if (!caret || !content.contains(caret.startContainer)) return null;
  const { startContainer: node, startOffset: offset } = caret;
  if (node instanceof Text) {
    const word = nearestWord(node, offset);
    if (word) return word;
  }
  // a caret between blocks or on wordless text: the next word after it, else the last one before
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let before: Word | null = null;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!(text instanceof Text)) continue;
    const after = caret.comparePoint(text, 0) > 0;
    const word = nearestWord(text, after ? 0 : text.length);
    if (word && after) return word;
    before = word ?? before;
  }
  return before;
}

/** Selects the held word, or the whole message, and lets the phone's own selection work there until a touch lands elsewhere. */
export function startSelectMode(row: HTMLElement, held: { x: number; y: number }): void {
  endSelectMode();
  // the row is unselectable until now, and caret hit-testing skips unselectable text
  row.setAttribute("data-select-mode", "");
  const content = row.querySelector("[data-orbit-message-content]") ?? row;
  const box = row.getBoundingClientRect();
  const word = wordAt(content, box.left + held.x, box.top + held.y);
  const sel = window.getSelection();
  if (word) sel?.setBaseAndExtent(word.node, word.start, word.node, word.end);
  else sel?.selectAllChildren(content);
  const onDown = (e: Event) => {
    if (!(e.target instanceof Node && row.contains(e.target))) end();
  };
  const end = () => {
    row.removeAttribute("data-select-mode");
    const sel = window.getSelection();
    if (sel?.anchorNode && row.contains(sel.anchorNode)) sel.removeAllRanges();
    document.removeEventListener("touchstart", onDown, true);
    document.removeEventListener("mousedown", onDown, true);
    selecting = null;
  };
  document.addEventListener("touchstart", onDown, true);
  document.addEventListener("mousedown", onDown, true);
  selecting = end;
}

interface Press {
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout> | null;
}
let press: Press | null = null;

function cancelPress(): void {
  if (press?.timer) clearTimeout(press.timer);
  press = null;
  document.removeEventListener("scroll", pressScrolled, true);
}

function pressScrolled(): void {
  if (press?.timer) cancelPress();
}

/** Row props that open the menu after a still, one-finger hold on touch-first devices. */
export function holdToOpen(open: ((x: number, y: number, opener: HTMLElement) => void) | null) {
  if (!open) return {};
  return {
    "data-hold-menu": "",
    onTouchStart: (e: React.TouchEvent<HTMLElement>) => {
      cancelPress();
      const touch = e.touches[0];
      if (!touch || e.touches.length > 1 || !isTouchPrimary() || !(e.target instanceof Element) || holdsNative(e.target)) return;
      const { clientX: x, clientY: y } = touch;
      const opener = e.currentTarget;
      press = {
        x,
        y,
        timer: setTimeout(() => {
          if (press) press.timer = null;
          // scrolling can no longer cancel; press stays for the lift guard
          document.removeEventListener("scroll", pressScrolled, true);
          endSelectMode();
          open(x, y, opener);
        }, HOLD_MS),
      };
      // the transcript can scroll under a still finger, like following a streaming reply
      document.addEventListener("scroll", pressScrolled, true);
    },
    onTouchMove: (e: React.TouchEvent<HTMLElement>) => {
      const touch = e.touches[0];
      if (!press?.timer) return;
      if (!touch || e.touches.length > 1 || Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > HOLD_SLOP) cancelPress();
    },
    onTouchEnd: (e: React.TouchEvent<HTMLElement>) => {
      // the menu opened under the finger, so the lift must not press it
      if (press && !press.timer && e.cancelable) e.preventDefault();
      cancelPress();
    },
    onTouchCancel: cancelPress,
    onContextMenuCapture: (e: React.MouseEvent<HTMLElement>) => {
      if (press && e.target instanceof Element && !holdsNative(e.target)) e.preventDefault();
    },
  };
}

/** The slice of Selection a right-click consults. */
export interface SelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  anchorNode: Node | null;
  toString(): string;
  getRangeAt(index: number): { isPointInRange(node: Node, offset: number): boolean };
}

export function selectionContainsPoint(sel: SelectionLike | null, node: Node | null, offset: number): boolean {
  if (!sel || !node) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    try {
      if (sel.getRangeAt(i).isPointInRange(node, offset)) return true;
    } catch {
      // a stale range answers for nothing
    }
  }
  return false;
}

/** Which menu a right-click wants: native, selection Copy, or the message menu. */
export function contextClickKind(
  target: Element,
  x: number,
  y: number,
  doc: Document = document,
): "native" | "selection" | "message" {
  if (keepsNativeMenu(target)) return "native";
  const sel = doc.getSelection?.() ?? null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString()) return "message";
  // caretRangeFromPoint is Chromium-only: without it a selection in the same
  // transcript still favors Copy.
  const placeCaret = doc.caretRangeFromPoint?.bind(doc);
  if (!placeCaret) {
    const transcript = target.closest("[data-orbit-transcript]");
    return transcript && sel.anchorNode && transcript.contains(sel.anchorNode) ? "selection" : "message";
  }
  const caret = placeCaret(x, y);
  return caret && selectionContainsPoint(sel, caret.startContainer, caret.startOffset) ? "selection" : "message";
}

export interface MessageMenuTarget {
  threadId: string;
  message: Message;
  copyText: string;
  user: boolean;
  pinned: boolean;
  canPin: boolean;
  queued?: { sendNow?: () => void; cancel: () => void };
}

export type MessageMenuRequest =
  | { kind: "message"; x: number; y: number; opener: HTMLElement; target: MessageMenuTarget }
  | { kind: "selection"; x: number; y: number; opener: HTMLElement; text: string };

interface MenuBox {
  top: number;
  left: number;
}

function clampPoint(x: number, y: number, width: number, height: number): MenuBox {
  return {
    top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
    left: Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE)),
  };
}

/** Fixed at the pointer, pulled back off the window edges once measured. */
function useMenuPlacement(
  ref: React.RefObject<HTMLDivElement | null>,
  x: number,
  y: number,
  expanded = false,
): MenuBox {
  const [box, setBox] = useState(() => clampPoint(x, y, 0, 0));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setBox(clampPoint(x, y, el.offsetWidth, el.offsetHeight));
  }, [ref, x, y, expanded]);
  return box;
}

function useMenuDismiss(ref: React.RefObject<HTMLDivElement | null>, opener: HTMLElement, onClose: () => void): void {
  useLayoutEffect(() => {
    const onDown = (e: Event) => {
      if (e.target instanceof Element && ref.current?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      opener.focus();
    };
    const onBlur = () => onClose();
    // a scroll moves the message without moving the pointer, so the menu
    // would point at the wrong row
    const transcript = opener.closest("[data-orbit-transcript]");
    const onScroll = () => onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("touchstart", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    transcript?.addEventListener("scroll", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("touchstart", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      transcript?.removeEventListener("scroll", onScroll);
    };
  }, [ref, opener, onClose]);
}

/** Close, then put focus back on the opener unless the action already moved it. */
function closeMenu(opener: HTMLElement, menu: HTMLElement | null, onClose: () => void): void {
  const active = document.activeElement;
  const moved = active instanceof HTMLElement && active !== document.body && !menu?.contains(active);
  onClose();
  if (!moved) opener.focus({ preventScroll: true });
}

/** Arrow keys walk the menu's buttons; Enter clicks the focused one. */
function menuKeyDown(ref: React.RefObject<HTMLDivElement | null>, e: React.KeyboardEvent): void {
  const buttons = ref.current ? Array.from(ref.current.querySelectorAll("button")) : [];
  if (!buttons.length) return;
  const at = buttons.findIndex((entry) => entry === document.activeElement);
  const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
  if (e.key === "Home") {
    e.preventDefault();
    buttons[0]?.focus();
  } else if (e.key === "End") {
    e.preventDefault();
    buttons.at(-1)?.focus();
  } else if (step !== 0) {
    e.preventDefault();
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  } else if (e.key === "Enter") {
    // preventDefault suppresses the native Enter-click, so this is the one fire
    e.preventDefault();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.click();
  }
}

const MENU_CLASS =
  "animate-pop-in fixed z-40 rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60";
const ROW_CLASS =
  "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70";
const EMOJI_CLASS =
  "flex size-8 items-center justify-center rounded-full text-[17px] leading-none transition-transform hover:scale-110 hover:bg-control";

export function MessageMenu({
  x,
  y,
  opener,
  target,
  onReply,
  onPin,
  onClose,
}: {
  x: number;
  y: number;
  opener: HTMLElement;
  target: MessageMenuTarget;
  onReply: (message: Message) => void;
  onPin: (message: Message) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const { threadId, message, copyText, user, pinned, canPin } = target;
  const [expanded, setExpanded] = useState(false);
  const [touch] = useState(isTouchPrimary);
  // kept against the row, since the transcript can scroll before Select text
  const [held] = useState(() => {
    const box = opener.getBoundingClientRect();
    return { x: x - box.left, y: y - box.top };
  });
  const ref = useRef<HTMLDivElement>(null);
  const box = useMenuPlacement(ref, x, y, expanded);
  useMenuDismiss(ref, opener, onClose);
  // App holds a Back entry while it is open, the same way as the model picker
  useEffect(() => {
    if (!touch) return;
    window.dispatchEvent(new CustomEvent("orbit:message-menu", { detail: true }));
    return () => {
      window.dispatchEvent(new CustomEvent("orbit:message-menu", { detail: false }));
    };
  }, [touch]);
  useEffect(() => {
    if (!touch) return;
    window.addEventListener("orbit:close-message-menu", onClose);
    return () => window.removeEventListener("orbit:close-message-menu", onClose);
  }, [touch, onClose]);
  const mine = useMemo(
    () => new Set(
      (message.reactions ?? []).filter((reaction) => reaction.by === "user").map((reaction) => reaction.emoji),
    ),
    [message.reactions],
  );

  // Portalled out of the transcript, the menu is no longer the row's tab
  // neighbour, so opening it carries focus across.
  useLayoutEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, [expanded]);

  const toggle = (emoji: string) => {
    dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji, message });
    closeMenu(opener, ref.current, onClose);
  };
  const emojiButton = (emoji: string) => {
    const pressed = mine.has(emoji);
    return (
      <button
        key={emoji}
        type="button"
        role="menuitemcheckbox"
        data-menu-reaction={emoji}
        onClick={() => toggle(emoji)}
        aria-label={pressed ? t("chat.removeReaction", { emoji }) : t("chat.reactEmoji", { emoji })}
        aria-checked={pressed}
        className={cn(EMOJI_CLASS, touch && "size-10", pressed && "bg-accent/15 ring-1 ring-accent/40")}
      >
        {emoji}
      </button>
    );
  };

  if (target.queued) {
    const { sendNow, cancel } = target.queued;
    return createPortal(
      <div
        ref={ref}
        role="menu"
        data-message-menu
        style={{ top: box.top, left: box.left }}
        onKeyDown={(e) => menuKeyDown(ref, e)}
        className={cn(MENU_CLASS, touch ? "w-[304px]" : "w-[248px]")}
      >
        {sendNow && (
          <button
            type="button"
            role="menuitem"
            data-menu-send-now
            onClick={() => { sendNow(); closeMenu(opener, ref.current, onClose); }}
            className={cn(ROW_CLASS, touch && "min-h-10")}
          >
            <ArrowUp size={16} className="text-ink-secondary" />
            {t("chat.sendQueuedNow")}
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          data-menu-cancel-queued
          onClick={() => { cancel(); closeMenu(opener, ref.current, onClose); }}
          className={cn(ROW_CLASS, touch && "min-h-10")}
        >
          <X size={16} className="text-ink-secondary" />
          {t("chat.cancelQueuedAction")}
        </button>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-message-menu
      style={{ top: box.top, left: box.left }}
      onKeyDown={(e) => menuKeyDown(ref, e)}
      className={cn(MENU_CLASS, touch ? "w-[304px]" : "w-[248px]")}
    >
      {!user && (
        <>
          {expanded ? (
            <div className="grid grid-cols-6 justify-items-center gap-0.5 px-2">
              {EXTENDED_REACTIONS.map(emojiButton)}
              <button
                type="button"
                role="menuitem"
                data-menu-collapse
                onClick={() => setExpanded(false)}
                aria-label={t("chat.closeReactions")}
                title={t("chat.closeReactions")}
                className={cn("flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink", touch && "size-10")}
              >
                <X size={15} />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between px-2">
              {QUICK_REACTIONS.map(emojiButton)}
              <button
                type="button"
                role="menuitem"
                data-menu-expand
                onClick={() => setExpanded(true)}
                aria-label={t("chat.moreReactions")}
                title={t("chat.moreReactions")}
                className={cn("flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink", touch && "size-10")}
              >
                <SmilePlus size={16} />
              </button>
            </div>
          )}
          <div className="mx-2 my-1 border-t border-hairline/40" />
        </>
      )}
      {canPin && (
        <button
          type="button"
          role="menuitem"
          data-menu-pin
          onClick={() => {
            onPin(message);
            closeMenu(opener, ref.current, onClose);
          }}
          className={cn(ROW_CLASS, touch && "min-h-10")}
        >
          {pinned
            ? <PinOff size={16} className="text-ink-secondary" />
            : <Pin size={16} className="text-ink-secondary" />}
          {t(pinned ? "chat.unpinMessage" : "chat.pinMessage")}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        data-menu-reply
        onClick={() => {
          onReply(message);
          closeMenu(opener, ref.current, onClose);
        }}
        className={cn(ROW_CLASS, touch && "min-h-10")}
      >
        <MessageSquareReply size={16} className="text-ink-secondary" />
        {t("chat.reply")}
      </button>
      <button
        type="button"
        role="menuitem"
        data-menu-copy
        onClick={() => {
          void navigator.clipboard?.writeText(copyText);
          closeMenu(opener, ref.current, onClose);
        }}
        className={cn(ROW_CLASS, touch && "min-h-10")}
      >
        <Copy size={16} className="text-ink-secondary" />
        {t("chat.copy")}
      </button>
      {touch && (
        <button
          type="button"
          role="menuitem"
          data-menu-select
          onClick={() => {
            // the menu can cover the held point, so it leaves before the hit test
            flushSync(() => closeMenu(opener, ref.current, onClose));
            startSelectMode(opener, held);
          }}
          className={cn(ROW_CLASS, "min-h-10")}
        >
          <TextCursor size={16} className="text-ink-secondary" />
          {t("chat.selectText")}
        </button>
      )}
    </div>,
    document.body,
  );
}

export function SelectionMenu({
  x,
  y,
  opener,
  text,
  onClose,
}: {
  x: number;
  y: number;
  opener: HTMLElement;
  text: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const box = useMenuPlacement(ref, x, y);
  useMenuDismiss(ref, opener, onClose);

  useLayoutEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-selection-menu
      style={{ top: box.top, left: box.left }}
      onKeyDown={(e) => menuKeyDown(ref, e)}
      className={cn(MENU_CLASS, "w-[220px]")}
    >
      <button
        type="button"
        role="menuitem"
        data-menu-copy
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          closeMenu(opener, ref.current, onClose);
        }}
        className={ROW_CLASS}
      >
        <Copy size={16} className="text-ink-secondary" />
        {t("chat.copy")}
        <span className="ml-auto text-[12px] text-ink-secondary">{copyShortcutHint()}</span>
      </button>
    </div>,
    document.body,
  );
}
