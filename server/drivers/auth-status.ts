import { readFileSync, statSync } from "node:fs";

const fileChecks = new Map<string, { identity: string; authenticated: boolean }>();

export function storedSignIn(path: string, classify: (text: string) => boolean): boolean {
  try {
    const stat = statSync(path);
    const identity = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = fileChecks.get(path);
    if (cached?.identity === identity) return cached.authenticated;
    const authenticated = classify(readFileSync(path, "utf8"));
    fileChecks.set(path, { identity, authenticated });
    return authenticated;
  } catch {
    fileChecks.delete(path);
    return false;
  }
}

/** Reuses only a signed-in result, so a fresh terminal sign-in shows on the next check. */
export function cachedSignIn(probe: () => Promise<boolean | undefined>) {
  let cached: Promise<boolean | undefined> | undefined;
  let reuseUntil = 0;
  return (refresh = false) => {
    if (refresh || !cached || Date.now() >= reuseUntil) {
      const current = probe();
      cached = current;
      reuseUntil = Infinity;
      void current.then((signedIn) => {
        if (cached === current) reuseUntil = signedIn === true ? Date.now() + 30_000 : 0;
      });
    }
    return cached;
  };
}
