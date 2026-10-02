import { describe, expect, it } from "vitest";

import { MODEL_INDEX_AS_OF, MODEL_INDEX_ENTRIES, type ModelIndexEntry } from "../../shared/model-index-data.ts";
import {
  CHART_PROVIDERS,
  MODEL_INDEXES,
  chartProvider,
  indexView,
  logTicks,
  modelShapes,
  paretoFrontier,
  scoredIndexes,
  winkCatalog,
} from "./model-index";
import type { InstanceInfo } from "@/state/store";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function instance(driverKind: string, ids: string[]): InstanceInfo {
  return {
    instanceId: driverKind, driverKind, displayName: driverKind, snapshot: { state: "available" },
    models: { default: ids[0]!, options: ids.map((id) => ({ id, label: id })) },
  };
}

function entry(model: string, index: ModelIndexEntry["index"], score: number, effort = "high"): ModelIndexEntry {
  return { provider: "anthropic", model, label: model, effort, index, score, source: "https://example.com", sourceLabel: "Example", date: "2026-09-30" };
}

describe("model index data", () => {
  it("gives every entry a source URL, a date, and a known index", () => {
    expect(MODEL_INDEX_AS_OF).toMatch(DATE);
    for (const e of MODEL_INDEX_ENTRIES) {
      expect(e.source, e.model).toMatch(/^https:\/\/\S+$/);
      expect(e.sourceLabel, e.model).not.toBe("");
      expect(e.date, e.model).toMatch(DATE);
      expect(MODEL_INDEXES).toContain(e.index);
      expect(Number.isFinite(e.score), e.model).toBe(true);
    }
  });

  it("has no duplicate model + effort + index", () => {
    const keys = MODEL_INDEX_ENTRIES.map((e) => `${e.model}|${e.effort}|${e.index}`);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });

  it("never mixes a lab's own number with an independent run of the same model", () => {
    const run = new Set(MODEL_INDEX_ENTRIES.filter((e) => !e.reported).map((e) => `${e.model}|${e.index}`));
    const lab = MODEL_INDEX_ENTRIES.filter((e) => e.reported === "lab");
    expect(lab.length).toBeGreaterThan(0);
    expect(lab.filter((e) => run.has(`${e.model}|${e.index}`))).toEqual([]);
  });

  it("names a charted lab on every lab-reported entry", () => {
    const named = CHART_PROVIDERS.filter((provider) => provider !== "other") as readonly string[];
    for (const e of MODEL_INDEX_ENTRIES.filter((e) => e.reported === "lab")) expect(named, e.model).toContain(e.provider);
  });

  it("scores every benchmark, so no tab is hidden", () => {
    expect(scoredIndexes()).toEqual(MODEL_INDEXES);
  });
});

describe("empty tabs", () => {
  it("hides a benchmark with no published scores", () => {
    expect(scoredIndexes([entry("claude-opus-5-5", "agentic", 66), entry("claude-opus-5-5", "cost", 900)])).toEqual(["agentic", "cost"]);
    expect(scoredIndexes([])).toEqual([]);
  });
});

describe("lab-reported scores", () => {
  const lab = { ...entry("claude-opus-5-5", "agentic", 66.4, "xhigh"), reported: "lab" as const };

  it("keep their flag through the view", () => {
    const view = indexView("agentic", [], [lab, entry("gpt-6-astra", "agentic", 57.9), entry("claude-opus-5-5", "cost", 4000, "xhigh")]);
    expect(view.points.map((p) => [p.model, p.reported])).toEqual([["claude-opus-5-5", "lab"], ["gpt-6-astra", undefined]]);
  });

  it("stay off the Pareto frontier", () => {
    const points = [
      { score: 40, cost: 100 },
      { score: 38, cost: 200 },
      { score: 66, cost: 300, reported: "lab" as const },
      { score: 55, cost: 900 },
      { score: 70 },
    ];
    expect(paretoFrontier(points).map((p) => p.score)).toEqual([40, 55]);
  });
});

describe("catalog merge", () => {
  it("lists a Wink model with no data as missing", () => {
    const catalog = [
      { provider: "anthropic", model: "claude-opus-5-5", label: "Opus 5.5" },
      { provider: "openai", model: "gpt-brand-new", label: "GPT Brand New" },
    ];
    const view = indexView("coding", catalog, [entry("claude-opus-5-5", "coding", 60), entry("claude-opus-5-5", "cost", 900)]);
    expect(view.missing.map((m) => m.model)).toEqual(["gpt-brand-new"]);
    expect(view.points).toMatchObject([{ model: "claude-opus-5-5", wink: true, cost: 900 }]);
  });

  it("marks scored models Wink does not offer as not yours", () => {
    const view = indexView("coding", [], [entry("someone-else", "coding", 50)]);
    expect(view.points[0]).toMatchObject({ wink: false });
    expect(view.points[0]?.cost).toBeUndefined();
  });

  it("reads models from the picker catalog, folding Gemini effort ids", () => {
    const catalog = winkCatalog([
      instance("claudeAgent", ["claude-opus-5-5"]),
      instance("antigravityAgent", ["gemini-3.8-flash-high", "gemini-3.8-flash-low"]),
    ]);
    expect(catalog.map((m) => [m.provider, m.model])).toEqual([
      ["anthropic", "claude-opus-5-5"],
      ["google", "gemini-3.8-flash"],
    ]);
  });
});

describe("model shapes", () => {
  it("gives each model in a color slot its own shape", () => {
    const shapes = modelShapes(8);
    const slots = new Map<string, Set<string>>();
    for (const e of MODEL_INDEX_ENTRIES) slots.set(chartProvider(e.provider), (slots.get(chartProvider(e.provider)) ?? new Set()).add(e.model));
    for (const models of slots.values()) {
      const used = [...models].map((model) => shapes.get(model));
      expect(new Set(used).size, [...models].join()).toBe(used.length);
    }
  });

  it("keys on the model id, not entry order", () => {
    const entries = [entry("claude-opus-5-5", "coding", 60), entry("claude-sonnet-5-5", "coding", 55), entry("claude-haiku-4-5", "coding", 40)];
    expect(modelShapes(8, [...entries].reverse())).toEqual(modelShapes(8, entries));
    expect(modelShapes(8, entries).get("claude-opus-5-5")).toBe(modelShapes(8, entries.slice(0, 1)).get("claude-opus-5-5"));
  });
});

describe("log ticks", () => {
  it("falls back to finer steps on a narrow range", () => {
    expect(logTicks(10, 1000)).toEqual([10, 20, 50, 100, 200, 500, 1000]);
    expect(logTicks(300, 900).length).toBeGreaterThanOrEqual(3);
  });
});
