import type { ModelSelection } from "@/state/store";
import { MODEL_INDEX_ENTRIES, MODEL_INDEX_SOURCES } from "../../shared/model-index-data.ts";
import { movePicker, pickerEfforts, pickerModels, selectPickerEffort, type PickerRow } from "./cross-model-picker";
import { blendedPrice, modelIndexToday, priceOn } from "./model-index";

export type DialStat = "intelligence" | "coding";

const tierOf = (model: string) => model.match(/^gemini-.+-(high|medium|low)$/)?.[1];
const indexId = (model: string) => model.replace(/^(gemini-.+)-(high|medium|low)$/, "$1");

export function dialScore(model: string, effort: string | undefined, index: DialStat): number | undefined {
  const id = indexId(model);
  const level = tierOf(model) ?? effort;
  return MODEL_INDEX_ENTRIES.find((entry) => entry.index === index && entry.model === id && (entry.effort === "all" || entry.effort === level))?.score;
}

export function dialPrice(model: string, today = modelIndexToday()) {
  const price = MODEL_INDEX_ENTRIES.find((entry) => entry.index === "cost" && entry.model === indexId(model))?.price;
  if (!price) return undefined;
  const now = priceOn(price, today);
  return { input: now.input, output: now.output, blend: blendedPrice(now) };
}

export const dialTier = (blend: number) => blend < 0.1 ? "$" : blend < 1 ? "$$" : blend < 5 ? "$$$" : "$$$$";

export const dialSource = (index: DialStat) => Object.values(MODEL_INDEX_SOURCES)
  .find((source) => source.index === index)!.label.replace(/^Artificial Analysis /, "").replace(/\s*\(.*\)$/, "");

const intDigits = (values: number[]) => Math.max(1, ...values.map((value) => String(Math.floor(value)).length));
export const DIAL_DIGITS: Record<DialStat | "cost", number> = {
  intelligence: intDigits(MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "intelligence").map((entry) => entry.score)),
  coding: intDigits(MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "coding").map((entry) => entry.score)),
  cost: intDigits(MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "cost").map((entry) => entry.score)),
};

export function dialStep(rows: PickerRow[], current: ModelSelection, dir: number): ModelSelection {
  return movePicker(rows, current, dir < 0 ? "ArrowUp" : "ArrowDown");
}

/** Effort stops at either end; the list picker wraps. */
export function dialShift(rows: PickerRow[], current: ModelSelection, dir: number): ModelSelection {
  const item = pickerModels(rows).find((model) => model.instance.instanceId === current.instanceId && model.cell.options.some((option) => option.id === current.model));
  if (!item) return current;
  const options = pickerEfforts(item, item.cell);
  const selected = options.findIndex((option) => option.model ? option.model === current.model : option.effort === current.effort);
  const target = options[selected < 0 ? (dir > 0 ? 0 : -1) : selected + dir];
  return target ? selectPickerEffort(current, target) : current;
}

/** First model with a word starting with the typed text, in picker order. */
export function dialFind(names: readonly string[], text: string): number {
  return names.findIndex((name) => name.toLowerCase().split(/[\s-]+/).some((word) => word.startsWith(text)));
}
