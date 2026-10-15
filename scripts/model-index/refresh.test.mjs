import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as deepswe from "./fetch-deepswe.mjs";
import * as listPrices from "./fetch-list-prices.mjs";
import * as vals from "./fetch-vals.mjs";
import { percent, sourceIds, sourcesDir, Unverifiable, writeSnapshot } from "./lib.mjs";
import { diffSnapshots, refresh } from "./refresh.mjs";

const fixture = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");
const leaderboard = () => JSON.parse(fixture("deepswe-leaderboard.json"));

const models = {
  "gpt-6-astra": { provider: "openai", label: "GPT-6 Astra", sources: { deepswe: ["gpt-6-astra"], vals: ["openai/gpt-6-astra"] } },
  "gemini-3.8-flash": { provider: "google", label: "Gemini 3.8 Flash", sources: { deepswe: ["gemini-3-8-flash"], vals: ["google/gemini-3.8-flash"] } },
  "grok-4.6": { provider: "xai", label: "Grok 4.6", sources: { deepswe: ["grok-4-6"], vals: ["grok/grok-4.6"] } },
};
const previous = { benchmark: "x", version: "1.1", index: "coding", label: "L", updated: null, rows: [] };

describe("percent", () => {
  it("moves the decimal point without float noise", () => {
    expect(percent(0.7411504424778761)).toBe(74.11504424778761);
    expect(percent(0.05)).toBe(5);
    expect(percent(0.5)).toBe(50);
    expect(percent(1)).toBe(100);
  });

  it("rejects exponent notation", () => {
    expect(() => percent(1e-7)).toThrow(Unverifiable);
  });
});

describe("sourceIds", () => {
  it("refuses one source id mapped to two Wink models", () => {
    const clash = { a: { sources: { vals: ["x/y"] } }, b: { sources: { vals: ["x/y"] } } };
    expect(() => sourceIds(clash, "vals")).toThrow(/maps to both/);
  });
});

describe("deepswe leaderboard", () => {
  it("reads scores, intervals and the source date", () => {
    const { updated, rows } = deepswe.parseLeaderboard(fixture("deepswe-leaderboard.json"));
    expect(updated).toBe("2026-09-22");
    expect(rows.get("mini_swe_agent_gpt_6_astra_xhigh").pass_at_1).toBe(0.7411504424778761);
  });

  it("fails on a missing field, a new field, a new top-level key or non-JSON", () => {
    const parse = (data) => deepswe.parseLeaderboard(JSON.stringify(data));
    const missing = leaderboard();
    delete missing.rows[0].ci_lo;
    expect(() => parse(missing)).toThrow(Unverifiable);
    const extra = leaderboard();
    extra.rows[0].pass_at_8 = 0.9;
    expect(() => parse(extra)).toThrow(Unverifiable);
    const top = leaderboard();
    top.version = "1.2";
    expect(() => parse(top)).toThrow(Unverifiable);
    expect(() => deepswe.parseLeaderboard("<html>")).toThrow(Unverifiable);
  });

  it("fails when a score is not a fraction or the harness changes", () => {
    const percentScore = leaderboard();
    percentScore.rows[0].pass_at_1 = 74.1;
    expect(() => deepswe.parseLeaderboard(JSON.stringify(percentScore))).toThrow(Unverifiable);
    const harness = leaderboard();
    harness.rows[0].harness = "other-agent";
    expect(() => deepswe.parseLeaderboard(JSON.stringify(harness))).toThrow(Unverifiable);
  });
});

describe("deepswe page", () => {
  it("reads the displayed cost from the hydration data", () => {
    const costs = deepswe.parseHydration(fixture("deepswe-page.html"));
    expect(costs.get("mini_swe_agent_gpt_6_astra_xhigh")).toEqual({ cost: 4.429117203539823, passAt1: 0.7411504424778761 });
  });

  it("fails when no row is found", () => {
    expect(() => deepswe.parseHydration("<script>{rows:[]}</script>")).toThrow(Unverifiable);
  });
});

