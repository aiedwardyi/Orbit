// Compact 5-hour + weekly plan strip above the composer. Hidden when the
// active engine has no live windows — Grok/OpenCode never grow a pending row.
import type { RateLimitWindow } from "../../server/contracts.ts";
import { useI18n } from "@/lib/i18n";
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
      <div className={visible.length > 1 ? "grid grid-cols-2 gap-4" : "grid grid-cols-1"}>
        {visible.map((window) => (
          <PlanWindowMeter key={window.id} window={window} now={clock} compact />
        ))}
      </div>
    </div>
  );
}
