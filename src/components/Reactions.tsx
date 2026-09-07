// Emoji reactions - smile entry on the hover row opens a bubbly picker.
// Applied marks stay as chips. `by` is "user" or a member botId; in rooms a
// bot's own reactions render with its name in the tooltip.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SmilePlus, X } from "lucide-react";
import { EXTENDED_REACTIONS } from "../../shared/reactions";
import { useStore, type Bot, type Message } from "@/state/store";
import { useI18n, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/** mt-1.5 / mb-1.5, the standoff between the bar and the picker. */
const PICKER_GAP = 6;

function reactLabel(t: Translate, emoji: string, pressed: boolean) {
  return pressed ? t("chat.removeReaction", { emoji }) : t("chat.reactEmoji", { emoji });
}

export function ReactionBar({ threadId, message }: { threadId: string; message: Message }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const mine = useMemo(
    () => new Set(
      (message.reactions ?? []).filter((reaction) => reaction.by === "user").map((reaction) => reaction.emoji),
    ),
    [message.reactions],
  );

  // same dismiss contract as the sidebar menus: outside click, Escape, blur
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!anchorRef.current?.contains(target)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPickerOpen(false);
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

  // left-0 opens the picker outward, clear of the bubble. In a narrow window
  // the gutter is thinner than the grid, so pull it back on screen rather than
  // leave the last columns unclickable. Measured off the anchor, never off the
  // picker's own box, so the offset can't compound on itself as the window moves.
  //
  // Vertically the picker has to stay inside the transcript's own overflow box:
  // that clip is an ancestor's, so no z-index escapes it, and on the last
  // message a downward picker is painted past the scroller's bottom edge with
  // the composer chrome taking the clicks. Open upward when the room below runs
  // out, which the settled bottom of a thread always does.
  useLayoutEffect(() => {
    if (!pickerOpen) {
      setShift(0);
      setPlacement("below");
      return;
    }
    const clamp = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const width = pickerRef.current?.offsetWidth;
      if (!anchor || !width) return;
      const overflow = anchor.left + width - (window.innerWidth - 8);
      setShift(overflow > 0 ? -overflow : 0);

      const clip = anchorRef.current?.closest("[data-orbit-transcript]")?.getBoundingClientRect();
      const height = pickerRef.current?.offsetHeight;
      if (!clip || !height) return;
      const needed = height + PICKER_GAP;
      const fitsBelow = clip.bottom - anchor.bottom >= needed;
      const fitsAbove = anchor.top - clip.top >= needed;
      setPlacement(!fitsBelow && fitsAbove ? "above" : "below");
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [pickerOpen]);

  const toggle = (emoji: string) => {
    dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji });
    setPickerOpen(false);
  };

  return (
    <div ref={anchorRef} data-reaction-bar className="relative">
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
      {pickerOpen && (
        <div
          ref={pickerRef}
          data-reaction-picker
          style={{ transform: `translateX(${shift}px)` }}
          className={cn(
            "absolute left-0 z-40 w-[218px] rounded-xl border border-hairline/50 bg-card p-2 shadow-2xl shadow-black/60",
            placement === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
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
        </div>
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
