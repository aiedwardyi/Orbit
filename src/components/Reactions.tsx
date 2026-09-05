// Emoji reactions — Grok/iMessage-style bubbly picker on hover or +, chips
// under the message for applied marks. `by` is "user" or a member botId; in
// rooms a bot's own reactions render with its name in the tooltip.
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { EXTENDED_REACTIONS, PRIMARY_REACTIONS } from "../../shared/reactions";
import { useStore, type Bot, type Message } from "@/state/store";
import { useI18n, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/cn";

function reactLabel(t: Translate, emoji: string, pressed: boolean) {
  return pressed ? t("chat.removeReaction", { emoji }) : t("chat.reactEmoji", { emoji });
}

export function ReactionBar({ threadId, message }: { threadId: string; message: Message }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
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
      if (!pickerRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        setPickerOpen(false);
      }
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

  const toggle = (emoji: string) => {
    dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji });
    setPickerOpen(false);
  };

  return (
    <div
      ref={anchorRef}
      data-reaction-bar
      className={cn(
        "relative mt-0.5",
        pickerOpen
          ? "opacity-100"
          : "pointer-events-none max-h-0 overflow-hidden opacity-0 group-hover:pointer-events-auto group-hover:max-h-12 group-hover:overflow-visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:max-h-12 group-focus-within:overflow-visible group-focus-within:opacity-100",
      )}
    >
      <div className="flex w-fit items-center gap-0.5 rounded-full border border-hairline/35 bg-card/75 px-1 py-0.5 shadow-[0_1px_3px_rgba(0,0,0,0.05)]">
        {PRIMARY_REACTIONS.map((emoji) => {
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
        <button
          type="button"
          onClick={() => setPickerOpen((open) => !open)}
          aria-label={pickerOpen ? t("chat.closeReactions") : t("chat.moreReactions")}
          aria-expanded={pickerOpen}
          title={pickerOpen ? t("chat.closeReactions") : t("chat.moreReactions")}
          className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
        >
          {pickerOpen ? <X size={12} /> : <Plus size={12} />}
        </button>
        {pickerOpen && (
          <div
            ref={pickerRef}
            data-reaction-picker
            className="absolute top-full left-0 z-40 mt-1.5 w-[218px] rounded-xl border border-hairline/50 bg-card p-2 shadow-2xl shadow-black/60"
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
                      "rounded-lg px-1 py-1 text-[15px] leading-none hover:bg-control",
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
