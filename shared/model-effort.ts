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
