// Default engine for new-bot creation, resolved from the available-engine
// snapshot the client already holds (GET /api/instances). Mirrors the
// server's resolveAutomaticSelection for the no-requirements case: first
// available engine with a default model that is not rate-limited out,
// falling back to the first eligible one. Sending this explicitly lets
// POST /api/bots skip full provider discovery (checkedModelSelection does
// no catalog/health I/O); when nothing is usable the caller omits
// modelSelection and the server path is unchanged.
import type { InstanceInfo, ModelSelection } from "@/state/store";

export function defaultModelSelection(
  instances: readonly InstanceInfo[] | undefined,
): ModelSelection | null {
  if (!instances) return null;
  const now = Date.now();
  const eligible = instances.filter(
    (instance) => instance.snapshot.state === "available" && Boolean(instance.models.default),
  );
  const exhausted = (instance: InstanceInfo): boolean =>
    instance.rateLimits?.windows.some(
      (window) =>
        Number.isFinite(window.usedPercent) &&
        window.usedPercent >= 100 &&
        !(window.resetsAt !== null && Number.isFinite(window.resetsAt) && window.resetsAt <= now),
    ) === true;
  const pick = eligible.find((instance) => !exhausted(instance)) ?? eligible[0];
  if (!pick) return null;
  return { mode: "automatic", instanceId: pick.instanceId, model: pick.models.default };
}
