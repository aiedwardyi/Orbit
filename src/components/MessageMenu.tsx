// Right-click menu on chat messages: react, reply or copy on a bot reply,
// reply or copy on his own, and Copy on selected text. Links, inputs and the
// composer keep the native menu. Same dismiss contract as the sidebar menus.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, MessageSquareReply, SmilePlus, X } from "lucide-react";
import { EXTENDED_REACTIONS } from "../../shared/reactions";
import { useStore, type Message } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/** Quick row on the bot menu, in Grok's order. */
export const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "🔥"] as const;

/** Gutter the menu keeps off every window edge. */
const EDGE = 8;

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
  return target.closest("a[href], input, textarea, select, [contenteditable=\"true\"]") !== null;
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
    const onDown = (e: MouseEvent) => {
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
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    transcript?.addEventListener("scroll", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
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
  onClose,
}: {
  x: number;
  y: number;
  opener: HTMLElement;
  target: MessageMenuTarget;
  onReply: (message: Message) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const { threadId, message, copyText, user } = target;
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const box = useMenuPlacement(ref, x, y, expanded);
  useMenuDismiss(ref, opener, onClose);
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
        className={cn(EMOJI_CLASS, pressed && "bg-accent/15 ring-1 ring-accent/40")}
      >
        {emoji}
      </button>
    );
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-message-menu
      style={{ top: box.top, left: box.left }}
      onKeyDown={(e) => menuKeyDown(ref, e)}
      className={cn(MENU_CLASS, "w-[248px]")}
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
                className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
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
                className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
              >
                <SmilePlus size={16} />
              </button>
            </div>
          )}
          <div className="mx-2 my-1 border-t border-hairline/40" />
        </>
      )}
      <button
        type="button"
        role="menuitem"
        data-menu-reply
        onClick={() => {
          onReply(message);
          closeMenu(opener, ref.current, onClose);
        }}
        className={ROW_CLASS}
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
        className={ROW_CLASS}
      >
        <Copy size={16} className="text-ink-secondary" />
        {t("chat.copy")}
      </button>
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
