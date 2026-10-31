// Shared plan-limit meter: the thin Grok-style track Settings already uses,
// plus the compact 5h / weekly row that sits above the composer.
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useUsageMode } from "@/lib/usage-preferences";
import type { RateLimitWindow } from "../../server/contracts.ts";
import {
  resetCompact,
  resetPhrase,
  windowFillPercent,
  windowKind,
} from "@/lib/usage";

export const PLAN_WINDOW_LABEL_KEY = {
  session: "usage.limits.session",
  weekly: "usage.limits.weekly",
  other: "usage.limits.window",
} as const;

export const PLAN_WINDOW_SHORT_LABEL_KEY = {
  session: "usage.limits.sessionShort",
  weekly: "usage.limits.weeklyShort",
  other: "usage.limits.window",
} as const;

/** A minute tick so countdowns stay right while the surface is open. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function planUsageFill(percent: number | null): number {
  return percent === null ? 0 : Math.min(100, percent);
}

export function planUsageTone(usedPercent: number) {
  if (usedPercent >= 90) return { textClass: "text-danger", fillClass: "bg-danger" };
  if (usedPercent >= 75) return { textClass: "text-warning", fillClass: "bg-warning" };
  return { textClass: "text-accent", fillClass: "bg-accent" };
}

export function planUsageFillClass(fill: number): string {
  return planUsageTone(fill).fillClass;
}

export function PlanUsageBar({ fill, usedFill = fill, muted = false, className }: { fill: number; usedFill?: number; muted?: boolean; className?: string }) {
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-ink/10", className)} aria-hidden="true">
      <div className={cn("h-full rounded-full", muted ? "bg-ink-secondary" : planUsageFillClass(usedFill))} style={{ width: `${fill}%` }} />
    </div>
  );
}

export function PlanWindowMeter({
  window,
  now,
  compact = false,
  showReset = false,
  muted = false,
}: {
  window: RateLimitWindow;
  now: number;
  compact?: boolean;
  showReset?: boolean;
  /** An old reading: theme greys instead of the warning tones. */
  muted?: boolean;
}) {
  const { t } = useI18n();
  const mode = useUsageMode();
  const used = windowFillPercent(window, now);
  const percent = used === null ? null : mode === "remaining" ? Math.max(0, 100 - used) : used;
  const fill = planUsageFill(percent);
  const usedFill = planUsageFill(used);
  const kind = windowKind(window.id, window.windowMinutes);
  const labelKey = (compact ? PLAN_WINDOW_SHORT_LABEL_KEY : PLAN_WINDOW_LABEL_KEY)[kind];
  const phrase = resetPhrase(window.resetsAt, now);
  const label = `${t(labelKey)}: ${percent === null ? t(phrase.key, phrase.vars) : t(mode === "used" ? "usage.limits.used" : "usage.limits.remaining", { percent })}`;
  if (compact) {
    const segments = Math.round(fill / 10);
    const compactReset = showReset && resetCompact(window.resetsAt, now);
    return (
      <div role="group" aria-label={label} title={t(phrase.key, phrase.vars)}>
        <div className={cn("flex items-center gap-x-2 whitespace-nowrap text-[12.5px] max-md:gap-x-1", muted ? "text-ink-secondary" : "text-ink")}>
          <span className="shrink-0">{t(labelKey)}</span>
          <span aria-hidden="true" className={cn("min-w-0 font-mono tracking-tight max-md:flex-1 md:shrink-0", muted ? "text-ink-secondary" : planUsageTone(usedFill).textClass)}>
            <span className="max-md:hidden">{percent === null ? "▱".repeat(10) : "▰".repeat(segments) + "▱".repeat(10 - segments)}</span>
            <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="h-[7px] w-full md:hidden">
              {Array.from({ length: 10 }, (_, index) => (
                <polygon key={index} points={`${index * 10 + 3},1 ${index * 10 + 9},1 ${index * 10 + 7},9 ${index * 10 + 1},9`} fill={index < segments ? "currentColor" : "none"} stroke="currentColor" strokeWidth="0.75" vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
          </span>
          {percent !== null && <span className="shrink-0 tabular-nums">{t("usage.limits.percentUsed", { percent })}</span>}
          {compactReset && <span className="shrink-0 tabular-nums text-ink-secondary">({t(compactReset.key, compactReset.vars)})</span>}
        </div>
      </div>
    );
  }
  return (
    <div role="group" aria-label={label}>
      <div className={cn("flex items-center justify-between gap-3 text-[13px]", muted ? "text-ink-secondary" : "text-ink")}>
        <span>{t(labelKey)}</span>
        {percent !== null && <span className="tabular-nums">{t("usage.limits.percentUsed", { percent })}</span>}
      </div>
      <PlanUsageBar fill={fill} usedFill={usedFill} muted={muted} className="mt-1" />
      <div className="mt-1 text-[12px] text-ink-secondary">{t(phrase.key, phrase.vars)}</div>
    </div>
  );
}
