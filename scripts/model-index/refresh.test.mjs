import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import * as lmarena from "./fetch-lmarena.mjs";
import * as listPrices from "./fetch-list-prices.mjs";
import * as vals from "./fetch-vals.mjs";
import { percent, sourceIds, sourcesDir, Unverifiable, writeSnapshot } from "./lib.mjs";
import { diffSnapshots, refresh } from "./refresh.mjs";

const { describe, it } = process.env.NODE_TEST_CONTEXT ? await import("node:test") : await import("vitest");

const fixture = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");
const arenaRows = () => lmarena.parseRows(fixture("lmarena-webdev.json")).rows;

const models = {
  "gpt-6-astra": { provider: "openai", label: "GPT-6 Astra", sources: { vals: ["openai/gpt-6-astra"] } },
  "gemini-3.8-flash": { provider: "google", label: "Gemini 3.8 Flash", sources: { vals: ["google/gemini-3.8-flash"] } },
  "grok-4.6": { provider: "xai", label: "Grok 4.6", sources: { vals: ["grok/grok-4.6"] } },
  "claude-opus-5-5": { provider: "anthropic", label: "Claude Opus 5.5", sources: { vals: ["anthropic/claude-opus-5-5"], lmarena: ["Claude Opus 5.5"] } },
  "claude-sonnet-5-5": { provider: "anthropic", label: "Claude Sonnet 5.5", sources: { lmarena: ["Claude Sonnet 5.5"] } },
  "gpt-5.6-terra": { provider: "openai", label: "GPT-5.6 Terra", sources: { lmarena: ["GPT-5.6 Terra"] } },
  "muse-spark-1.3": {
    provider: "meta",
    label: "Muse Spark 1.3",
    sources: { vals: ["meta/muse_spark_1_3", "meta/muse_spark_1_3_max"] },
    efforts: { vals: { "meta/muse_spark_1_3": "xhigh", "meta/muse_spark_1_3_max": "max" } },
  },
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

describe("lmarena webdev", () => {
  const build = (rows = arenaRows()) => lmarena.buildSnapshot({ rows, models, retrievedAt: "2026-10-19T00:00:00.000Z", previous: { ...previous, version: null } });

  it("reads each tier as its own effort, at source precision, versioned by the publish date", () => {
    const { snapshot, unmapped } = build();
    expect([snapshot.version, snapshot.updated]).toEqual(["2026-10-18", "2026-10-18"]);
    expect(snapshot.rows.map((row) => `${row.model} ${row.effort} ${row.value}`)).toEqual([
      "claude-opus-5-5 max 1806.1951256724408",
      "claude-sonnet-5-5 high 1709.2667011267456",
      "claude-sonnet-5-5 xhigh 1767.8459284869168",
      "gpt-5.6-terra xhigh 1521.7642333914368",
    ]);
    expect(snapshot.rows.find((row) => row.model === "gpt-5.6-terra")?.harness).toBe("Codex");
    expect(snapshot.rows[0]?.source_url).toBe(lmarena.PAGE_URL);
    expect(unmapped).toEqual(["Claude Opus 4.5 (High, 32K, 20251101)", "GPT-6 Sol (Max)", "Qwen3.8-Max"]);
  });

  it("never reads GPT-6 Sol as GPT-6.1 Sol or a bare name as a tier", () => {
    expect(lmarena.splitName("GPT-6 Sol (Max)")).toEqual({ base: "GPT-6 Sol", effort: "max", harness: undefined, odd: false });
    expect(lmarena.splitName("Qwen3.8-Max")).toEqual({ base: "Qwen3.8-Max" });
  });

  it("fails on a mapped model with no readable effort, a repeat, a second date or a new column", () => {
    const rows = arenaRows();
    const opus = rows.find((row) => row.model_name === "Claude Opus 5.5 (Max)");
    expect(() => build([...rows, { ...opus, model_name: "Claude Opus 5.5" }])).toThrow(/no effort/);
    expect(() => build([...rows, { ...opus, model_name: "Claude Opus 5.5 (Max, 32K)" }])).toThrow(/no effort/);
    expect(() => build([...rows, { ...opus }])).toThrow(/repeated claude-opus-5-5 max/);
    expect(() => build([...rows, { ...opus, model_name: "Claude Opus 5.5 (High)", leaderboard_publish_date: "2026-10-11" }])).toThrow(/publish dates/);
    expect(() => build([...rows, { ...opus, model_name: "Claude Opus 5.5 (High)", category: "coding" }])).toThrow(/category/);
    const data = JSON.parse(fixture("lmarena-webdev.json"));
    data.features.push({ feature_idx: 11, name: "style_control", type: { dtype: "bool", _type: "Value" } });
    expect(() => lmarena.parseRows(JSON.stringify(data))).toThrow(Unverifiable);
    expect(() => lmarena.parseRows("<html>")).toThrow(Unverifiable);
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
    expect(() => vals.parsePage(html.replaceAll("cost_per_test", "cost"))).toThrow(/no cost per test/);
  });

  it("builds only mapped rows and refuses a new benchmark version", () => {
    const page = vals.parsePage(fixture("vals-legal-bench.html"));
    const { snapshot, unmapped } = vals.buildSnapshot({ page, models, retrievedAt: "T", previous: { ...previous, version: "1" } });
    expect(snapshot.rows.map((row) => `${row.model} ${row.value}`)).toEqual(["gemini-3.8-flash 86.993", "grok-4.6 86.307"]);
    expect(unmapped).toContain("anthropic/claude-fable-5");
    expect(() => vals.buildSnapshot({ page, models, retrievedAt: "T", previous: { ...previous, version: "2" } })).toThrow(/version/);
  });

  it("carries each row's cost per test from the same run, none where the page has null", () => {
    const page = vals.parsePage(fixture("vals-legal-bench.html"));
    expect(page.cost.get("anthropic/claude-fable-5")).toBe(0.030639);
    expect(page.cost.has("cohere/command-r")).toBe(false);
    const { snapshot } = vals.buildSnapshot({ page, models, retrievedAt: "T", previous: { ...previous, version: "1" } });
    expect(snapshot.rows.map((row) => [row.model, row.cost_per_task, row.cost_benchmark, row.cost_source])).toEqual([
      ["gemini-3.8-flash", 0.008109, "vals-legalbench", "https://www.vals.ai/benchmarks/legal_bench"],
      ["grok-4.6", 0.01457, "vals-legalbench", "https://www.vals.ai/benchmarks/legal_bench"],
    ]);
  });
});

describe("vals cyberbench page", () => {
  const page = () => vals.parsePage(fixture("vals-cyber.html"), "cyberbench");
  const build = () => vals.buildSnapshot({ page: page(), models, retrievedAt: "T", previous: { ...previous, version: "1.1" }, benchmark: "vals-cyberbench" });

  it("reads CyberBench, and LegalBench only from its own page", () => {
    expect([page().version, page().updated]).toEqual(["1.1", "2026-10-12"]);
    expect(page().accuracy.get("anthropic/claude-opus-5-5")).toBe(55.357);
    expect(() => vals.parsePage(fixture("vals-cyber.html"))).toThrow(/version and updated date/);
    expect(() => vals.parsePage(fixture("vals-legal-bench.html"), "cyberbench")).toThrow(/version and updated date/);
  });

  it("charts the plain config, never the Cyber Range one", () => {
    const { snapshot, unmapped } = build();
    expect(snapshot.rows.filter((row) => row.model === "claude-opus-5-5").map((row) => row.value)).toEqual([55.357]);
    expect(unmapped).toContain("anthropic/claude-opus-5-5-range");
  });

  it("names the effort of a model Vals runs twice and costs every row from CyberBench", () => {
    const { snapshot } = build();
    expect(snapshot.rows.map((row) => [row.model, row.effort, row.value, row.cost_per_task])).toEqual([
      ["gpt-6-astra", "all", 41.072, 1.840737],
      ["grok-4.6", "all", 67.678, 4.06856],
      ["claude-opus-5-5", "all", 55.357, 3.476604],
      ["muse-spark-1.3", "xhigh", 69.405, 4.258407],
      ["muse-spark-1.3", "max", 72.738, 3.343249],
    ]);
    for (const row of snapshot.rows) expect([row.cost_benchmark, row.cost_source, row.source_url]).toEqual(["vals-cyberbench", vals.BENCHMARKS["vals-cyberbench"].url, vals.BENCHMARKS["vals-cyberbench"].url]);
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

  it("fails when a Google promo cell lacks the full shape", () => {
    const page = (paid) => [
      "Gemini Developer API pricing",
      "gemini-9-probe",
      "Input price", "Free of charge", paid,
      "Context caching price", "Free of charge", "$0.10",
      "Output price", "Free of charge", "$1.00",
    ].join("\n");
    expect(() => listPrices.parseGoogle(page("$2.00 until November 30, 2026."), ["gemini-9-probe"])).toThrow(Unverifiable);
    expect(() => listPrices.parseGoogle(page("$2.00 through November 30, 2026; $4.00 starting December 1, 2026."), ["gemini-9-probe"])).toThrow(Unverifiable);
    expect(() => listPrices.parseGoogle(page("$2.00 through November 30, 2026."), ["gemini-9-probe"])).toThrow(Unverifiable);
  });

  it("fails when a model with no free tier has an unexpected free cell", () => {
    const page = [
      "Gemini Developer API pricing",
      "gemini-9-probe",
      "Input price", "Limited", "$2.00 through November 30, 2026. $4.00 starting December 1, 2026.",
      "Context caching price", "Not available", "$0.10 through November 30, 2026. $0.20 starting December 1, 2026.",
      "Output price", "Not available", "$10.00 through November 30, 2026. $20.00 starting December 1, 2026.",
    ].join("\n");
    expect(() => listPrices.parseGoogle(page, ["gemini-9-probe"])).toThrow(Unverifiable);
  });

  it("reads a reordered Meta sentence and a contributor-only line", () => {
    const table = "Usage Standard mode (per 1M tokens) Contributor mode (per 1M tokens) Cached input $0.15 $0.002 Input $1.25 $0.10 Output $4.25 $0.20";
    const reordered = `<p>Models: muse-spark-1.3-contributor in Contributor mode; muse-spark-1.3 in Standard mode.</p><p>${table}</p>`;
    expect(listPrices.parseMeta(reordered, ["muse-spark-1.3-contributor"])["muse-spark-1.3-contributor"]).toEqual({ input: 0.1, cachedInput: 0.002, output: 0.2 });
    expect(listPrices.parseMeta(reordered, ["muse-spark-1.3"])["muse-spark-1.3"]).toEqual({ input: 1.25, cachedInput: 0.15, output: 4.25 });
    const contribOnly = `<p>Models: muse-spark-1.3-contributor in Contributor mode.</p><p>${table}</p>`;
    expect(listPrices.parseMeta(contribOnly, ["muse-spark-1.3-contributor"])["muse-spark-1.3-contributor"]).toEqual({ input: 0.1, cachedInput: 0.002, output: 0.2 });
    expect(listPrices.parseMeta(contribOnly, ["muse-spark-1.3"])["muse-spark-1.3"]).toBeUndefined();
    const dangling = `<p>Models: muse-spark-1.3-contributor in Contributor mode; muse-spark-1.2.</p><p>${table}</p>`;
    expect(() => listPrices.parseMeta(dangling, ["muse-spark-1.2"])).toThrow(Unverifiable);
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

  it("reads Terra 6.1 from the general table when OpenAI also lists a Cyber table", () => {
    const html = fixture("openai-pricing.html").replace("gpt-5.6-terra", "gpt-6.1-terra").replace("[0,2],[0,0.2],[0,2.5],[0,12]", "[0,1],[0,0.05],[0,1.25],[0,5]");
    const cyber = fixture("openai-pricing.html").replace("&quot;tier&quot;:[0,&quot;standard&quot;],", "&quot;tier&quot;:[0,&quot;standard&quot;],&quot;modelGroup&quot;:[0,&quot;cyber&quot;],");
    expect(listPrices.parseOpenAI(html + cyber, ["gpt-6.1-terra"])["gpt-6.1-terra"]).toEqual({ input: 1, cachedInput: 0.05, output: 5 });
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
    source_url: "https://artificialanalysis.ai/models/gpt-6-astra",
    retrieved_at: "2026-10-10T00:00:00.000Z",
    kind: "independent",
  });
  const snap = (rows) => ({ benchmark: "aa-frontiercode", version: "1.1", index: "coding", label: "L", updated: null, rows });
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
    const built = runBuild({ "models.json": wink, "aa-frontiercode.json": snap([score("xhigh"), score("xhigh")]) });
    expect(built.status).not.toBe(0);
    expect(built.stderr).toMatch(/repeated aa-frontiercode gpt-6-astra xhigh/);
  });

  it("fails on an empty snapshot or a duplicate benchmark id", () => {
    const empty = runBuild({ "models.json": wink, "aa-frontiercode.json": snap([]) });
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toMatch(/aa-frontiercode: snapshot has no rows/);
    const dup = runBuild({
      "models.json": wink,
      "a.json": snap([score("xhigh")]),
      "b.json": snap([score("high")]),
    });
    expect(dup.status).not.toBe(0);
    expect(dup.stderr).toMatch(/duplicate benchmark aa-frontiercode/);
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
      const credentials = { apiKey: "", keyFile: join(tmpdir(), "wink-MODEL-REFRESH", "no-key") };
      const first = await refresh("2026-10-11", credentials);
      const second = await refresh("2026-10-11", credentials);
      expect(first.out.join("\n")).not.toMatch(/already fetched/);
      expect(second.out.join("\n")).not.toMatch(/already fetched/);
      expect(second.out.join("\n")).toMatch(/offline/);
      expect(calls).toHaveLength(8);
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
