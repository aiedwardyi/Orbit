import { useState } from "react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";

export function ChatOptionChips({
  options,
  onPick,
  disabled,
}: {
  options: string[];
  onPick: (text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [custom, setCustom] = useState("");
  const sendCustom = () => {
    const text = custom.trim();
    if (!text || disabled) return;
    onPick(text);
  };
  return (
    <div className="mt-2 flex w-full max-w-[min(42rem,78%)] flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={disabled}
            onClick={() => onPick(option)}
            className={cn(
              "rounded-full border border-hairline/50 bg-raised px-3 py-1.5 text-left text-[13px] text-ink",
              "hover:bg-raised-hover disabled:opacity-40",
            )}
          >
            {option}
          </button>
        ))}
      </div>
      <input
        value={custom}
        disabled={disabled}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && sendCustom()}
        placeholder={t("chat.ownAnswer")}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-40"
      />
    </div>
  );
}
