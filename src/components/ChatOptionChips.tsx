import { cn } from "@/lib/cn";

export function ChatOptionChips({
  options,
  onPick,
  disabled,
}: {
  options: string[];
  onPick: (text: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-2 flex max-w-[min(42rem,78%)] flex-wrap gap-1.5">
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
  );
}
