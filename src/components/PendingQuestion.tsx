// A bot's open ask_user question, pinned above the composer in the
// PendingApproval style. Unlike an approval it never takes the composer
// over: the bot keeps working, and typing a reply answers it just as well as
// tapping a choice. The question is never truncated (it scrolls instead).
import { memo } from "react";
import { X } from "lucide-react";
import type { Message } from "@/state/store";
import { useI18n } from "@/lib/i18n";

export const PendingQuestionPanel = memo(function PendingQuestionPanel({
  message,
  askerName,
  onPick,
  onDismiss,
}: {
  message: Message;
  askerName: string;
  onPick: (choice: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const card = message.card;
  if (!card) return null;
  return (
    <div
      role="region"
      aria-label={t("ask.asks", { name: askerName })}
      data-pending-question={message.id}
      className="mb-2 overflow-hidden rounded-2xl border border-accent/40 bg-card"
    >
      <div className="bg-control/40 px-4 py-3">
        <div className="flex items-start gap-2" aria-live="polite">
          <span className="min-w-0 flex-1 truncate pt-0.5 text-[11px] uppercase tracking-[0.18em] text-ink-secondary">
            {t("ask.asks", { name: askerName })}
          </span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t("chat.dismissQuestion")}
            title={t("chat.dismissQuestion")}
            className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div
          tabIndex={0}
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink"
        >
          {card.subtitle}
        </div>
        {card.options.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {card.options.map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => onPick(choice)}
                className="max-w-full break-words rounded-full border border-hairline bg-control px-3.5 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-raised-hover pointer-coarse:min-h-9"
              >
                {choice}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
