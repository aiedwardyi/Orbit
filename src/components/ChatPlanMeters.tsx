// Compact 5-hour + weekly plan strip above the composer. Hidden when the
// active engine has no live windows — Grok/OpenCode never grow a pending row.
import type { RateLimitWindow } from "../../server/contracts.ts";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { planMeterWindows } from "@/lib/usage";
import { PlanWindowMeter, useNow } from "./PlanUsageBar";

export function ChatPlanMeters({
  windows,
  now,
}: {
  windows: RateLimitWindow[] | undefined;
  now?: number;
}) {
  // Decide visibility without starting the minute tick; Grok/OpenCode
  // chats never mount a timer for a strip they will not show.
  if (planMeterWindows(windows, now ?? Date.now()).length === 0) return null;
  return <ChatPlanMetersLive windows={windows} now={now} />;
}

function ChatPlanMetersLive({
  windows,
  now,
}: {
  windows: RateLimitWindow[] | undefined;
  now?: number;
}) {
  const { t } = useI18n();
  const tick = useNow();
  const clock = now ?? tick;
  const visible = planMeterWindows(windows, clock);
  if (visible.length === 0) return null;
  return (
    <div className="px-5 pb-1" role="group" aria-label={t("usage.limits.title")}>
      {/* Content-sized and centred: two 50% tracks left the pair flush left with all the slack on the right. */}
      <div className={cn("mx-auto grid w-fit gap-x-6", visible.length > 1 ? "grid-cols-[auto_auto]" : "grid-cols-1")}>
        {visible.map((window) => (
          <PlanWindowMeter key={window.id} window={window} now={clock} compact />
        ))}
      </div>
    </div>
  );
}
