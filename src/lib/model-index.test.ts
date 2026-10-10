import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MODEL_INDEX_AS_OF, MODEL_INDEX_ENTRIES, MODEL_INDEX_SOURCES, type ModelIndexEntry } from "../../shared/model-index-data.ts";
import { PICKER_MODEL_IDS } from "./cross-model-picker";
import {
  MODEL_INDEXES,
  chartProvider,
  fitLogTicks,
  formatCost,
  formatPrice,
  indexView,
  logTicks,
  markUniverse,
  modelShapes,
  paretoFrontier,
  scoredIndexes,
  winkCatalog,
} from "./model-index";
import type { InstanceInfo } from "@/state/store";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCORES = MODEL_INDEXES.filter((index) => index !== "cost");

function instance(driverKind: string, ids: string[]): InstanceInfo {
  return {
    instanceId: driverKind, driverKind, displayName: driverKind, snapshot: { state: "available" },
    models: { default: ids[0]!, options: ids.map((id) => ({ id, label: id })) },
  };
}

function entry(model: string, index: ModelIndexEntry["index"], score: number, effort = "high"): ModelIndexEntry {
  return {
    provider: "anthropic", model, label: model, effort, index, score, source: "https://example.com", sourceLabel: "Example",
    benchmark: "deepswe", version: "1.1", kind: "independent", retrievedAt: "2026-09-30T00:00:00Z",
  };
}

describe("model index data", () => {
  it("gives every entry a source URL, a label, and a known index", () => {
    for (const e of MODEL_INDEX_ENTRIES) {
      expect(e.source, e.model).toMatch(/^https:\/\/\S+$/);
      expect(e.sourceLabel, e.model).not.toBe("");
      expect(MODEL_INDEXES).toContain(e.index);
      expect(Number.isFinite(e.score), e.model).toBe(true);
    }
  });

  it("has no duplicate model + effort + index", () => {
    const keys = MODEL_INDEX_ENTRIES.map((e) => `${e.model}|${e.effort}|${e.index}`);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });

  it("charts only models from the picker", () => {
    const outside = MODEL_INDEX_ENTRIES.filter((e) => !PICKER_MODEL_IDS.includes(e.model)).map((e) => e.model);
    expect([...new Set(outside)]).toEqual([]);
  });

  it("keeps one benchmark per tab", () => {
    for (const index of MODEL_INDEXES.filter((index) => index !== "cost")) {
      const labels = new Set(MODEL_INDEX_ENTRIES.filter((e) => e.index === index && !e.reported).map((e) => e.sourceLabel));
      expect([...labels], index).toHaveLength(1);
    }
  });

  it("prices every picker model its vendor still lists, once, per 1M tokens, blended 7:2:1", () => {
    const cost = MODEL_INDEX_ENTRIES.filter((e) => e.index === "cost");
    expect(cost.map((e) => e.model).sort()).toEqual(PICKER_MODEL_IDS.filter((id) => id !== "gemini-3.7-flash").sort());
    for (const e of cost) {
      expect(e.effort, e.model).toBe("all");
      expect(e.price, e.model).toBeDefined();
      expect(e.score, e.model).toBeCloseTo((7 * e.price!.cachedInput + 2 * e.price!.input + e.price!.output) / 10, 10);
    }
    expect(MODEL_INDEX_ENTRIES.filter((e) => e.index !== "cost" && e.price)).toEqual([]);
  });

  it("blends Grok 4.6 at the 1.35 Artificial Analysis shows", () => {
    const grok = MODEL_INDEX_ENTRIES.find((e) => e.index === "cost" && e.model === "grok-4.6");
    expect(grok?.score).toBeCloseTo(1.35, 10);
  });

  it("keeps every cost per task under $50, so run totals cannot slip back in", () => {
    for (const e of MODEL_INDEX_ENTRIES.filter((e) => e.cost !== undefined)) expect(e.cost, `${e.model} ${e.effort} ${e.index}`).toBeLessThan(50);
  });

  it("charts DeepSWE v1.1 only on coding", () => {
    for (const e of MODEL_INDEX_ENTRIES.filter((e) => e.index === "coding")) {
      expect([e.benchmark, e.version], e.model).toEqual(["deepswe", "1.1"]);
      expect(e.sourceLabel, e.model).toMatch(/DeepSWE v1\.1/);
    }
  });

  it("scores every benchmark, so no tab is hidden", () => {
    expect(scoredIndexes()).toEqual(MODEL_INDEXES);
  });
});