describe("deepswe snapshot", () => {
  const build = (overrides = {}) =>
    deepswe.buildSnapshot({
      leaderboard: deepswe.parseLeaderboard(fixture("deepswe-leaderboard.json")),
      hydration: deepswe.parseHydration(fixture("deepswe-page.html")),
      models,
      retrievedAt: "2026-10-10T00:00:00.000Z",
      previous,
      ...overrides,
    });

  it("keeps the shape: percent scores, interval, displayed cost, harness", () => {
    const { snapshot } = build();
    expect(snapshot.updated).toBe("2026-09-22");
    expect(snapshot.rows.map((row) => `${row.model} ${row.effort}`)).toEqual(["gpt-6-astra xhigh", "gemini-3.8-flash high"]);
    const expected = JSON.parse('{"model":"gpt-6-astra","effort":"xhigh","value":74.11504424778761,"interval":{"low":71.24964807371247,"high":76.98044042186275},"cost_per_task":4.429117203539823,"cost_benchmark":"deepswe","cost_source":"https://deepswe.datacurve.ai/","source_url":"https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json","retrieved_at":"2026-10-10T00:00:00.000Z","kind":"independent","harness":"mini-swe-agent"}');
    expect(JSON.stringify(snapshot.rows.find((row) => row.model === "gpt-6-astra"))).toBe(JSON.stringify(expected));
  });

  it("lists unmapped source models and never guesses a row for them", () => {
    const { snapshot, unmapped } = build();
    expect(unmapped).toEqual(["claude-opus-5"]);
    expect(snapshot.rows.some((row) => row.model.includes("opus"))).toBe(false);
  });

  it("fails when the page lacks a config or disagrees with the JSON", () => {
    const hydration = deepswe.parseHydration(fixture("deepswe-page.html"));
    hydration.delete("mini_swe_agent_gpt_6_astra_xhigh");
    expect(() => build({ hydration })).toThrow(/not in the page/);
    const skewed = deepswe.parseHydration(fixture("deepswe-page.html"));
    skewed.get("mini_swe_agent_gpt_6_astra_xhigh").passAt1 = 0.5;
    expect(() => build({ hydration: skewed })).toThrow(/disagree/);
  });
});

describe("vals page", () => {
  it("reads version, date and overall accuracy at source precision", () => {
    const page = vals.parsePage(fixture("vals-legal-bench.html"));
    expect(page.version).toBe("1");
    expect(page.updated).toBe("2026-10-01");
    expect(page.accuracy.get("anthropic/claude-fable-5")).toBe(88.561);
  });

  it("fails when the metadata, the table or an accuracy goes missing", () => {
    const html = fixture("vals-legal-bench.html");
    expect(() => vals.parsePage(html.replace("legal_bench&quot;],&quot;family", "legal&quot;],&quot;family"))).toThrow(Unverifiable);
    expect(() => vals.parsePage(html.replace("overall", "all"))).toThrow(Unverifiable);
    expect(() => vals.parsePage(html.replace("accuracy&quot;:[0,88.561]", "accuracy&quot;:[0,null]"))).toThrow(Unverifiable);
  });

  it("builds only mapped rows and refuses a new benchmark version", () => {
    const page = vals.parsePage(fixture("vals-legal-bench.html"));
    const { snapshot, unmapped } = vals.buildSnapshot({ page, models, retrievedAt: "T", previous: { ...previous, version: "1" } });
    expect(snapshot.rows.map((row) => `${row.model} ${row.value}`)).toEqual(["gemini-3.8-flash 86.993", "grok-4.6 86.307"]);
    expect(unmapped).toContain("anthropic/claude-fable-5");
    expect(() => vals.buildSnapshot({ page, models, retrievedAt: "T", previous: { ...previous, version: "2" } })).toThrow(/version/);
  });
});

