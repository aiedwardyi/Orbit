import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";

export type KeepGoingMarkState = "on" | "paused";

export function keepGoingMarkState(bot: Pick<Bot, "keepGoing">): KeepGoingMarkState | null {
  if (!bot.keepGoing) return null;
  return bot.keepGoing.paused ? "paused" : "on";
}

const CHEVRON = "M4.4 3.1h1.5L8.8 6 5.9 8.9H4.4L7.3 6z";

// Solid when on, hollow when paused; the chevron is cut out, so it shows the ground behind it.
export function KeepGoingMark({ state, size = 12, className }: { state: KeepGoingMarkState; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" className={cn("block shrink-0 text-accent-text", className)} aria-hidden>
      {state === "on" ? (
        <path fill="currentColor" fillRule="evenodd" d={`M6 0a6 6 0 1 1 0 12A6 6 0 0 1 6 0z${CHEVRON}`} />
      ) : (
        <>
          <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path fill="currentColor" d={CHEVRON} />
        </>
      )}
    </svg>
  );
}
