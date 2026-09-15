import type { InstanceInfo, ModelSelection } from "@/state/store";
import { defaultModelEffort, isEffortOffered, offeredEffortLevels } from "../../shared/model-effort.ts";

type ModelOption = InstanceInfo["models"]["options"][number];
export type PickerCell = { label: string; options: ModelOption[]; offList?: boolean };
export type PickerRow = { instance: InstanceInfo; label: string; cells: PickerCell[] };

const ENGINES = [
  ["claudeAgent", "Anthropic"],
  ["codex", "OpenAI"],
  ["grokAgent", "Grok"],
  ["antigravityAgent", "Antigravity"],
  ["museAgent", "Meta Muse"],
  ["geminiAgent", "Gemini"],
] as const;

const MODELS = new Map<string, string[]>(Object.entries({
  claudeAgent: ["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
  codex: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  grokAgent: ["grok-4.6", "grok-4.5"],
  museAgent: ["muse-spark-1.3", "muse-spark-1.3-contributor"],
  geminiAgent: ["auto", "gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
}));

export function pickerRows(instances: InstanceInfo[], current: ModelSelection, preview = current): PickerRow[] {
  const ordered: Array<{ instance: InstanceInfo; label: string }> = ENGINES.flatMap(([kind, label]) => instances
    .filter((instance) => instance.driverKind === kind)
    .map((instance) => ({ instance, label })));
  // Roster dedup by id: a duplicated entry must not fan out into repeated
  // rows. First wins; distinct ids (two real accounts) still list twice.
  const seen = new Set<string>();
  const rows = ordered.filter((row) => {
    if (seen.has(row.instance.instanceId)) return false;
    seen.add(row.instance.instanceId);
    return true;
  });
  const other = instances.find((instance) => instance.instanceId === current.instanceId);
  if (other && !seen.has(other.instanceId)) {
    seen.add(other.instanceId);
    rows.push({ instance: other, label: other.displayName });
  }
  return rows.map(({ instance, label }) => {
    // Roster dedup: a repeated catalog id must not fan out into repeated
    // picker cells (3x Meta Muse + 2x Contributor from one engine). First
    // row wins so the card labels stay stable.
    const seen = new Set<string>();
    const catalog = instance.models.options.filter((option) => {
      if (option.custom || seen.has(option.id)) return false;
      seen.add(option.id);
      return true;
    });
    let cells: PickerCell[];
    if (instance.driverKind === "antigravityAgent") {
      cells = ["3.8", "3.7", "3.6", "3.5"].flatMap((version) => {
        const options = catalog.filter((option) => new RegExp(`^gemini-${version.replace(".", "\\.")}-flash-(high|medium|low)$`).test(option.id));
        return options.length ? [{ label: `Gemini ${version} Flash`, options }] : [];
      });
    } else {
      const options = (MODELS.get(instance.driverKind) ?? []).flatMap((id) => catalog.filter((option) => option.id === id));
      cells = options.map((option) => ({ label: option.label.replace(/^Claude /, ""), options: [option] }));
    }
    for (const selection of [current, preview]) {
      if (instance.instanceId !== selection.instanceId || !selection.model || cells.some((cell) => cell.options.some((option) => option.id === selection.model))) continue;
      const option = instance.models.options.find((option) => option.id === selection.model) ?? { id: selection.model, label: selection.model };
      const family = instance.driverKind === "antigravityAgent" ? option.id.match(/^(gemini-.+)-(high|medium|low)$/)?.[1] : undefined;
      const variants = family ? catalog.filter((model) => model.id.replace(/-(high|medium|low)$/, "") === family) : [];
      const options = variants.some((model) => model.id === selection.model) ? variants : [option];
      cells.push({ label: option.label, options, offList: true });
    }
    return { instance, label, cells };
  });
}

export function pickerColumn(row: PickerRow, model: string): number {
  return Math.max(0, row.cells.findIndex((cell) => cell.options.some((option) => option.id === model)));
}

export function pickerModels(rows: PickerRow[]) {
  return rows.flatMap((row) => row.cells.map((cell) => ({ ...row, cell })));
}

export type PickerEffort = { id: string; label: string; model?: string; effort?: ModelSelection["effort"] };

export function pickerEfforts(row: PickerRow, cell: PickerCell): PickerEffort[] {
  if (row.instance.driverKind === "antigravityAgent") {
    if (cell.options.length < 2) return [];
    return ["low", "medium", "high"].flatMap((tier) => cell.options
      .filter((option) => option.id.endsWith(`-${tier}`))
      .map((option) => ({ id: option.id, label: tier, model: option.id })));
  }
  const levels = row.instance.capabilities?.effortLevels ?? [];
  // Effort options belong to this cell's model: Grok xhigh is 4.6-only, so
  // the 4.5 cell never offers it even though the engine declares it.
  const model = cell.options[0]?.id ?? "";
  return offeredEffortLevels(row.instance.driverKind, model, levels).map((effort) => ({ id: effort, label: effort, effort }));
}

export function withPickerEffort(instance: InstanceInfo | undefined, selection: ModelSelection): ModelSelection {
  if (!instance || selection.effort !== undefined) return selection;
  const effort = defaultModelEffort(instance.driverKind, selection.model, instance.capabilities?.effortLevels);
  return effort ? { ...selection, effort } : selection;
}

export function selectPickerEffort(current: ModelSelection, option: PickerEffort): ModelSelection {
  const { effort: _, ...next } = current;
  if (option.model) return { ...next, model: option.model, mode: "pinned" };
  return option.effort ? { ...next, effort: option.effort } : next;
}

export function selectPickerModel(instance: InstanceInfo, model: string, previous: ModelSelection): ModelSelection {
  if (previous.instanceId === instance.instanceId && previous.model === model) return withPickerEffort(instance, previous);
  const next: ModelSelection = { instanceId: instance.instanceId, model, mode: "pinned" };
  // Keep the effort when the target engine supports it, even across engines:
  // changing effort keeps the model list, so jumping models must keep the
  // effort instead of snapping the plane back to the edge. The check is
  // model-aware: switching 4.6 → 4.5 drops xhigh instead of retaining it.
  if (previous.effort && isEffortOffered(instance.driverKind, model, previous.effort, instance.capabilities?.effortLevels ?? [])) {
    next.effort = previous.effort;
  }
  return withPickerEffort(instance, next);
}

export function movePicker(rows: PickerRow[], current: ModelSelection, key: string): ModelSelection {
  const models = pickerModels(rows);
  const index = models.findIndex((item) => item.instance.instanceId === current.instanceId && item.cell.options.some((option) => option.id === current.model));
  const row = models[index];
  if (!row) return current;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const options = pickerEfforts(row, row.cell);
    const selected = options.findIndex((option) => option.model ? option.model === current.model : option.effort === current.effort);
    const start = selected < 0 ? (key === "ArrowRight" ? -1 : 0) : selected;
    const target = options[(start + (key === "ArrowLeft" ? -1 : 1) + options.length) % options.length];
    return target ? selectPickerEffort(current, target) : current;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    const direction = key === "ArrowUp" ? -1 : 1;
    const target = models[(index + direction + models.length) % models.length]!;
    const tier = row.instance.driverKind === "antigravityAgent" ? current.model.match(/-(low|medium|high)$/)?.[0] : undefined;
    const option = (tier && target.cell.options.find((option) => option.id.endsWith(tier))) || target.cell.options[0]!;
    // Antigravity encodes effort in the model id with no selection.effort, so
    // a bare jump would lose it: carry the tier across when the target speaks
    // effort. Antigravity targets keep their id-encoded tiers effort-free.
    const encoded: ModelSelection["effort"] = tier === "-low" ? "low" : tier === "-medium" ? "medium" : tier === "-high" ? "high" : undefined;
    const previous = !current.effort && encoded && target.instance.driverKind !== "antigravityAgent"
      ? { ...current, effort: encoded }
      : current;
    return selectPickerModel(target.instance, option.id, previous);
  }
  return current;
}
