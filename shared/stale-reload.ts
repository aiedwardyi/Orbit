/** One reload per window for a page left on an older UI build, so a broken build can't loop. */

export const STALE_RELOAD_KEY = "omb-stale-reload-at";
export const STALE_RELOAD_WINDOW_MS = 30_000;

export function staleReloadAllowed(lastAt: number, now: number): boolean {
  const age = now - lastAt;
  return !(age >= 0 && age < STALE_RELOAD_WINDOW_MS);
}
