// A folded stretch of tool chips: one row saying what ran, click to open.
//
// Collapsed by default. A run stays open once you open it, and search can
// force it open so a hit is not stuck behind the fold. A failure shows as a
// quiet cross beside the summary; the row itself never goes red.
import { useEffect, useState } from "react";
import { Bot, ChevronRight, Check, FileText, Globe, Loader2, Pencil, Search, SquareTerminal, Wrench, X } from "lucide-react";
import type { Message } from "@/state/store";
import { describeRun } from "@/lib/activity-runs";

function StepStatus({ ok }: { ok: boolean | undefined }) {
  if (ok === undefined) return <Loader2 size={13} className="shrink-0 animate-spin" />;
  if (ok === false) return <X size={13} strokeWidth={1.5} className="shrink-0" />;
  return <Check size={13} className="shrink-0 text-success" />;
}

function stepIcon(name: string) {
  if (name === "Read") return FileText;
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return Pencil;
  if (name === "Bash") return SquareTerminal;
  if (name === "Grep" || name === "Glob") return Search;
  if (name === "WebFetch" || name === "WebSearch") return Globe;
  if (name === "Agent" || name === "Task") return Bot;
  return Wrench;
}

const formatDuration = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;

/** One step inside an open run. A running step ticks its elapsed time, then
 * settles in the same row: same key, same element, only the status swaps. */
export function ActivityStep({ message }: { message: Message }) {
  const tool = message.tool;
  const running = tool?.ok === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  if (!tool) return null;
  const Icon = stepIcon(tool.name);
  const elapsed = running ? Math.max(0, now - new Date(message.at).getTime()) : tool.durationMs;
  return (
    <div className="flex max-w-[min(42rem,100%)] items-center gap-2 px-3 py-0.5 text-[13px] text-ink-secondary">
      <Icon size={13} className="shrink-0" />
      <span className="shrink-0 text-ink">{tool.name}</span>
      {tool.summary && <span className="min-w-0 truncate font-mono text-[12px]">{tool.summary}</span>}
      <StepStatus ok={tool.ok} />
      <span className="ml-auto shrink-0 pl-3 text-[12px] tabular-nums">{elapsed === undefined ? "" : formatDuration(elapsed)}</span>
    </div>
  );
}

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
  const running = messages.some((message) => message.tool?.ok === undefined);
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
            <span>{describeRun(messages)} ·</span>
            <StepStatus ok={running ? undefined : !failed} />
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
        <span className="max-w-[480px] truncate">{describeRun(messages)} ·</span>
        <StepStatus ok={running ? undefined : !failed} />
        <ChevronRight size={13} />
      </button>
    </div>
  );
}