describe("list price parsers", () => {
  it("reads Anthropic rates, the Haiku prompt tier, and leaves out a model the page does not list", () => {
    const prices = listPrices.parseAnthropic(fixture("anthropic-pricing.html"), ["Claude Fable 5", "Claude Fable 5.1", "Claude Haiku 5.5", "Claude Nova 9"]);
    expect(prices["Claude Fable 5"]).toEqual({ input: 10, cachedInput: 1, output: 50 });
    expect(prices["Claude Fable 5.1"]).toEqual({ input: 10, cachedInput: 0.25, output: 50 });
    expect(prices["Claude Haiku 5.5"]).toEqual({ input: 0.1, cachedInput: 0.01, output: 0.5, upToTokens: 100000, above: { input: 0.5, cachedInput: 0.05, output: 2.5 } });
    expect(prices["Claude Nova 9"]).toBeUndefined();
  });

  it("fails on an Anthropic header or cell change", () => {
    const html = fixture("anthropic-pricing.html");
    expect(() => listPrices.parseAnthropic(html.replace("Hits and refreshes", "Cache reads"), ["Claude Fable 5.1"])).toThrow(Unverifiable);
    expect(() => listPrices.parseAnthropic(html.replace("<button>$0.25</button> <span>/ MTok</span>", ""), ["Claude Fable 5.1"])).toThrow(Unverifiable);
  });

  it("reads the Gemini promo end and next price, and skips a model the page dropped", () => {
    const prices = listPrices.parseGoogle(fixture("google-pricing.html"), ["gemini-3.8-flash", "gemini-3.7-flash"]);
    expect(prices["gemini-3.8-flash"]).toEqual({
      input: 0.75,
      cachedInput: 0.075,
      output: 3.75,
      until: "2026-12-31",
      next: { from: "2027-01-01", input: 1.5, cachedInput: 0.15, output: 7.5 },
    });
    expect(prices["gemini-3.7-flash"]).toBeUndefined();
  });

  it("reads a model with no Free tier from its Standard paid column", () => {
    const prices = listPrices.parseGoogle(fixture("google-pricing.html"), ["gemini-4-argon"]);
    expect(prices["gemini-4-argon"]).toEqual({
      input: 2,
      cachedInput: 0.1,
      output: 10,
      until: "2026-11-30",
      next: { from: "2026-12-01", input: 4, cachedInput: 0.2, output: 20 },
    });
  });

  it("fails on a Google price line or heading change", () => {
    const html = fixture("google-pricing.html");
    expect(() => listPrices.parseGoogle(html.replace(/Free of charge/g, "Free"), ["gemini-3.8-flash"])).toThrow(Unverifiable);
    expect(() => listPrices.parseGoogle(html.replace("Gemini Developer API pricing", "Pricing"), ["gemini-3.8-flash"])).toThrow(Unverifiable);
    expect(() => listPrices.parseGoogle(html.replace("starting January 1, 2027", "from soon"), ["gemini-3.8-flash"])).toThrow(Unverifiable);
  });

  it("reads Meta tiers by the models each lists", () => {
    const prices = listPrices.parseMeta(fixture("meta-pricing.html"), ["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-wonder-1.0"]);
    expect(prices["muse-spark-1.3"]).toEqual({ input: 1.25, cachedInput: 0.15, output: 4.25 });
    expect(prices["muse-spark-1.3-contributor"]).toEqual({ input: 0.1, cachedInput: 0.002, output: 0.2 });
    expect(prices["muse-wonder-1.0"]).toEqual({ input: 4, cachedInput: 0.2, output: 20 });
  });

  it("fails when Meta's price table changes", () => {
    expect(() => listPrices.parseMeta(fixture("meta-pricing.html").replaceAll("Usage", "Use"), ["muse-spark-1.3"])).toThrow(Unverifiable);
  });

  it("fails when a malformed Meta tier is followed by the next tier's prices", () => {
    const table = "Usage Standard mode (per 1M tokens) Contributor mode (per 1M tokens) Cached input $0.002 $0.001 Input $0.10 $0.05 Output $0.20 $0.10";
    const html = `<p>Models: muse-spark-1.3 in Standard mode.</p><p>broken tier</p><p>Models: muse-spark-9 in Standard mode.</p><p>${table}</p>`;
    expect(() => listPrices.parseMeta(html, ["muse-spark-1.3"])).toThrow(/Meta muse-spark-1.3: row shape changed/);
    expect(listPrices.parseMeta(html, ["muse-spark-9"])["muse-spark-9"]).toEqual({ input: 0.1, cachedInput: 0.002, output: 0.2 });
  });

  it("reads OpenAI standard short-context rates", () => {
    const prices = listPrices.parseOpenAI(fixture("openai-pricing.html"), ["gpt-6-astra", "gpt-5.6-terra", "gpt-9"]);
    expect(prices["gpt-6-astra"]).toEqual({ input: 10, cachedInput: 1, output: 50 });
    expect(prices["gpt-5.6-terra"]).toEqual({ input: 2, cachedInput: 0.2, output: 12 });
    expect(prices["gpt-9"]).toBeUndefined();
  });

  it("fails when OpenAI's tier or a row's shape changes", () => {
    const html = fixture("openai-pricing.html");
    expect(() => listPrices.parseOpenAI(html.replace("standard", "default"), ["gpt-6-astra"])).toThrow(Unverifiable);
    expect(() => listPrices.parseOpenAI(html.replace("[0,50]", "[0,50],[0,60]"), ["gpt-6-astra"])).toThrow(Unverifiable);
  });

  it("reads xAI short-context rates", () => {
    const prices = listPrices.parseXai(fixture("xai-pricing.html"), ["grok-4.6", "grok-5"]);
    expect(prices["grok-4.6"]).toEqual({ input: 2, cachedInput: 0.5, output: 6 });
    expect(prices["grok-5"]).toBeUndefined();
  });

  it("fails when xAI's column header changes", () => {
    expect(() => listPrices.parseXai(fixture("xai-pricing.html").replace("Short context", "Standard"), ["grok-4.6"])).toThrow(Unverifiable);
  });
});

