// Compact 5-hour + weekly plan strip above the composer. Hidden when the
// active engine has no live windows.
import { useId } from "react";
import type { RateLimitWindow } from "../../server/contracts.ts";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { museReading, planMeterWindows } from "@/lib/usage";
import { PlanWindowMeter, useNow } from "./PlanUsageBar";

type ChatPlanMetersProps = {
  windows: RateLimitWindow[] | undefined;
  driverKind?: string;
  observedAt?: string;
  now?: number;
  onOpenUsage: () => void;
};

export function ChatPlanMeters(props: ChatPlanMetersProps) {
  // Decide visibility without starting the minute tick; chats without
  // windows never mount a timer for a strip they will not show.
  if (planMeterWindows(props.windows, props.now ?? Date.now()).length === 0) return null;
  return <ChatPlanMetersLive {...props} />;
}

function ChatPlanMetersLive({ windows, driverKind, observedAt, now, onOpenUsage }: ChatPlanMetersProps) {
  const { t } = useI18n();
  const tick = useNow();
  const clock = now ?? tick;
  const visible = planMeterWindows(windows, clock);
  const reading = museReading(driverKind, observedAt, clock);
  const ageId = useId();
  if (visible.length === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpenUsage}
      className="w-full cursor-pointer px-5 pb-1 text-left"
      aria-label={t("usage.limits.openAria")}
      aria-describedby={reading?.stale ? ageId : undefined}
    >
      <div className={cn("grid w-full items-center gap-x-6", visible.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
        {visible.map((window) => (
          <PlanWindowMeter key={window.id} window={window} now={clock} compact muted={reading?.stale} />
        ))}
      </div>
      {reading?.stale && <div id={ageId} className="text-[12px] text-ink-secondary">{reading.label(t)}</div>}
    </button>
  );
}
