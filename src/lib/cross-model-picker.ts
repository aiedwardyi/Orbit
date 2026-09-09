import type { InstanceInfo, ModelSelection } from "@/state/store";

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
  claudeAgent: ["claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-fable-5-1"],
  codex: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  grokAgent: ["grok-4.6", "grok-4.5"],
}));

export function freePickerModels(catalog: ModelOption[]): ModelOption[] {
  const free = catalog.filter((option) => option.id.startsWith("openrouter/") && option.id.endsWith(":free"));
  const families = [/nemotron.*3.*ultra/i, /laguna-s-2[.-]1/i, /nemotron.*3[.-]5.*lightning/i, /ling-3[.-]0-flash-fin/i];
  const preferred = families.flatMap((family) => free.filter((option) => family.test(option.id)).slice(0, 1));
  return [...preferred, ...free.filter((option) => !preferred.includes(option))].slice(0, 4);
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

export function centeredItems<T>(items: T[], index: number): T[] {
  const start = (index - Math.floor(items.length / 2) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

export function selectPickerModel(instance: InstanceInfo, model: string, previous: ModelSelection): ModelSelection {
  if (previous.instanceId === instance.instanceId && previous.model === model) return previous;
  const next: ModelSelection = { instanceId: instance.instanceId, model, mode: "pinned" };
  if (instance.instanceId === previous.instanceId && previous.effort && instance.capabilities?.effortLevels?.includes(previous.effort)) {
    next.effort = previous.effort;
  }
  return next;
}

export function movePicker(rows: PickerRow[], current: ModelSelection, key: string): ModelSelection {
  const rowIndex = rows.findIndex((row) => row.instance.instanceId === current.instanceId);
  const row = rows[rowIndex];
  if (!row) return current;
  const column = pickerColumn(row, current.model);
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const cell = row.cells[(column + (key === "ArrowLeft" ? -1 : 1) + row.cells.length) % row.cells.length];
    return cell ? selectPickerModel(row.instance, cell.options[0]!.id, current) : current;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    const target = rows[(rowIndex + (key === "ArrowUp" ? -1 : 1) + rows.length) % rows.length];
    const cell = target?.cells[Math.min(column, target.cells.length - 1)];
    return target && cell ? selectPickerModel(target.instance, cell.options[0]!.id, current) : current;
  }
  return current;
}
