import { useEffect, useState } from "react";

/** A running turn goes quiet this long before "slow" reads as "maybe stuck". */
export const STUCK_WARNING_MS = 5 * 60_000;

/** Minutes since the last event, once a running turn has stayed quiet this long. */
export function stuckWarningMinutes(elapsedMs: number): number | null {
  if (elapsedMs < STUCK_WARNING_MS) return null;
  return Math.floor(elapsedMs / 60_000);
}

/**
 * Ticks a "No output for N min" reading while a turn runs with no new event.
 * `eventKey` is anything that changes when text, a tool step, or a status
 * event arrives; a change to it, or `running` turning true, resets the clock.
 * The reset happens during render (not an effect) so a new event clears the
 * warning in the same commit instead of one tick later.
 */
export function useStuckWarning(running: boolean, eventKey: string): number | null {
  const signature = `${running}:${eventKey}`;
  const [trackedSignature, setTrackedSignature] = useState(signature);
  const [lastEventAt, setLastEventAt] = useState(() => Date.now());
  if (signature !== trackedSignature) {
    setTrackedSignature(signature);
    setLastEventAt(Date.now());
  }

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    // One timeout for the moment the warning becomes due, then one per minute
    // after that (re-aligned each time so drift can't skip or repeat a minute)
    // - never a per-second tick re-rendering the whole turn while it's quiet.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        setNow(Date.now());
        const elapsed = Date.now() - lastEventAt;
        const sinceDue = elapsed - STUCK_WARNING_MS;
        schedule(sinceDue < 0 ? -sinceDue : 60_000 - (sinceDue % 60_000));
      }, delay);
    };
    schedule(Math.max(0, STUCK_WARNING_MS - (Date.now() - lastEventAt)));
    return () => clearTimeout(timer);
  }, [running, lastEventAt]);

  return running ? stuckWarningMinutes(now - lastEventAt) : null;
}
