// A bot's ask_user question as it reads in the transcript. The answer lives
// in the pin above the composer (or simply the next message the person
// sends), so like ApprovalCard this only records what happened: no chips.
import { Check, CircleHelp, X } from "lucide-react";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { askUserStatus } from "@/lib/open-question";

export function AskUserRecord({
  message,
  transcript,
  askerName,
  pinned = false,
}: {
  message: Message;
  /** the chat's messages, to see whether it was answered or superseded */
  transcript: readonly Message[];
  askerName?: string;
  /** the composer pins this question, so the record need not repeat it */
  pinned?: boolean;
}) {
  const { t } = useI18n();
  const card = message.card;
  if (!card) return null;
  const status = askUserStatus(transcript, message);
  const waiting = status.state === "waiting";
  if (waiting && pinned) {
    return (
      <div
        data-ask-user-record={status.state}
        className="flex w-full max-w-[840px] min-w-0 items-center gap-1.5 rounded-2xl border border-accent/40 bg-card px-4 py-3 text-[13px] text-ink-secondary"
      >
        <CircleHelp size={14} className="shrink-0 text-accent" />
        <span className="min-w-0 truncate">{askerName ? t("ask.waitingFor", { name: askerName }) : t("ask.waiting")}</span>
      </div>
    );
  }
  return (
    <div
      data-ask-user-record={status.state}
      className={cn(
        "w-full max-w-[840px] rounded-2xl border bg-card p-4",
        waiting ? "border-accent/40" : "border-hairline/30 opacity-70",
      )}
    >
      {askerName && <div className="text-[13px] font-semibold text-ink">{t("ask.asks", { name: askerName })}</div>}
      <div className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{card.subtitle}</div>
      <div className="mt-3 flex min-w-0 items-center gap-1.5 text-[13px] text-ink-secondary">
        {status.state === "answered" ? (
          <>
            <Check size={14} className="shrink-0 text-success" />
            <span className="min-w-0 truncate">{t("ask.answered", { reply: status.reply })}</span>
          </>
        ) : status.state === "dismissed" ? (
          <>
            <X size={14} className="shrink-0" /> {t("ask.dismissed")}
          </>
        ) : status.state === "superseded" ? (
          <>
            <X size={14} className="shrink-0" /> {t("ask.superseded")}
          </>
        ) : (
          <>
            <CircleHelp size={14} className="shrink-0 text-accent" /> {t("ask.waiting")}
          </>
        )}
      </div>
    </div>
  );
}
