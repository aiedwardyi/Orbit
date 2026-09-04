// Shared plan-limit meter: the thin Grok-style track Settings already uses,
// plus the compact 5h / weekly row that sits above the composer.
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
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

export function planUsageFillClass(fill: number): string {
  return fill >= 90 ? "bg-danger" : fill >= 75 ? "bg-warning" : "bg-accent";
}

export function PlanUsageBar({ fill, className }: { fill: number; className?: string }) {
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-ink/10", className)} aria-hidden="true">
      <div className={cn("h-full rounded-full", planUsageFillClass(fill))} style={{ width: `${fill}%` }} />
    </div>
  );
}

export function PlanWindowMeter({
  window,
  now,
  compact = false,
}: {
  window: RateLimitWindow;
  now: number;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const percent = windowFillPercent(window, now);
  const fill = planUsageFill(percent);
  const kind = windowKind(window.id, window.windowMinutes);
  const labelKey = (compact ? PLAN_WINDOW_SHORT_LABEL_KEY : PLAN_WINDOW_LABEL_KEY)[kind];
  const phrase = resetPhrase(window.resetsAt, now);
  const compactReset = resetCompact(window.resetsAt, now);
  if (compact) {
    return (
      <div>
        <div className="flex items-center justify-between gap-2 text-[11.5px] text-ink">
          <span>{t(labelKey)}</span>
          <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
            {percent !== null && <span>{t("usage.limits.percentUsed", { percent })}</span>}
            {compactReset && (
              <span className="text-ink-secondary" title={t(phrase.key, phrase.vars)}>
                {t(compactReset.key, compactReset.vars)}
              </span>
            )}
          </span>
        </div>
        <PlanUsageBar fill={fill} className="mt-1" />
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-[13px] text-ink">
        <span>{t(labelKey)}</span>
        {percent !== null && <span className="tabular-nums">{t("usage.limits.percentUsed", { percent })}</span>}
      </div>
      <PlanUsageBar fill={fill} className="mt-1" />
      <div className="mt-1 text-[12px] text-ink-secondary">{t(phrase.key, phrase.vars)}</div>
    </div>
  );
}
