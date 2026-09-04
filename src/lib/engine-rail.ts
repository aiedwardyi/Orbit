// Split engines into Cloud (first-party catalog + Custom) and Local
// (no catalog — inject a model). A missing `access` is Cloud so older
// payloads stay in the top group. VibeCoder would join Local later.
import type { InstanceInfo } from "@/state/store";
import { showEngineRailZoo } from "./friends-chrome";

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

/** Featured engines as a visible icon list whenever more than one is present. */
export function isEngineRailOpen(input: {
  featuredCount: number;
}): boolean {
  return input.featuredCount > 1;
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

// Friends featured rail — Grok, Claude, Codex, Antigravity, OpenCode.
// Gemini API is not a rail engine: Gemini models live on Antigravity.
// The local/custom zoo stays off this list (showEngineRailZoo can restore it).
export const FRIENDS_DRIVER_ORDER = [
  "grokAgent",
  "claudeAgent",
  "codex",
  "antigravityAgent",
  "opencodeGo",
] as const;

export const FRIENDS_CLI_DRIVERS = new Set([
  "grokAgent",
  "claudeAgent",
  "codex",
  "antigravityAgent",
]);

const FRIENDS_DRIVERS = new Set<string>(FRIENDS_DRIVER_ORDER);

export function friendsDriverRank(driverKind: string | undefined): number {
  const index = FRIENDS_DRIVER_ORDER.indexOf(driverKind as (typeof FRIENDS_DRIVER_ORDER)[number]);
  return index === -1 ? FRIENDS_DRIVER_ORDER.length : index;
}

export function isFriendsEngine(
  instance: { driverKind?: string } | undefined,
): boolean {
  return FRIENDS_DRIVERS.has(instance?.driverKind ?? "");
}

export function isFriendsCliEngine(
  instance: { driverKind?: string } | undefined,
): boolean {
  return FRIENDS_CLI_DRIVERS.has(instance?.driverKind ?? "");
}

export function orderFriendsEngines<T>(instances: readonly T[]): T[] {
  return [...instances].sort((left, right) =>
    friendsDriverRank((left as { driverKind?: string }).driverKind)
    - friendsDriverRank((right as { driverKind?: string }).driverKind),
  );
}

export function splitFriendsEngines<T>(instances: readonly T[]): {
  friends: T[];
  rest: T[];
} {
  const friends: T[] = [];
  const rest: T[] = [];
  for (const instance of instances) {
    // SAFETY: the generic preserves the caller's row type; this split reads only driverKind.
    if (isFriendsEngine(instance as { driverKind?: string })) friends.push(instance);
    else rest.push(instance);
  }
  return { friends: orderFriendsEngines(friends), rest };
}

/** Chat-header engine rail: featured friends only, in Grok → Claude → Codex
 * → Antigravity → OpenCode order. The zoo expander is a friends-chrome flag. */
export function visibleFriendsRail<T extends { instanceId: string }>(
  instances: readonly T[],
  options: { showAll?: boolean; activeId?: string } = {},
): { visible: T[]; hiddenCount: number } {
  const { friends, rest } = splitFriendsEngines(instances);
  if (!showEngineRailZoo()) {
    return { visible: friends, hiddenCount: 0 };
  }
  const collapsible = friends.length > 0 && rest.length > 0;
  if (options.showAll || !collapsible) {
    return { visible: [...friends, ...rest], hiddenCount: 0 };
  }
  const visible = [...friends];
  if (options.activeId && !visible.some((row) => row.instanceId === options.activeId)) {
    const active = instances.find((row) => row.instanceId === options.activeId);
    if (active) visible.push(active);
  }
  return { visible, hiddenCount: instances.length - visible.length };
}

/** Quiet "Use a local model" on the selected engine when it already has
 * custom/local options. Never a rail of local engines. */
export function showFriendsLocalZoo(input: {
  customCount: number;
}): boolean {
  return input.customCount > 0;
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
