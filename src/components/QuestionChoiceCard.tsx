import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";

const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

export type QuestionChoiceCardProps = {
  /** Exact provider/heuristic question shown in the header. Empty hides the title. */
  question?: string | null;
  options: string[];
  onPick: (option: string) => void;
  /** Focus the existing composer (or open a local custom path). */
  onWriteOwn?: () => void;
  /** Exact option text when a listed choice was selected. */
  selectedOption?: string | null;
  /** True when a free-text / custom answer was accepted without matching a row. */
  customAnswered?: boolean;
  /** Synchronous lock while a click is in flight. */
  pending?: boolean;
  disabled?: boolean;
  /** Optional quiet subtitle (onboarding only). */
  subtitle?: string | null;
  /** Trailing header control (e.g. dismiss). */
  headerEnd?: ReactNode;
  /** Hide the write-own footer action (permission cards, etc.). */
  hideWriteOwn?: boolean;
  className?: string;
};

/**
 * Compact transcript-aligned choice card. Presentational only — callers own
 * transport (send / answerCard) and answered durability.
 */
export function QuestionChoiceCard({
  question,
  options,
  onPick,
  onWriteOwn,
  selectedOption = null,
  customAnswered = false,
  pending = false,
  disabled = false,
  subtitle,
  headerEnd,
  hideWriteOwn = false,
  className,
}: QuestionChoiceCardProps) {
  const { t } = useI18n();
  const titleId = useId();
  const announced = useRef(false);
  const answered = Boolean(selectedOption) || customAnswered;
  const locked = disabled || pending || answered;
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!answered || announced.current) return;
    announced.current = true;
    const label = selectedOption ?? t("chat.answerSent");
    setStatus(`${t("chat.answerSent")}: ${label}`);
  }, [answered, selectedOption, t]);

  return (
    <section
      className={cn(
        "orbit-question-card w-full max-w-[560px] overflow-hidden rounded-xl border border-hairline bg-card text-ink",
        className,
      )}
      aria-labelledby={question ? titleId : undefined}
      data-answered={answered ? "true" : undefined}
    >
      <div className="px-[18px] pt-[17px] pb-[13px]">
        <div className="mb-[7px] flex items-start justify-between gap-3">
          <div className="flex items-center gap-[7px] text-[11px] text-ink-secondary">
            <span data-choice-signal className="size-[5px] shrink-0 bg-accent-text" aria-hidden="true" />
            <span>{answered ? t("chat.choiceAnswered") : t("chat.yourChoice")}</span>
          </div>
          {headerEnd}
        </div>
        {question ? (
          <h2 id={titleId} className="m-0 text-[15px] font-semibold leading-[1.5] text-ink">
            {question}
          </h2>
        ) : null}
        {subtitle ? <p className="mt-0.5 text-[13px] text-ink-secondary">{subtitle}</p> : null}
      </div>

      <div className="grid gap-0.5 px-1.5 pb-1.5">
        {options.map((option, index) => {
          const letter = LETTERS[index] ?? String(index + 1);
          const chosen = selectedOption === option;
          return (
            <button
              key={`${letter}:${option}`}
              type="button"
              disabled={locked}
              onClick={() => onPick(option)}
              className={cn(
                "group/choice relative grid w-full grid-cols-[24px_minmax(0,1fr)_16px] items-start gap-3 rounded-lg border border-transparent px-2.5 py-3 text-left",
                "transition-[background-color,border-color] duration-[90ms] ease-out motion-reduce:transition-none",
                "focus-visible:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
                !locked && "hover:bg-raised-hover",
                chosen &&
                  "border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-hairline))] bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-card))]",
                locked && !chosen && "text-ink-secondary",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-6 w-6 items-center justify-center border border-hairline font-mono text-[11px] leading-[22px] text-ink-secondary",
                  "rounded-[3px]",
                  chosen && "border-accent-text text-accent-text",
                )}
              >
                {letter}
              </span>
              <span className="text-[13px] leading-[1.55] break-words [overflow-wrap:anywhere] max-[720px]:text-[14px]">
                {option}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "text-center text-[16px] leading-6 text-accent-text opacity-0 transition-none",
                  !locked && "group-hover/choice:opacity-100 group-focus-visible/choice:opacity-100",
                  chosen && "opacity-100",
                )}
              >
                {chosen ? "✓" : "↵"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex min-h-[46px] items-center justify-between gap-3 border-t border-hairline px-[18px] py-[11px]">
        {answered ? (
          <span className="text-[12px] text-accent-text">✓ {t("chat.answerSent")}</span>
        ) : (
          <>
            {!hideWriteOwn && onWriteOwn ? (
              <button
                type="button"
                disabled={locked}
                onClick={onWriteOwn}
                className="border-0 bg-transparent p-0 text-left text-[12px] text-ink-secondary hover:text-ink hover:underline hover:underline-offset-[3px] disabled:opacity-40"
              >
                {t("chat.writeOwnAnswer")} <span aria-hidden="true">↗</span>
              </button>
            ) : (
              <span />
            )}
            <span className="text-[10px] text-ink-secondary max-[720px]:hidden">{t("chat.clickChoiceHint")}</span>
          </>
        )}
      </div>

      <div role="status" className="sr-only">
        {status}
      </div>
    </section>
  );
}
