import { useRef, useState } from "react";
import { X } from "lucide-react";
import { useStore, visibleMessages, type Message } from "@/state/store";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { QuestionChoiceCard } from "./QuestionChoiceCard";

const ONBOARDING_OPTIONS: MessageKey[] = ["onboarding.card.work", "onboarding.card.writing", "onboarding.card.life", "onboarding.card.everything"];

/** First-run quiz, not a live provider ask (those carry requestId). */
export function isOnboardingCard(message: Message): boolean {
  return message.kind === "options" && !!message.card && !message.card.requestId;
}

/** Hide the quiz once they have talked past it — picked an option, typed in
 * the composer, or dismissed it. Live asks are never this card. */
export function shouldHideOnboardingCard(message: Message, transcript: Message[]): boolean {
  if (!isOnboardingCard(message) || !message.card) return false;
  if (message.card.dismissed || message.card.answered) return true;
  const index = transcript.findIndex((entry) => entry.id === message.id);
  if (index < 0) return false;
  return transcript.slice(index + 1).some((later) => later.role === "user" && later.kind === "text");
}

export function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { state, dispatch } = useStore();
  const { t } = useI18n();
  const [custom, setCustom] = useState("");
  const [pending, setPending] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);
  const card = message.card;
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const transcript = bot ? visibleMessages(bot) : [];
  // Full thread, not the mounted window: a search-focus slice can omit the
  // later user message that means they already talked past this quiz.
  if (!card || shouldHideOnboardingCard(message, transcript)) return null;
  // The server stores the quiz in English; it follows the UI language here.
  const onboarding = isOnboardingCard(message);
  const title = onboarding ? t("onboarding.card.title") : card.title;
  const subtitle = onboarding ? t("onboarding.card.subtitle") : card.subtitle;
  const options = onboarding ? ONBOARDING_OPTIONS.map((key) => t(key)) : card.options;
  const answered = card.answered ?? null;
  const selectedOption = answered && options.includes(answered) ? answered : null;
  const customAnswered = Boolean(answered) && !selectedOption;

  const answer = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending || card.answered) return;
    setPending(true);
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: trimmed });
  };

  // Live provider free-text still goes through answerCard (requestId). Wiring
  // the docked composer to that requestId needs a larger store change — keep
  // local custom entry for correctness; "Write my own" focuses that field.
  const writeOwn = () => {
    if (card.tool) return;
    customRef.current?.focus();
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <QuestionChoiceCard
        question={title}
        subtitle={onboarding || subtitle ? subtitle : null}
        options={options}
        pending={pending}
        selectedOption={selectedOption}
        customAnswered={customAnswered}
        hideWriteOwn={Boolean(card.tool) || Boolean(card.answered)}
        onPick={answer}
        onWriteOwn={card.tool || card.answered ? undefined : writeOwn}
        headerEnd={
          <button
            type="button"
            onClick={() => dispatch({ type: "dismissCard", botId, messageId: message.id })}
            aria-label={t("chat.dismissQuestion")}
            className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          >
            <X size={16} aria-hidden="true" />
          </button>
        }
      />

      {/* a permission ask has no free-text answer — the broker only accepts
          allow/deny, so typing here used to fail silently */}
      {!card.answered && !card.tool && (
        <input
          ref={customRef}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) answer(custom);
          }}
          placeholder={t("chat.ownAnswer")}
          className="w-full max-w-[560px] rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
      )}
    </div>
  );
}
