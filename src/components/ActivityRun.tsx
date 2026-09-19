// A folded stretch of tool chips: one row saying what ran, click to open.
//
// Collapsed by default. A run stays open once you open it, and search can
// force it open so a hit is not stuck behind the fold. A failure count stays
// in the summary as muted text; the row itself never goes red.
import { useEffect, useState } from "react";
import { ChevronRight, Check, X } from "lucide-react";
import type { Message } from "@/state/store";
import { describeRun } from "@/lib/activity-runs";

export function ActivityRun({
  messages,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  /** landing on a step inside this run — a search hit cannot scroll to a
   * row that a fold has kept out of the DOM */
  forceOpen?: boolean;
  /** the individual chips, rendered by whichever transcript owns them */
  children: React.ReactNode;
}) {
  const failed = messages.some((message) => message.tool?.ok === false);
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  if (open) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex justify-start">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-expanded
            className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control"
          >
            <ChevronRight size={13} className="rotate-90" />
            <span>{describeRun(messages)}</span>
          </button>
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        title="Show every step"
        className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control"
      >
        {failed ? <X size={13} strokeWidth={1.5} /> : <Check size={13} className="text-success" />}
        <span className="max-w-[480px] truncate">{describeRun(messages)}</span>
        <ChevronRight size={13} />
      </button>
    </div>
  );
}