describe("sourced data", () => {
  it("matches what the build script makes from the committed snapshots", () => {
    const built = execFileSync(process.execPath, [join(ROOT, "scripts/model-index/build-data.mjs"), "--print"], { encoding: "utf8" });
    expect(readFileSync(join(ROOT, "shared/model-index-data.ts"), "utf8").replace(/\r\n/g, "\n")).toBe(built);
  });

  it("names benchmark, version, source, retrieval time and kind on every row", () => {
    for (const e of MODEL_INDEX_ENTRIES) {
      const id = `${e.model} ${e.effort} ${e.index}`;
      const source = MODEL_INDEX_SOURCES[e.benchmark];
      expect(source?.index, id).toBe(e.index);
      expect(e.version, id).toBe(source?.version);
      expect(e.source, id).toMatch(/^https:\/\/\S+$/);
      expect(e.retrievedAt, id).toMatch(ISO);
      expect(Date.parse(e.retrievedAt), id).toBeLessThanOrEqual(Date.now());
      if (e.index === "cost") expect(e.kind, id).toBe("vendor");
      else {
        expect(e.kind, id).toBe("independent");
        expect(e.version, id).toMatch(/\S/);
      }
    }
  });

  it("has no lab-reported rows", () => {
    expect(MODEL_INDEX_ENTRIES.filter((e) => e.reported).map((e) => `${e.model} ${e.effort} ${e.index}`)).toEqual([]);
  });

  it("takes each point's cost from its own benchmark, never the Intelligence Index's", () => {
    const aaIndex = new Map(MODEL_INDEX_ENTRIES.filter((e) => e.index === "intelligence" && e.cost).map((e) => [`${e.model}:${e.effort}`, e.cost]));
    for (const index of SCORES) {
      for (const point of indexView(index, []).points.filter((point) => point.cost !== undefined)) {
        expect(point.costBenchmark, point.key).toBe(point.benchmark);
        expect(point.costSource, point.key).toMatch(/^https:\/\/\S+$/);
        expect(point.cost, point.key).toBeGreaterThan(0);
        if (index !== "intelligence") expect(point.cost, `${index} ${point.key}`).not.toBe(aaIndex.get(point.key));
      }
    }
  });

  it("keeps DeepSWE's 95% intervals around each score", () => {
    const coding = MODEL_INDEX_ENTRIES.filter((e) => e.index === "coding");
    expect(coding.length).toBeGreaterThan(0);
    for (const e of coding) {
      expect(e.interval, e.model).toBeDefined();
      expect(e.interval!.low, `${e.model} ${e.effort}`).toBeLessThanOrEqual(e.score);
      expect(e.interval!.high, `${e.model} ${e.effort}`).toBeGreaterThanOrEqual(e.score);
    }
  });

  it("lists every core picker model under a score or as missing on each score tab", () => {
    const catalog = PICKER_MODEL_IDS.filter((id) => !id.endsWith("-contributor")).map((model) => ({ provider: "other", model, label: model }));
    for (const index of SCORES) {
      const { points, missing } = indexView(index, catalog);
      const scored = new Set(points.map((point) => point.model));
      for (const { model } of catalog) expect(scored.has(model) !== missing.some((m) => m.model === model), `${index} ${model}`).toBe(true);
    }
  });

  it("dates each benchmark by its source and its retrieval", () => {
    const now = Date.now();
    for (const [id, source] of Object.entries(MODEL_INDEX_SOURCES)) {
      if (source.updated !== null) {
        expect(source.updated, id).toMatch(DATE);
        expect(Date.parse(source.updated), id).toBeLessThanOrEqual(now);
      }
      expect(source.retrievedAt, id).toMatch(ISO);
    }
    expect(MODEL_INDEX_SOURCES.deepswe.updated).toBe("2026-09-22");
    const newest = Math.max(...MODEL_INDEX_ENTRIES.map((e) => Date.parse(e.retrievedAt)));
    expect(MODEL_INDEX_AS_OF).toBe(new Date(newest).toISOString().slice(0, 10));
  });

  it("charts Legal as bars: one score per model, no effort, no cost", () => {
    const legal = MODEL_INDEX_ENTRIES.filter((e) => e.index === "legal");
    expect(legal.length).toBeGreaterThan(0);
    for (const e of legal) expect([e.effort, e.cost], e.model).toEqual(["all", undefined]);
  });

  it("records the Gemini 3.8 Flash promo end and the Haiku 5.5 prompt tier", () => {
    const price = (model: string) => MODEL_INDEX_ENTRIES.find((e) => e.index === "cost" && e.model === model)?.price;
    const gemini = price("gemini-3.8-flash")!;
    expect([gemini.until, gemini.next?.from]).toEqual(["2026-12-31", "2027-01-01"]);
    expect(gemini.next?.output).toBe(gemini.output * 2);
    const haiku = price("claude-haiku-5-5")!;
    expect(haiku.upToTokens).toBe(100_000);
    expect(haiku.above?.output).toBe(haiku.output * 5);
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
    const view = indexView("coding", catalog, [{ ...entry("claude-opus-5-5", "coding", 60), cost: 900 }]);
    expect(view.missing.map((m) => m.model)).toEqual(["gpt-brand-new"]);
    expect(view.points).toMatchObject([{ model: "claude-opus-5-5", cost: 900 }]);
  });

  it("drops scored models the picker does not offer", () => {
    const entries = [entry("glm-5.3", "coding", 95), entry("gemini-4-argon", "coding", 90), entry("claude-opus-5-5", "coding", 60)];
    expect(indexView("coding", [], entries).points.map((p) => p.model)).toEqual(["claude-opus-5-5"]);
    expect(markUniverse(entries).map((m) => m.model)).toEqual(["claude-opus-5-5"]);
  });

  it("plots each effort at its own cost to run, sharing one list price", () => {
    const price = { ...entry("claude-opus-5-5", "cost", 8, "all"), price: { input: 4, cachedInput: 0.2, output: 20 } };
    const entries = [
      { ...entry("claude-opus-5-5", "coding", 60, "low"), cost: 860 },
      { ...entry("claude-opus-5-5", "coding", 70, "max"), cost: 8708 },
      price,
    ];
    expect(indexView("coding", [], entries).points.map((p) => [p.effort, p.cost, p.price])).toEqual([
      ["low", 860, { input: 4, cachedInput: 0.2, output: 20 }],
      ["max", 8708, { input: 4, cachedInput: 0.2, output: 20 }],
    ]);
    expect(markUniverse(entries).map((m) => m.key)).toEqual(["claude-opus-5-5:low", "claude-opus-5-5:max", "claude-opus-5-5:all"]);
  });

  it("never borrows another benchmark's cost for a row without its own", () => {
    const entries = [{ ...entry("gemini-3.8-flash", "intelligence", 30), cost: 1.6 }, entry("gemini-3.8-flash", "agentic", 20)];
    expect(indexView("agentic", [], entries).points.map((p) => p.cost)).toEqual([undefined]);
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

  it("keeps contributor models out of the unscored list but priced", () => {
    const catalog = winkCatalog([instance("museAgent", ["muse-spark-1.3", "muse-spark-1.3-contributor"])]);
    expect(catalog.map((m) => m.model)).toEqual(["muse-spark-1.3"]);
    expect(indexView("coding", catalog, []).missing.map((m) => m.model)).toEqual(["muse-spark-1.3"]);
    expect(indexView("cost", catalog).points.map((p) => p.model)).toContain("muse-spark-1.3-contributor");
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

  it("spans the price axis in 1-2-5 steps", () => {
    expect(logTicks(0.2 / 1.6, 20 * 1.6)).toEqual([0.2, 0.5, 1, 2, 5, 10, 20]);
  });
});

describe("fit log ticks", () => {
  const width = (usd: number) => (usd >= 1000 ? `$${usd / 1000}k` : `$${usd}`).length * 6;

  it("keeps 1-2-5 when the labels fit", () => {
    expect(fitLogTicks(10, 1000, 400, width)).toEqual([10, 20, 50, 100, 200, 500, 1000]);
  });

  it("thins to 1-3 then to decades as the plot narrows", () => {
    expect(fitLogTicks(10, 1000, 160, width)).toEqual([10, 30, 100, 300, 1000]);
    expect(fitLogTicks(10, 1000, 100, width)).toEqual([10, 100, 1000]);
  });
});

describe("price format", () => {
  it("reads input / output per 1M tokens like a pricing page", () => {
    expect(formatPrice({ input: 4, cachedInput: 0.2, output: 20 })).toBe("$4 / $20");
    expect(formatPrice({ input: 0.1, cachedInput: 0.01, output: 0.5 })).toBe("$0.10 / $0.50");
    expect(formatPrice({ input: 1.25, cachedInput: 0.15, output: 4.25 })).toBe("$1.25 / $4.25");
  });
});

describe("cost per task format", () => {
  it("keeps two significant figures under a cent and two decimals above", () => {
    expect(formatCost(0.0045)).toBe("$0.0045");
    expect(formatCost(0.06782)).toBe("$0.07");
    expect(formatCost(1.859)).toBe("$1.86");
    expect(formatCost(8.746)).toBe("$8.75");
  });
});