describe("diffSnapshots", () => {
  const row = (model, value, extra = {}) => ({ model, effort: "high", value, retrieved_at: "a", ...extra });

  it("reports new, dropped and changed rows at source precision, and ignores retrieved_at", () => {
    const before = { updated: "2026-09-22", rows: [row("a", 60.123), row("b", 50), row("c", 40)] };
    const after = { updated: "2026-10-01", rows: [{ ...row("a", 60.125), retrieved_at: "z" }, row("c", 40), row("d", 30)] };
    const diff = diffSnapshots(before, after);
    expect(diff.added).toEqual(["d high"]);
    expect(diff.dropped).toEqual(["b high"]);
    expect(diff.changed).toEqual(["a high: value 60.123 -> 60.125"]);
    expect(diff.dateChanged).toBe(true);
  });

  it("reports no change when only retrieved_at moved", () => {
    const before = { updated: null, rows: [row("a", 1)] };
    const after = { updated: null, rows: [{ ...row("a", 1), retrieved_at: "later" }] };
    expect(diffSnapshots(before, after).any).toBe(false);
  });
});

describe("listed rows that no longer parse", () => {
  it("fails when a listed xAI or Meta row no longer parses", () => {
    const xai = fixture("xai-pricing.html").replace("<a>grok-4.6</a><div>Long context", "<a>grok-4.6</a><div>Extended");
    expect(() => listPrices.parseXai(xai, ["grok-4.6"])).toThrow(Unverifiable);
    expect(listPrices.parseXai(xai, ["grok-5"])["grok-5"]).toBeUndefined();
    const meta = fixture("meta-pricing.html").replace("$0.002", "n/a");
    expect(() => listPrices.parseMeta(meta, ["muse-spark-1.3-contributor"])).toThrow(Unverifiable);
    expect(() => listPrices.parseMeta(meta, ["muse-spark-1.3"])).toThrow(Unverifiable);
    expect(listPrices.parseMeta(meta, ["muse-spark-9"])["muse-spark-9"]).toBeUndefined();
  });
});

