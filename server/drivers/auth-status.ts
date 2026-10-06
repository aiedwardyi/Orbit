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

export function cachedSignIn(probe: () => Promise<boolean | undefined>) {
  let cached: Promise<boolean | undefined> | undefined;
  let checkedAt = 0;
  return (refresh = false) => {
    if (refresh || !cached || Date.now() - checkedAt >= 30_000) {
      checkedAt = Date.now();
      cached = probe();
    }
    return cached;
  };
}
