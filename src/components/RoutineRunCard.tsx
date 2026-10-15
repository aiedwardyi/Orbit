import {
  AlarmClock,
  Bell,
  Check,
  CircleAlert,
  Clock,
  Cloud,
  ExternalLink,
  ShieldAlert,
  X,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n, type Translate } from "@/lib/i18n";
import type { RoutineRunCardData } from "../../shared/routine-run";
import type { Message } from "@/state/store";

const DETAIL_LIMIT = 280;

function compactDetail(value: string | undefined): string {
  const clean = value?.replace(/\s+/g, " ").trim() ?? "";
  return clean.length > DETAIL_LIMIT ? `${clean.slice(0, DETAIL_LIMIT - 1).trimEnd()}…` : clean;
}

function clock(at: number | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** A lifecycle receipt can outlive its isolated execution task. Only offer
 * navigation while the task is still present in the owning bot's task list. */
export function hasRoutineExecutionTask(
  tasks: ReadonlyArray<{ threadId: string }> | undefined,
  executionThreadId: string | undefined,
): executionThreadId is string {
  return Boolean(
    executionThreadId && tasks?.some((task) => task.threadId === executionThreadId),
  );
}

function footer(run: RoutineRunCardData, ringing: boolean, t: Translate) {
  const className = "shrink-0";
  const scheduled = clock(run.scheduledFor);
  switch (run.status) {
    case "queued":
      return { icon: <Clock size={14} className={className} />, text: t("routine.card.queued") };
    case "waiting":
      return { icon: <ShieldAlert size={14} className={cn(className, "text-warning")} />, text: t("routine.card.waiting") };
    case "failed":
      return {
        icon: <CircleAlert size={14} className={cn(className, "text-danger")} />,
        text: t("routine.card.failed", { error: compactDetail(run.error ?? run.summary) }),
      };
    case "missed":
      return { icon: <CircleAlert size={14} className={cn(className, "text-danger")} />, text: t("routine.card.missed", { time: scheduled }) };
    case "cancelled":
      return { icon: <X size={14} className={className} />, text: t("routine.card.cancelled") };
    default:
      if (run.runOn === "cloud" && run.status === "completed") {
        return { icon: <Cloud size={14} className={cn(className, "text-success")} />, text: t("routine.card.cloud") };
      }
      return {
        icon: run.status === "completed" && !ringing
          ? <Check size={14} className={cn(className, "text-success")} />
          : <Bell size={14} className={cn(className, "text-accent")} />,
        text: t("routine.card.rang", { time: clock(run.startedAt ?? run.scheduledFor) }),
      };
  }
}

export function RoutineRunCard({
  message,
  ringing = false,
  onOpen,
}: {
  message: Message;
  /** fired in this chat and not yet seen: the accent border */
  ringing?: boolean;
  /** Opens the isolated execution task; absent when it no longer exists. */
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const run = message.routineRun;
  // Newer computers can send this message kind to an older or partially
  // hydrated client. Keep the concise text fallback visible instead of
  // leaving an unexplained hole in the conversation.
  if (!run) {
    const fallback = compactDetail(message.text);
    return fallback ? (
      <div className="w-fit max-w-[min(42rem,88%)] rounded-2xl bg-card px-4 py-2.5 text-[14px] leading-relaxed text-ink">
        {fallback}
      </div>
    ) : null;
  }

  const foot = footer(run, ringing, t);
  const instruction = run.instruction?.replace(/\s+/g, " ").trim();
  // detached runs (cloud, webhook, older local) report their result here
  const result = run.executionThreadId && run.status !== "failed" && run.status !== "missed"
    ? compactDetail(run.summary)
    : "";
  const time = clock(run.scheduledFor);
  const actionLabel = run.status === "waiting" ? "Review" : "Open run";

  return (
    <section
      data-routine-run={run.status}
      data-ringing={ringing || undefined}
      aria-label={`${run.routineName}: ${foot.text}`}
      className={cn(
        "w-full max-w-[840px] rounded-2xl border bg-card p-4",
        ringing || run.status === "queued" ? "border-accent/40" : "border-hairline/30 opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-ink">
        <AlarmClock size={14} className="shrink-0 text-accent" />
        <span className="min-w-0 truncate">{run.routineName}</span>
        {time && <span className="ml-auto shrink-0 text-[12.5px] font-medium text-ink-secondary">{time}</span>}
      </div>
      {instruction && <div className="mt-1 truncate text-[14px] leading-relaxed text-ink">{instruction}</div>}
      {result && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-secondary">{result}</p>}
      <div className="mt-3 flex min-w-0 items-center gap-1.5 text-[13px] text-ink-secondary">
        {foot.icon}
        <span aria-live="polite" className="min-w-0 truncate">{foot.text}</span>
        {onOpen && run.executionThreadId && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`${actionLabel} for ${run.routineName}`}
            className={cn(
              "ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium transition-colors",
              run.status === "waiting"
                ? "bg-warning/15 text-warning hover:bg-warning/25"
                : "bg-raised text-ink-secondary hover:bg-raised-hover hover:text-ink",
            )}
          >
            {actionLabel}
            <ExternalLink aria-hidden="true" size={12} />
          </button>
        )}
      </div>
    </section>
  );
}
