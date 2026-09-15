import type { EffortLevel } from "../server/contracts.ts";

const DEFAULTS = new Map<string, EffortLevel>([
  ["claudeAgent:claude-fable-5-1", "high"],
  ["claudeAgent:claude-fable-5", "high"],
  ["claudeAgent:claude-opus-5", "high"],
  ["claudeAgent:claude-sonnet-5", "high"],
  ["codex:gpt-6-astra", "low"],
  ["codex:gpt-5.6-sol", "low"],
  ["codex:gpt-5.6-terra", "medium"],
  ["codex:gpt-5.6-luna", "medium"],
  ["grokAgent:grok-4.6", "high"],
  ["grokAgent:grok-4.5", "high"],
]);

export function defaultModelEffort(driverKind: string, model: string, levels: readonly string[] = []): EffortLevel | undefined {
  const effort = DEFAULTS.get(`${driverKind}:${model}`);
  return effort && levels.includes(effort) ? effort : undefined;
}

/** Grok xhigh is model-gated (LIVE-verified CLI 1.0.30): the 4.6 family
 * takes low–xhigh; 4.5 takes low–high and rejects xhigh/max. Anything
 * outside the 4.6 family (custom slugs included) never gets xhigh. */
export function grokModelTakesXhigh(model: string): boolean {
  return model.toLowerCase().startsWith("grok-4.6");
}

/** Model-aware effort gate. Instance capability lists are per-engine, but
 * Grok's xhigh is per-model, so an engine-level include is not enough. */
export function isEffortOffered(
  driverKind: string,
  model: string,
  effort: EffortLevel,
  levels: readonly EffortLevel[] = [],
): boolean {
  if (!levels.includes(effort)) return false;
  if (effort === "xhigh" && driverKind === "grokAgent" && !grokModelTakesXhigh(model)) return false;
  return true;
}

/** Declared levels filtered to what this model actually takes. Non-Grok
 * drivers pass through untouched. */
export function offeredEffortLevels(
  driverKind: string,
  model: string,
  levels: readonly EffortLevel[] = [],
): EffortLevel[] {
  return levels.filter((effort) => isEffortOffered(driverKind, model, effort, levels));
}
