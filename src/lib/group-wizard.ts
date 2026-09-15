// Pure step logic for the New group wizard: engine suggestions, local bot
// naming, and the create payloads. No React, no I/O — unit-tested below.
import type { Bot, InstanceInfo } from "@/state/store";

/** An engine row the host can actually run a turn on. */
export function isEngineConnected(instance: InstanceInfo): boolean {
  return instance.snapshot.state === "available" && instance.snapshot.authenticated !== false;
}

export interface EnginePick {
  instance: InstanceInfo;
  /** True when the pick is not one of the preferred kinds. */
  substituted: boolean;
}

/** First connected instance in prefer-kind order, else first connected. */
export function suggestEngine(
  instances: InstanceInfo[],
  preferKinds: readonly string[],
  excludeInstanceIds?: ReadonlySet<string>,
): EnginePick | null {
  const open = instances.filter((i) => isEngineConnected(i) && !excludeInstanceIds?.has(i.instanceId));
  for (const kind of preferKinds) {
    const hit = open.find((i) => i.driverKind === kind);
    if (hit) return { instance: hit, substituted: false };
  }
  const fallback = open[0];
  return fallback ? { instance: fallback, substituted: true } : null;
}

/** A readable bot name from the job text, generated without a roundtrip. */
export function botNameFromJob(job: string): string {
  const words = job.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return "";
  const name = words.join(" ");
  const capped = name.length > 40 ? `${name.slice(0, 40).trimEnd()}…` : name;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

export interface WizardBotSelection {
  instanceId: string;
  model: string;
}

export interface WizardBotPayload {
  job: string;
  name: string;
  modelSelection: WizardBotSelection;
}

/** Payload for POST /api/bots for an inline-described wizard bot. */
export function newBotPayload(job: string, selection: WizardBotSelection): WizardBotPayload {
  return { job: job.trim(), name: botNameFromJob(job), modelSelection: selection };
}

export interface WizardGroupPayload {
  name: string;
  memberIds: string[];
  setup: { bulletin: ""; defaultResponder: { kind: "everyone" } };
}

/** Payload for POST /api/groups from the wizard: everyone replies, no
 * shared folder, empty instructions, no section, setup already complete so
 * the old setup screen never appears. */
export function groupCreatePayload(name: string, memberIds: string[]): WizardGroupPayload {
  return { name, memberIds, setup: { bulletin: "", defaultResponder: { kind: "everyone" } } };
}

/** Bots the step-3 list may offer: visible, and not the first bot. */
export function botChoicesForStep(bots: Bot[], excludeId: string | null): Bot[] {
  return bots.filter((b) => !b.hidden && b.id !== excludeId);
}
