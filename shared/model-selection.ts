import type { ModelSelection } from "../server/contracts.ts";

export function sameModelSelection(a: ModelSelection, b: ModelSelection): boolean {
  return (
    a.instanceId === b.instanceId &&
    a.model === b.model &&
    (a.mode ?? "pinned") === (b.mode ?? "pinned") &&
    a.effort === b.effort
  );
}
