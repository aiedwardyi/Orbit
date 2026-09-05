import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

export function Card({
  title,
  subtitle,
  children,
  compact = false,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("rounded-xl bg-card", compact ? "px-4 py-3" : "p-4")}>
      {title && <div className={cn("font-medium text-ink", compact ? "text-[14px]" : "text-[15px]")}>{title}</div>}
      {subtitle && (
        <div
          className={cn(
            "text-ink-secondary",
            compact ? "text-[12px] leading-snug" : "text-[13px] leading-relaxed",
            title && "mt-0.5",
          )}
        >
          {subtitle}
        </div>
      )}
      {children && <div className={title || subtitle ? (compact ? "mt-2" : "mt-4") : undefined}>{children}</div>}
    </div>
  );
}

/** A command the user is meant to run, with one-click copy. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission can be denied; leave the button unchanged */
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink">
        {command}
      </code>
      <button
        onClick={() => void copy()}
        aria-label="Copy command"
        className="shrink-0 rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
