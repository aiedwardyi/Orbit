import type { InstanceInfo } from "@/state/store";
import {
  MODEL_INDEX_ENTRIES,
  type ModelIndexEntry,
  type ModelIndexKey,
} from "../../shared/model-index-data.ts";
import { pickerModels, pickerRows } from "./cross-model-picker";

export const MODEL_INDEXES: readonly ModelIndexKey[] = ["intelligence", "coding", "agentic", "general", "legal", "cost"];

// Only four hues pass the all-pairs colorblind check for a scatter; every
// other lab folds into the gray "other" slot and leans on shape + label.
export const CHART_PROVIDERS = ["anthropic", "openai", "google", "xai", "other"] as const;
export type ChartProvider = (typeof CHART_PROVIDERS)[number];

const DRIVER_PROVIDER: Record<string, string> = {
  claudeAgent: "anthropic",
  codex: "openai",
  antigravityAgent: "google",
  grokAgent: "xai",
  museAgent: "meta",
};

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "default"];

export interface CatalogModel {
  provider: string;
  model: string;
  label: string;
}

export interface ModelIndexPoint extends ModelIndexEntry {
  key: string;
  /** Cost to run the AA Intelligence Index at this model + effort. */
  cost?: number;
  wink: boolean;
}

export function chartProvider(provider: string): ChartProvider {
  return (CHART_PROVIDERS as readonly string[]).includes(provider) ? (provider as ChartProvider) : "other";
}

export function effortRank(effort: string): number {
  const rank = EFFORT_ORDER.indexOf(effort);
  return rank < 0 ? EFFORT_ORDER.length : rank;
}

/** The models Wink's picker offers, so a newly added model shows up with no data edits. */
export function winkCatalog(instances: InstanceInfo[]): CatalogModel[] {
  const seen = new Set<string>();
  return pickerModels(pickerRows(instances, { instanceId: "", model: "" })).flatMap(({ instance, cell }) => {
    const option = cell.options[0];
    if (!option) return [];
    const model = instance.driverKind === "antigravityAgent" ? option.id.replace(/-(high|medium|low)$/, "") : option.id;
    if (seen.has(model)) return [];
    seen.add(model);
    return [{ provider: DRIVER_PROVIDER[instance.driverKind] ?? "other", model, label: cell.label }];
  });
}

function costByKey(entries: readonly ModelIndexEntry[]): Map<string, number> {
  return new Map(entries.filter((entry) => entry.index === "cost").map((entry) => [`${entry.model}:${entry.effort}`, entry.score]));
}

export function indexView(
  index: ModelIndexKey,
  catalog: CatalogModel[],
  entries: readonly ModelIndexEntry[] = MODEL_INDEX_ENTRIES,
): { points: ModelIndexPoint[]; missing: CatalogModel[] } {
  const wink = new Set(catalog.map((model) => model.model));
  const cost = costByKey(entries);
  const points = entries
    .filter((entry) => entry.index === index)
    .map((entry) => {
      const key = `${entry.model}:${entry.effort}`;
      return { ...entry, key, cost: cost.get(key), wink: wink.has(entry.model) };
    });
  const scored = new Set(points.map((point) => point.model));
  return { points, missing: catalog.filter((model) => !scored.has(model.model)) };
}

/** Every model + effort in the data, so marks stay mounted and glide between indexes. */
export function markUniverse(
  catalog: CatalogModel[],
  entries: readonly ModelIndexEntry[] = MODEL_INDEX_ENTRIES,
): Array<Omit<ModelIndexPoint, "index" | "score" | "source" | "sourceLabel" | "date">> {
  const wink = new Set(catalog.map((model) => model.model));
  const cost = costByKey(entries);
  const marks = new Map<string, Omit<ModelIndexPoint, "index" | "score" | "source" | "sourceLabel" | "date">>();
  for (const { provider, model, label, effort } of entries) {
    const key = `${model}:${effort}`;
    if (!marks.has(key)) marks.set(key, { key, provider, model, label, effort, cost: cost.get(key), wink: wink.has(model) });
  }
  return [...marks.values()];
}

/** Round linear domain and its ticks, roughly `count` of them. */
export function linearTicks(min: number, max: number, count = 5): { domain: [number, number]; ticks: number[] } {
  if (max <= min) max = min + 1;
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = lo; value <= hi + step / 2; value += step) ticks.push(Number(value.toFixed(6)));
  return { domain: [lo, hi], ticks };
}

/** 1-2-5 ticks inside a log domain. */
export function logTicks(min: number, max: number, steps: readonly number[] = [1, 2, 5]): number[] {
  const ticks: number[] = [];
  for (let exp = Math.floor(Math.log10(min)); exp <= Math.ceil(Math.log10(max)); exp++) {
    for (const m of steps) {
      const value = m * 10 ** exp;
      if (value >= min && value <= max) ticks.push(Number(value.toPrecision(6)));
    }
  }
  return ticks.length < 3 && steps.length < 9 ? logTicks(min, max, [1, 2, 3, 4, 5, 6, 7, 8, 9]) : ticks;
}