describe("repeated rows", () => {
  const wink = { "gpt-6-astra": { provider: "openai", label: "GPT-6 Astra" } };
  const score = (effort) => ({
    model: "gpt-6-astra",
    effort,
    value: 74,
    source_url: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json",
    retrieved_at: "2026-10-10T00:00:00.000Z",
    kind: "independent",
  });
  const snap = (rows) => ({ benchmark: "deepswe", version: "1.1", index: "coding", label: "L", updated: "2026-09-22", rows });
  const runBuild = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "mi-build-"));
    try {
      for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
      return spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "build-data.mjs"), "--dir", dir, "--print"], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("fails when a model and effort is repeated", () => {
    const leaderboard = deepswe.parseLeaderboard(fixture("deepswe-leaderboard.json"));
    const row = leaderboard.rows.get("mini_swe_agent_gpt_6_astra_xhigh");
    leaderboard.rows.set("mini_swe_agent_gpt_6_astra_xhigh_rerun", { ...row, config: "mini_swe_agent_gpt_6_astra_xhigh_rerun" });
    const hydration = deepswe.parseHydration(fixture("deepswe-page.html"));
    hydration.set("mini_swe_agent_gpt_6_astra_xhigh_rerun", hydration.get("mini_swe_agent_gpt_6_astra_xhigh"));
    expect(() => deepswe.buildSnapshot({ leaderboard, hydration, models, retrievedAt: "T", previous })).toThrow(/repeated gpt-6-astra xhigh/);
    const built = runBuild({ "models.json": wink, "deepswe.json": snap([score("xhigh"), score("xhigh")]) });
    expect(built.status).not.toBe(0);
    expect(built.stderr).toMatch(/repeated deepswe gpt-6-astra xhigh/);
  });

  it("fails on an empty snapshot or a duplicate benchmark id", () => {
    const empty = runBuild({ "models.json": wink, "deepswe.json": snap([]) });
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toMatch(/deepswe: snapshot has no rows/);
    const dup = runBuild({
      "models.json": wink,
      "a.json": snap([score("xhigh")]),
      "b.json": snap([score("high")]),
    });
    expect(dup.status).not.toBe(0);
    expect(dup.stderr).toMatch(/duplicate benchmark deepswe/);
  });

  it("names the benchmark and model when a price URL has no vendor", () => {
    const built = runBuild({
      "models.json": { "grok-4.6": { provider: "xai", label: "Grok 4.6" } },
      "list-prices.json": {
        benchmark: "list-prices",
        version: null,
        index: "cost",
        label: "List price",
        updated: null,
        rows: [{
          model: "grok-4.6",
          effort: "all",
          price: { input: 2, cachedInput: 0.5, output: 6 },
          source_url: "https://example.com/pricing",
          retrieved_at: "2026-10-10T00:00:00.000Z",
          kind: "vendor",
        }],
      },
    });
    expect(built.status).not.toBe(0);
    expect(built.stderr).toMatch(/list-prices grok-4.6: no vendor name for https:\/\/example.com\/pricing/);
  });
});

describe("refresh run state", () => {
  it("fetches again on a second refresh() in one process", async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      throw new Error("offline");
    };
    try {
      const first = await refresh("2026-10-11");
      const second = await refresh("2026-10-11");
      expect(first.out.join("\n")).not.toMatch(/already fetched/);
      expect(second.out.join("\n")).not.toMatch(/already fetched/);
      expect(second.out.join("\n")).toMatch(/offline/);
      expect(calls).toHaveLength(6);
    } finally {
      globalThis.fetch = original;
      const { beginRun } = await import("./lib.mjs");
      if (typeof beginRun === "function") beginRun();
    }
  });

  it("writes a snapshot via a temp file in the same folder, then renames it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mi-snap-"));
    // A writeSnapshot that ignores its dir argument writes to the real sources folder
    const stray = join(sourcesDir, "probe-guards.json");
    const strayExisted = existsSync(stray);
    try {
      writeSnapshot("probe-guards", { ok: true }, dir);
      expect(JSON.parse(readFileSync(join(dir, "probe-guards.json"), "utf8"))).toEqual({ ok: true });
      expect(readdirSync(dir)).toEqual(["probe-guards.json"]);
      rmSync(join(dir, "probe-guards.json"));
      mkdirSync(join(dir, "probe-guards.json"));
      expect(() => writeSnapshot("probe-guards", { ok: true }, dir)).toThrow();
      expect(readdirSync(dir).some((name) => /^\.probe-guards\.\d+\.tmp$/.test(name))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (!strayExisted) rmSync(stray, { force: true });
    }
  });

  it("reports a build-data spawn error when stderr is empty", async () => {
    const { formatBuildFailure } = await import("./refresh.mjs");
    expect(formatBuildFailure({ status: 1, error: { message: "spawn ENOENT" }, stderr: null })).toBe("build-data: FAILED - spawn ENOENT");
    expect(formatBuildFailure({ status: 1, error: null, stderr: "boom\n" })).toBe("build-data: FAILED - boom");
  });
});

describe("build-data cli", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "build-data.mjs");

  it("imports when node was started without a script path", () => {
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(script).href)})`], { encoding: "utf8" });
    expect(imported.status, imported.stderr).toBe(0);
  });

  it("rejects an option where --dir expects a folder", () => {
    const ran = spawnSync(process.execPath, [script, "--dir", "--print"], { encoding: "utf8" });
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toMatch(/--dir needs a folder/);
  });
});
