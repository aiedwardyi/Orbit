// Compact 5-hour + weekly plan strip above the composer. Hidden when the
// active engine has no live windows.
import type { RateLimitWindow } from "../../server/contracts.ts";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { planMeterWindows } from "@/lib/usage";
import { PlanWindowMeter, useNow } from "./PlanUsageBar";

export function ChatPlanMeters({
  windows,
  now,
  onOpenUsage,
}: {
  windows: RateLimitWindow[] | undefined;
  now?: number;
  onOpenUsage: () => void;
}) {
  // Decide visibility without starting the minute tick; chats without
  // windows never mount a timer for a strip they will not show.
  if (planMeterWindows(windows, now ?? Date.now()).length === 0) return null;
  return <ChatPlanMetersLive windows={windows} now={now} onOpenUsage={onOpenUsage} />;
}

function ChatPlanMetersLive({
  windows,
  now,
  onOpenUsage,
}: {
  windows: RateLimitWindow[] | undefined;
  now?: number;
  onOpenUsage: () => void;
}) {
  const { t } = useI18n();
  const tick = useNow();
  const clock = now ?? tick;
  const visible = planMeterWindows(windows, clock);
  if (visible.length === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpenUsage}
      className="w-full cursor-pointer px-5 pb-1 text-left"
      aria-label={t("usage.limits.openAria")}
    >
      <div className={cn("grid w-full items-center gap-x-6", visible.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
        {visible.map((window) => (
          <PlanWindowMeter key={window.id} window={window} now={clock} compact />
        ))}
      </div>
    </button>
  );
}
