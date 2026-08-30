import type { EffortLevel, ModelSelection } from "./contracts.ts";

export type AutomaticCapability =
  | "agentsMcp"
  | "approvalReview"
  | "browserMcp"
  | "composioMcp"
  | "computerMcp"
  | "localComputerMcp";

export interface AutomaticCandidate {
  instanceId: string;
  defaultModel: string;
  available: boolean;
  capabilities: Partial<Record<AutomaticCapability, boolean>>;
  effortLevels?: readonly EffortLevel[];
}

export function resolveAutomaticSelection(input: {
  candidates: readonly AutomaticCandidate[];
  current?: ModelSelection;
  continuity?: { instanceId?: string; model?: string };
  required?: readonly AutomaticCapability[];
}): ModelSelection | null {
  const required = input.required ?? [];
  const eligible = input.candidates.filter(
    (candidate) =>
      candidate.available &&
      candidate.defaultModel &&
      required.every((capability) => candidate.capabilities[capability] === true),
  );
  const preferredIds = [input.continuity?.instanceId, input.current?.instanceId];
  const candidate =
    preferredIds.flatMap((id) => (id ? eligible.filter((entry) => entry.instanceId === id) : []))[0] ??
    eligible[0];
  if (!candidate) return null;

  const continuityModel =
    input.continuity?.instanceId === candidate.instanceId ? input.continuity.model : undefined;
  const currentModel = input.current?.instanceId === candidate.instanceId ? input.current.model : undefined;
  const selection: ModelSelection = {
    mode: "automatic",
    instanceId: candidate.instanceId,
    model: continuityModel || currentModel || candidate.defaultModel,
  };
  if (
    input.current?.instanceId === candidate.instanceId &&
    input.current.effort &&
    candidate.effortLevels?.includes(input.current.effort)
  ) {
    selection.effort = input.current.effort;
  }
  return selection;
}
