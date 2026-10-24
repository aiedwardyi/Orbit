// Server start counts as the first wake.
const wakes = [Date.now()];

/** A tick over a minute late means the PC slept; the wake is dated one interval early since the tick can trail it. */
export function lateTick(due: number, intervalMs: number, now: number): boolean {
  if (now - due <= 60_000) return false;
  wakes.push(now - intervalMs);
  return true;
}

export function wakeClock(intervalMs: number): (now?: number) => void {
  let last: number | undefined;
  return (now = Date.now()) => {
    if (last !== undefined) lateTick(last + intervalMs, intervalMs, now);
    last = now;
  };
}

export function soonAfterWake(at: number, windowMs: number): boolean {
  return wakes.some((start) => at >= start && at - start <= windowMs);
}
