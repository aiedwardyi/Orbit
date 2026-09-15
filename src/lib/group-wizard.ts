// Pure step logic for the New group wizard: engine suggestions, local bot
// naming, and the create payloads. No React, no I/O — unit-tested below.
import type { InstanceInfo } from "@/state/store";

/** An engine row the host can actually run a turn on. */
export function isEngineConnected(instance: InstanceInfo): boolean {
  return instance.snapshot.state === "available" && instance.snapshot.authenticated !== false;
}

/** Engine kinds retired from suggestions and dropdowns, mirroring the main
 * picker curation (single-sourced here; the picker omits them outright). */
export const RETIRED_ENGINE_KINDS: readonly string[] = ["geminiAgent"];

/** Engine dropdown options: connected instances minus retired kinds. The
 * current pick stays selectable via the unshift fallback. */
export function wizardEngineOptions(
  instances: InstanceInfo[],
  current: InstanceInfo | null,
): InstanceInfo[] {
  const connected = instances
    .filter(isEngineConnected)
    .filter((i) => !RETIRED_ENGINE_KINDS.includes(i.driverKind));
  if (current && !connected.some((i) => i.instanceId === current.instanceId)) {
    return [current, ...connected];
  }
  return connected;
}

/** Antigravity offers only Gemini 3.8/3.7 Flash tiers, mirroring the main
 * picker cells (drops 3.1-pro, 3.6/3.5, legacy customs). */
const ANTIGRAVITY_MODEL_PATTERN = /^gemini-3\.[87]-flash-(high|medium|low)$/;

export interface WizardModelOption {
  id: string;
  label: string;
}

/** Model options offered for a wizard row; other engines are unchanged. */
export function wizardModelOptions(instance: InstanceInfo): WizardModelOption[] {
  const options = instance.models.options;
  if (instance.driverKind !== "antigravityAgent") return options;
  const curated = options.filter((option) => ANTIGRAVITY_MODEL_PATTERN.test(option.id));
  return curated.length ? curated : options;
}

/** Resolve the row model against the offered options so the select never
 * goes blank: a requested model outside the offered set falls back to the
 * first offered option. */
export function resolveWizardModel(instance: InstanceInfo, model: string | null): string {
  const offered = wizardModelOptions(instance);
  const requested = model ?? instance.models.default;
  if (offered.some((option) => option.id === requested)) return requested;
  return offered[0]?.id ?? requested;
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


