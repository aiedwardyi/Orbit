import type { InstanceInfo, ModelSelection } from "@/state/store";
import { defaultModelEffort } from "../../shared/model-effort.ts";

type ModelOption = InstanceInfo["models"]["options"][number];
export type PickerCell = { label: string; options: ModelOption[]; offList?: boolean };
export type PickerRow = { instance: InstanceInfo; label: string; cells: PickerCell[] };

const ENGINES = [
  ["claudeAgent", "Anthropic"],
  ["codex", "OpenAI"],
  ["grokAgent", "Grok"],
  ["antigravityAgent", "Antigravity"],
  ["opencodeGo", "OpenCode"],
] as const;

const MODELS = new Map<string, string[]>(Object.entries({
  claudeAgent: ["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
  codex: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  grokAgent: ["grok-4.6", "grok-4.5"],
}));

export function freePickerModels(catalog: ModelOption[]): ModelOption[] {
  const pinned = ["meta/muse-spark-1.3", "meta/muse-spark-1.3-contributor"].flatMap((id) => catalog.filter((option) => option.id === id));
  const openrouter = catalog.filter((option) => option.id.startsWith("openrouter/"));
  const free = openrouter.filter((option) => option.id.endsWith(":free"));
  const families = [/nemotron.*3.*ultra/i, /laguna-s-2[.-]1/i, /nemotron.*3[.-]5.*lightning/i];
  const ling = /ling-3[.-]0-flash-fin/i;
  if (free.length === 0) return [...pinned, ...openrouter.filter((option) => !ling.test(option.id))].slice(0, 4);
  const preferred = families.flatMap((family) => free.filter((option) => family.test(option.id)).slice(0, 1));
  return [...pinned, ...preferred, ...free.filter((option) => !preferred.includes(option) && !ling.test(option.id))].slice(0, 4);
}

export function pickerRows(instances: InstanceInfo[], current: ModelSelection, preview = current): PickerRow[] {
  const ordered: Array<{ instance: InstanceInfo; label: string }> = ENGINES.flatMap(([kind, label]) => instances
    .filter((instance) => instance.driverKind === kind)
    .map((instance) => ({ instance, label })));
  const other = instances.find((instance) => instance.instanceId === current.instanceId);
  if (other && !ordered.some((row) => row.instance === other)) ordered.push({ instance: other, label: other.displayName });
  return ordered.map(({ instance, label }) => {
    const catalog = instance.models.options.filter((option) => !option.custom);
    let cells: PickerCell[];
    if (instance.driverKind === "antigravityAgent") {
      cells = ["3.8", "3.7", "3.6", "3.5"].flatMap((version) => {
        const options = catalog.filter((option) => new RegExp(`^gemini-${version.replace(".", "\\.")}-flash-(high|medium|low)$`).test(option.id));
        return options.length ? [{ label: `Gemini ${version} Flash`, options }] : [];
      });
    } else {
      const options = instance.driverKind === "opencodeGo"
        ? freePickerModels(catalog)
        : (MODELS.get(instance.driverKind) ?? []).flatMap((id) => catalog.filter((option) => option.id === id));
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
  return levels.map((effort) => ({ id: effort, label: effort, effort }));
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
  if (instance.instanceId === previous.instanceId && previous.effort && instance.capabilities?.effortLevels?.includes(previous.effort)) {
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
    return selectPickerModel(target.instance, option.id, current);
  }
  return current;
}
