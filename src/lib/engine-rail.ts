// Split engines into Cloud (first-party catalog + Custom) and Local
// (no catalog — inject a model). A missing `access` is Cloud so older
// payloads stay in the top group. VibeCoder would join Local later.
import type { InstanceInfo } from "@/state/store";

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

/** The Cloud/Local icon rail stays folded until the user asks to switch. */
export function isEngineRailOpen(input: {
  instanceCount: number;
  railOpen: boolean;
}): boolean {
  return input.instanceCount > 1 && input.railOpen;
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

// First launch with nothing connected: one path, Grok or Claude. The rest of
// the fleet stays in Settings. An empty list means "not asked yet" so we do
// not flash this screen before /api/instances returns.
const STARTER_CONNECT_DRIVERS = ["grokAgent", "claudeAgent"] as const;

export function isEmptyEngineLaunch(
  instances: readonly { snapshot?: { state?: string } }[],
): boolean {
  return instances.length > 0 && !instances.some((instance) => instance.snapshot?.state === "available");
}

export function starterConnectEngines<T>(instances: readonly T[]): T[] {
  const picked: T[] = [];
  for (const driverKind of STARTER_CONNECT_DRIVERS) {
    for (const instance of instances) {
      // SAFETY: the generic preserves the caller's row type; this pick reads only driverKind.
      if ((instance as { driverKind?: string }).driverKind === driverKind) picked.push(instance);
    }
  }
  return picked;
}

export function firstLaunchConnectInstances<T>(instances: readonly T[]): T[] {
  return starterConnectEngines(
    // SAFETY: the generic preserves the caller's row type; this filter reads only install.
    instances.filter((instance) => Boolean((instance as { install?: unknown }).install)),
  );
}
