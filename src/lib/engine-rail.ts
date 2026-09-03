// Split engines into Cloud (first-party catalog + Custom) and Local
// (no catalog — inject a model). A missing `access` is Cloud so older
// payloads stay in the top group. VibeCoder would join Local later.
import type { InstanceInfo } from "@/state/store";

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

export function splitEngineRail<T>(instances: readonly T[]): {
  subscription: T[];
  custom: T[];
} {
  const subscription: T[] = [];
  const custom: T[] = [];
  for (const instance of instances) {
    if (isCustomOnly(instance as { access?: InstanceInfo["access"] })) custom.push(instance);
    else subscription.push(instance);
  }
  return { subscription, custom };
}

// The four friends engines — Claude, Codex, Gemini, Grok — across five drivers:
// Gemini ships both a direct and an Antigravity route, and QA_PROMPT.md tests it
// through Antigravity. Everything else stays one click away behind Show all: a
// disclosure, never a removal. An engine the user pointed at a binary is always
// shown, because hiding a configured engine would read as Orbit having dropped it.
const FRIENDS_DRIVERS = new Set([
  "claudeAgent",
  "codex",
  "grokAgent",
  "geminiAgent",
  "antigravityAgent",
]);

export function isFriendsEngine(
  instance: { driverKind?: string; cli?: string } | undefined,
): boolean {
  if (instance?.cli) return true;
  return FRIENDS_DRIVERS.has(instance?.driverKind ?? "");
}

export function splitFriendsEngines<T>(instances: readonly T[]): {
  friends: T[];
  rest: T[];
} {
  const friends: T[] = [];
  const rest: T[] = [];
  for (const instance of instances) {
    // SAFETY: the generic preserves the caller's row type; this split reads only these two fields.
    if (isFriendsEngine(instance as { driverKind?: string; cli?: string })) friends.push(instance);
    else rest.push(instance);
  }
  return { friends, rest };
}
