// Emoji reactions - smile entry on the hover row opens a bubbly picker.
// Applied marks stay as chips. `by` is "user" or a member botId; in rooms a
// bot's own reactions render with its name in the tooltip.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SmilePlus, X } from "lucide-react";
import { EXTENDED_REACTIONS } from "../../shared/reactions";
import { useStore, type Bot, type Message } from "@/state/store";
import { useI18n, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/** The standoff between the bar and the picker. */
const PICKER_GAP = 6;
/** Gutter the picker keeps off every window edge. */
const PICKER_EDGE = 8;

function reactLabel(t: Translate, emoji: string, pressed: boolean) {
  return pressed ? t("chat.removeReaction", { emoji }) : t("chat.reactEmoji", { emoji });
}

export function ReactionBar({ threadId, message }: { threadId: string; message: Message }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const mine = useMemo(
    () => new Set(
      (message.reactions ?? []).filter((reaction) => reaction.by === "user").map((reaction) => reaction.emoji),
    ),
    [message.reactions],
  );

  // Only the paths a keyboard user closes on: an outside click should leave
  // focus wherever it landed rather than yank it back here.
  const closeAndRefocus = () => {
    setPickerOpen(false);
    anchorRef.current?.querySelector("button")?.focus();
  };

  // same dismiss contract as the sidebar menus: outside click, Escape, blur
  useEffect(() => {
    if (!pickerOpen) return;
    // Both refs, not a selector: the picker is portalled out of the bar, so its
    // buttons are no longer inside the anchor, and a document-wide selector
    // would answer for every other rail on screen too - pressing another
    // message's trigger has to close this one.
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target) || pickerRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeAndRefocus();
    const onBlur = () => setPickerOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [pickerOpen]);

  // The picker is portalled to the root at `fixed`, so it is placed from the
  // anchor's viewport rect. That is the point of the portal: inside the
  // scroller it was clipped by an ancestor's overflow and outranked by chrome
  // in an ancestor's stacking context, and no z-index escapes either, so at the
  // 600x480 floor a whole row of it landed dead under the chat header or the
  // usage strip while getBoundingClientRect still reported it on screen.
  //
  // Placement still prefers the transcript: below is the resting look, above is
  // the flip that keeps a last-message picker off the composer, and only when
  // the pane holds the grid on neither side does it spend the rest of the
  // window - which is the floor's whole problem, a pane too short for the grid
  // plus a message in the middle of it. Sideways it is pulled back off the
  // right edge rather than leaving the last columns out of reach, measured off
  // the anchor and never off the picker's own box, so the offset cannot
  // compound on itself as the window moves.
  //
  // Scrolling moves the anchor without resizing the window, so the transcript
  // is measured again on its own scroll. Recomputed rather than dismissed
  // there: a streamed reply scrolls the pane by itself, which would close the
  // picker under the user mid-choice.
  //
  // A streaming bubble is the case neither event covers: once the user has
  // scrolled up, bottom-follow is off, so a growing message moves the hover
  // rail with scrollTop and the window both unchanged. Watch the pane and the
  // message stack for resizes instead, which also catches the composer growing
  // and taking the pane's height with it.
  useLayoutEffect(() => {
    if (!pickerOpen) {
      setBox(null);
      return;
    }
    const transcript = anchorRef.current?.closest("[data-orbit-transcript]");
    const clamp = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const width = pickerRef.current?.offsetWidth;
      const height = pickerRef.current?.offsetHeight;
      if (!anchor || !width || !height) return;

      const clip = transcript?.getBoundingClientRect();
      // Scrolled past the edge entirely: the smile entry it hangs off is gone,
      // so no placement can save it. Same exit as an outside click.
      if (clip && (anchor.top >= clip.bottom || anchor.bottom <= clip.top)) {
        setPickerOpen(false);
        return;
      }

      const needed = height + PICKER_GAP;
      const side = (below: number, above: number) =>
        below >= needed ? "below" : above >= needed ? "above" : null;
      const placement =
        (clip && side(clip.bottom - anchor.bottom, anchor.top - clip.top)) ??
        side(window.innerHeight - anchor.bottom, anchor.top) ??
        // Neither the pane nor the window fits it: show the most of it we can.
        (window.innerHeight - anchor.bottom >= anchor.top ? "below" : "above");

      const top = placement === "below" ? anchor.bottom + PICKER_GAP : anchor.top - PICKER_GAP - height;
      const fit = (value: number, size: number, extent: number) =>
        Math.max(PICKER_EDGE, Math.min(value, extent - size - PICKER_EDGE));
      setBox({
        top: fit(top, height, window.innerHeight),
        left: fit(anchor.left, width, window.innerWidth),
      });
    };
    clamp();
    window.addEventListener("resize", clamp);
    transcript?.addEventListener("scroll", clamp);
    const observer = new ResizeObserver(clamp);
    if (transcript) {
      observer.observe(transcript);
      // the message stack: its height is what a streaming reply changes
      if (transcript.firstElementChild) observer.observe(transcript.firstElementChild);
    }
    return () => {
      window.removeEventListener("resize", clamp);
      transcript?.removeEventListener("scroll", clamp);
      observer.disconnect();
    };
  }, [pickerOpen]);

  // Portalled under document.body, the picker is no longer the trigger's tab
  // neighbour, so opening it has to carry focus across and closing it has to
  // hand focus back. Gated on `placed` because the grid is visibility:hidden
  // until it has been measured, and a hidden element cannot take focus.
  const placed = box !== null;
  useEffect(() => {
    if (!pickerOpen || !placed) return;
    pickerRef.current?.querySelector("button")?.focus();
  }, [pickerOpen, placed]);

  const toggle = (emoji: string) => {
    dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji });
    closeAndRefocus();
  };

  return (
    <div ref={anchorRef} data-reaction-bar>
      <button
        type="button"
        onClick={() => setPickerOpen((open) => !open)}
        aria-label={pickerOpen ? t("chat.closeReactions") : t("chat.moreReactions")}
        aria-expanded={pickerOpen}
        title={pickerOpen ? t("chat.closeReactions") : t("chat.moreReactions")}
        className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {pickerOpen ? <X size={14} /> : <SmilePlus size={14} />}
      </button>
      {pickerOpen &&
        createPortal(
          <div
            ref={pickerRef}
            data-reaction-picker
            // Hidden for the one commit it takes to measure the grid, so it
            // never paints in the corner on the way to its real place.
            style={{ top: box?.top ?? 0, left: box?.left ?? 0, visibility: box ? "visible" : "hidden" }}
            className="fixed z-40 w-[218px] rounded-xl border border-hairline/50 bg-card p-2 shadow-2xl shadow-black/60"
          >
            <div className="grid grid-cols-6 gap-0.5">
              {EXTENDED_REACTIONS.map((emoji) => {
                const pressed = mine.has(emoji);
                return (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => toggle(emoji)}
                    aria-label={reactLabel(t, emoji, pressed)}
                    aria-pressed={pressed}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full text-[15px] leading-none transition-transform hover:scale-110 hover:bg-control",
                      pressed && "bg-accent/15 ring-1 ring-accent/40",
                    )}
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function ReactionChips({
  threadId,
  message,
  members,
  align = "left",
}: {
  threadId: string;
  message: Message;
  members?: Bot[];
  align?: "left" | "right";
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const reactions = message.reactions ?? [];
  if (!reactions.length) return null;
  // group identical emoji into one chip with a count
  const grouped = new Map<string, string[]>();
  for (const r of reactions) grouped.set(r.emoji, [...(grouped.get(r.emoji) ?? []), r.by]);
  const nameOf = (by: string) =>
    by === "user" ? t("chat.you") : (members?.find((b) => b.id === by)?.name ?? t("chrome.aBot"));
  return (
    <div className={cn("mt-0.5 flex flex-wrap gap-1", align === "right" ? "justify-end" : "justify-start")}>
      {[...grouped].map(([emoji, bys]) => (
        <button
          key={emoji}
          type="button"
          onClick={() => dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji })}
          title={bys.map(nameOf).join(", ")}
          className={cn(
            "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[12px] leading-none",
            bys.includes("user")
              ? "border-accent/50 bg-accent/15"
              : "border-hairline/40 bg-panel hover:bg-control",
          )}
        >
          <span>{emoji}</span>
          {bys.length > 1 && <span className="text-[11px] text-ink-secondary">{bys.length}</span>}
        </button>
      ))}
    </div>
  );
}
