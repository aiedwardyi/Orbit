// Compact 5-hour + weekly plan strip above the composer. Hidden when the
// active engine has no live windows — Grok/OpenCode never grow a pending row.
import type { RateLimitWindow } from "../../server/contracts.ts";
import type { TaskUsage } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { formatTokens, planMeterWindows, usageDetail } from "@/lib/usage";
import { PlanWindowMeter, useNow } from "./PlanUsageBar";

// Indexed by cell count so Tailwind sees each template as a literal.
// Shared with the Settings plan card so both grids span the same columns.
// Index 4 is Settings-only: three windows plus the spend readout. The chat
// strip never reaches it — planMeterWindows caps it at two windows, so with
// the readout it peaks at three cells.
export const GRID_COLS = [
  "grid-cols-1",
  "grid-cols-1",
  "grid-cols-[auto_auto]",
  "grid-cols-[auto_auto_auto]",
  "grid-cols-[auto_auto_auto_auto]",
] as const;

export function ChatPlanMeters({
  windows,
  usage,
  now,
}: {
  windows: RateLimitWindow[] | undefined;
  usage?: TaskUsage;
  now?: number;
}) {
  // Decide visibility without starting the minute tick; Grok/OpenCode
  // chats never mount a timer for a strip they will not show.
  if (planMeterWindows(windows, now ?? Date.now()).length === 0) return null;
  return <ChatPlanMetersLive windows={windows} usage={usage} now={now} />;
}

function ChatPlanMetersLive({
  windows,
  usage,
  now,
}: {
  windows: RateLimitWindow[] | undefined;
  usage?: TaskUsage;
  now?: number;
}) {
  const { t } = useI18n();
  const tick = useNow();
  const clock = now ?? tick;
  const visible = planMeterWindows(windows, clock);
  // Driven by what was actually banked, never by which engine it is: acp
  // only emits usage when the wrapped agent reports it, so any allowlist
  // would be wrong for the drivers that share it.
  const spent = usage && usage.input + usage.output > 0 ? usage : undefined;
  const detail = spent && usageDetail(spent);
  if (visible.length === 0) return null;
  return (
    <div className="px-5 pb-1" role="group" aria-label={t("usage.limits.title")}>
      {/* Content-sized and centred: two 50% tracks left the pair flush left with all the slack on the right. */}
      <div className={cn("mx-auto grid w-fit items-center gap-x-6", GRID_COLS[visible.length + (spent ? 1 : 0)])}>
        {visible.map((window) => (
          <PlanWindowMeter key={window.id} window={window} now={clock} compact />
        ))}
        {spent && detail && (
          <span className="shrink-0 tabular-nums text-[12.5px] text-ink-secondary" title={t(detail.key, detail.vars)}>
            {`↑${formatTokens(spent.input)} ↓${formatTokens(spent.output)}`}
          </span>
        )}
      </div>
    </div>
  );
}
