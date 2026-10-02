import type { InstanceInfo } from "@/state/store";
import {
  MODEL_INDEX_ENTRIES,
  MODEL_RUN_COSTS,
  type ModelIndexEntry,
  type ModelIndexKey,
  type ModelPrice,
  type ModelRunCost,
} from "../../shared/model-index-data.ts";
import { PICKER_MODEL_IDS, pickerModels, pickerRows } from "./cross-model-picker";

export const MODEL_INDEXES: readonly ModelIndexKey[] = ["intelligence", "coding", "agentic", "general", "legal", "cost"];

// Five hues pass the all-pairs colorblind and normal-vision checks on both
// themes; every other lab folds into the gray "other" slot and leans on its label.
export const CHART_PROVIDERS = ["anthropic", "openai", "google", "xai", "meta", "other"] as const;
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
  /** List price; every effort of a model shares it. */
  price?: ModelPrice;
}

const PICKER = new Set(PICKER_MODEL_IDS);

export const formatUsd = (value: number) => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;

/** Input / output USD per 1M tokens, e.g. "$4 / $20". */
export const formatPrice = ({ input, output }: ModelPrice) => `${formatUsd(input)} / ${formatUsd(output)}`;

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
    // Contributor shares its base model's scores; only its price differs.
    if (!option || option.id.endsWith("-contributor")) return [];
    const model = instance.driverKind === "antigravityAgent" ? option.id.replace(/-(high|medium|low)$/, "") : option.id;
    if (seen.has(model)) return [];
    seen.add(model);
    return [{ provider: DRIVER_PROVIDER[instance.driverKind] ?? "other", model, label: cell.label }];
  });
}

/** Benchmarks with at least one published score; an empty one gets no tab. */
export function scoredIndexes(entries: readonly ModelIndexEntry[] = MODEL_INDEX_ENTRIES): ModelIndexKey[] {
  return MODEL_INDEXES.filter((index) => entries.some((entry) => entry.index === index));
}

/** Points no cheaper point beats, cheapest first. Lab-reported numbers stay off it. */
export function paretoFrontier<T extends Pick<ModelIndexPoint, "cost" | "score" | "reported">>(points: readonly T[]): T[] {
  const frontier: T[] = [];
  const priced = points.filter((point) => point.cost && !point.reported).sort((a, b) => a.cost! - b.cost! || b.score - a.score);
  for (const point of priced) if (!frontier.length || point.score > frontier[frontier.length - 1]!.score) frontier.push(point);
  return frontier;
}

/**
 * Shape slot per model, unique within its color slot. Hashed from the id, so a
 * new model never reshuffles the others unless it collides.
 */
export function modelShapes(slots: number, entries: readonly ModelIndexEntry[] = MODEL_INDEX_ENTRIES): Map<string, number> {
  const groups = new Map<ChartProvider, Set<string>>();
  for (const { provider, model } of entries) {
    const slot = chartProvider(provider);
    groups.set(slot, (groups.get(slot) ?? new Set()).add(model));
  }
  const out = new Map<string, number>();
  for (const models of groups.values()) {
    let taken = new Set<number>();
    for (const model of [...models].sort()) {
      if (taken.size >= slots) taken = new Set();
      let shape = ([...model].reduce((hash, ch) => Math.imul(hash ^ ch.charCodeAt(0), 16777619), 2166136261) >>> 0) % slots;
      while (taken.has(shape)) shape = (shape + 1) % slots;
      taken.add(shape);
      out.set(model, shape);
    }
  }
  return out;
}

/** Picker models only: anything else in the data never reaches the chart. */
const ours = (entries: readonly ModelIndexEntry[]) => entries.filter((entry) => PICKER.has(entry.model));

function priceByModel(entries: readonly ModelIndexEntry[]): Map<string, ModelPrice | undefined> {
  return new Map(entries.filter((entry) => entry.index === "cost").map((entry) => [entry.model, entry.price]));
}

function costByKey(costs: readonly ModelRunCost[]): Map<string, number> {
  return new Map(costs.map((cost) => [`${cost.model}:${cost.effort}`, cost.usd]));
}

export function indexView(
  index: ModelIndexKey,
  catalog: CatalogModel[],
  entries: readonly ModelIndexEntry[] = MODEL_INDEX_ENTRIES,
  costs: readonly ModelRunCost[] = MODEL_RUN_COSTS,
): { points: ModelIndexPoint[]; missing: CatalogModel[] } {
  const prices = priceByModel(ours(entries));
  const cost = costByKey(costs);
  const points = ours(entries)
    .filter((entry) => entry.index === index)
    .map((entry) => {
      const key = `${entry.model}:${entry.effort}`;
      return { ...entry, key, cost: cost.get(key), price: prices.get(entry.model) };
    });
  const scored = new Set(points.map((point) => point.model));
  return { points, missing: catalog.filter((model) => !scored.has(model.model)) };
}

/** Every model + effort in the data, so marks stay mounted and glide between indexes. */
export function markUniverse(
  entries: readonly ModelIndexEntry[] = MODEL_INDEX_ENTRIES,
  costs: readonly ModelRunCost[] = MODEL_RUN_COSTS,
): Array<Omit<ModelIndexPoint, "index" | "score" | "source" | "sourceLabel" | "date" | "reported">> {
  const prices = priceByModel(ours(entries));
  const cost = costByKey(costs);
  const marks = new Map<string, Omit<ModelIndexPoint, "index" | "score" | "source" | "sourceLabel" | "date" | "reported">>();
  for (const { provider, model, label, effort } of ours(entries)) {
    const key = `${model}:${effort}`;
    if (!marks.has(key)) marks.set(key, { key, provider, model, label, effort, cost: cost.get(key), price: prices.get(model) });
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

/** Thins log ticks (1-2-5, then 1-3, then decades) until neighbouring labels clear each other. */
export function fitLogTicks(min: number, max: number, plot: number, labelWidth: (usd: number) => number, gap = 8): number[] {
  const span = Math.log10(max / min);
  const fits = (ticks: number[]) =>
    ticks.every((tick, i) => {
      const prev = ticks[i - 1];
      return prev === undefined || (Math.log10(tick / prev) / span) * plot >= (labelWidth(prev) + labelWidth(tick)) / 2 + gap;
    });
  let ticks: number[] = [];
  for (const steps of [[1, 2, 5], [1, 3], [1]]) {
    ticks = logTicks(min, max, steps);
    if (fits(ticks)) break;
  }
  return ticks;
}
