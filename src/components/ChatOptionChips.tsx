import { useEffect, useState } from "react";
import { focusComposerOnActivation } from "@/lib/focus-composer";
import { QuestionChoiceCard } from "./QuestionChoiceCard";

/** Focus the docked composer without touching its draft. */
export function focusOrbitComposer(): void {
  focusComposerOnActivation();
}

export function ChatOptionChips({
  options,
  question,
  onPick,
  onWriteOwn,
  answeredText,
  disabled,
}: {
  options: string[];
  question?: string | null;
  onPick: (text: string) => void;
  onWriteOwn?: () => void;
  /** Later user message that answered this card, when known. */
  answeredText?: string | null;
  disabled?: boolean;
}) {
  const answered = answeredText != null && answeredText !== "";
  const selectedOption = answered && options.includes(answeredText!) ? answeredText! : null;
  const customAnswered = answered && !selectedOption;
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (answered) setPending(false);
  }, [answered]);

  // Submission failed or was abandoned: busy cleared without an answer.
  useEffect(() => {
    if (!disabled && pending && !answered) setPending(false);
  }, [disabled, pending, answered]);

  return (
    <QuestionChoiceCard
      className="mt-2"
      question={question}
      options={options}
      pending={pending}
      disabled={disabled}
      selectedOption={selectedOption}
      customAnswered={customAnswered}
      onPick={(option) => {
        if (pending || answered || disabled) return;
        setPending(true);
        onPick(option);
      }}
      onWriteOwn={onWriteOwn ?? focusOrbitComposer}
    />
  );
}
