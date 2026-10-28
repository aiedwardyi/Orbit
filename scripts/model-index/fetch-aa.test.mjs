import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { API_URL, buildSnapshot, loadResponse, MANUAL, parseResponse, rawFileArg } from "./fetch-aa.mjs";
import { Unverifiable } from "./lib.mjs";

const { describe, it } = process.env.NODE_TEST_CONTEXT ? await import("node:test") : await import("vitest");
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "aa-models.json");
const scratch = join(tmpdir(), "wink-MODEL-REFRESH");
mkdirSync(scratch, { recursive: true });
const rows = () => parseResponse(readFileSync(fixture, "utf8"));
const models = {
  "claude-opus-5-5": { sources: { aa: ["claude-opus-5-5"] } },
  "gpt-6.1-sol": { sources: { aa: ["gpt-6-1-sol"] } },
};
const previous = { benchmark: "aa-intelligence-index", version: "4.3.2", index: "intelligence", label: "Artificial Analysis Intelligence Index v4.3.2", updated: null, rows: [] };
const build = (extra = {}) => buildSnapshot({ rows: rows(), models, retrievedAt: "2026-10-28T00:00:00.000Z", previous, ...extra });

describe("AA response", () => {
  it("maps named Max, Xhigh and High rows without mixing pricing into scores", () => {
    const { snapshot, unmapped } = build();
    assert.deepEqual(snapshot.rows.map(({ model, effort, value }) => [model, effort, value]), [
      ["claude-opus-5-5", "xhigh", 55.8], ["claude-opus-5-5", "max", 62.9], ["gpt-6.1-sol", "high", 87.2],
    ]);
    assert.deepEqual(unmapped, []);
    assert.equal(snapshot.rows[0].source_url, "https://artificialanalysis.ai/models/claude-opus-5-5-xhigh");
    assert.equal(snapshot.rows[0].retrieved_at, "2026-10-28T00:00:00.000Z");
    assert.equal(snapshot.rows[0].kind, "independent");
    assert.equal(snapshot.rows[0].cost_per_task, undefined);
    assert.equal(snapshot.updated, null);
  });

  it("uses Terminal-Bench 4.0 fractions, keeps precision and skips null scores", () => {
    const { snapshot } = build({ previous: { ...previous, benchmark: "aa-terminal-bench", version: "4.0" } });
    assert.deepEqual(snapshot.rows.map(({ effort, value }) => [effort, value]), [["xhigh", 50], ["max", 71.7]]);
    assert.throws(() => build({ previous: { ...previous, benchmark: "aa-terminal-bench", version: "5.0" } }), /version/);
    assert.deepEqual(MANUAL.map(({ name }) => name), ["aa-gdpval", "aa-frontiercode"]);
  });

  it("carries auxiliary fields only when the same model and effort keep their score", () => {
    const fields = { cost_per_task: 1.25, cost_benchmark: "aa-intelligence-index", cost_source: "https://artificialanalysis.ai/models/claude-opus-5-5", interval: { low: 60, high: 65 }, harness: "Default" };
    const prior = { ...previous, rows: [
      { model: "claude-opus-5-5", effort: "max", value: 62.9, ...fields },
      { model: "claude-opus-5-5", effort: "xhigh", value: 54, ...fields },
    ] };
    const { snapshot, needsCost } = build({ previous: prior });
    const unchanged = snapshot.rows.find((row) => row.effort === "max");
    for (const [field, value] of Object.entries(fields)) assert.deepEqual(unchanged[field], value);
    for (const row of snapshot.rows.filter((row) => row !== unchanged)) {
      for (const field of Object.keys(fields)) assert.equal(Object.hasOwn(row, field), false);
    }
    assert.deepEqual(needsCost, ["claude-opus-5-5 xhigh", "gpt-6.1-sol high"]);
    const terminal = build({ previous: { ...prior, benchmark: "aa-terminal-bench", version: "4.0", rows: [{ ...prior.rows[0], value: 71.7 }] } });
    assert.deepEqual(terminal.snapshot.rows.find((row) => row.effort === "max").interval, fields.interval);
    assert.equal(terminal.snapshot.rows.find((row) => row.effort === "max").harness, "Default");
  });

  it("rejects malformed, absent, nonnumeric, duplicate and unassigned scores", () => {
    assert.throws(() => parseResponse("not json"), Unverifiable);
    assert.throws(() => parseResponse('{"status":401,"data":[]}'), Unverifiable);
    assert.throws(() => parseResponse('{"status":200,"data":[{}]}'), Unverifiable);
    assert.throws(() => build({ rows: rows().map((row) => ({ ...row, evaluations: {} })) }), /no artificial_analysis/);
    assert.throws(() => build({ rows: [rows()[0], rows()[0]] }), /repeated/);
    assert.throws(() => build({ rows: [{ ...rows()[0], evaluations: { artificial_analysis_intelligence_index: "62.9" } }] }), /scale/);
    assert.throws(() => build({ rows: [{ ...rows()[1], name: "Claude Opus 5.5 (High)" }] }), /effort/);
    assert.equal(build({ rows: [{ ...rows()[0], name: "Claude Opus 5.5" }] }).snapshot.rows[0].effort, "max");
    assert.throws(() => build({ models: {} }), /no AA/);
    const stable = build({ models: { opus: { sources: { aa: ["opus-max"] } } } });
    assert.equal(stable.snapshot.rows[0].model, "opus");
  });

  it("carries cost when the old score rounds to the API score", () => {
    const prior = { ...previous, rows: [{ model: "claude-opus-5-5", effort: "max", value: 49.6258, cost_per_task: 1.25, cost_benchmark: "aa-intelligence-index", cost_source: "https://artificialanalysis.ai/models/claude-opus-5-5" }] };
    const { snapshot, needsCost } = build({ previous: prior, rows: [{ ...rows()[0], evaluations: { artificial_analysis_intelligence_index: 49.6 } }] });
    assert.equal(snapshot.rows[0].value, 49.6);
    for (const field of ["cost_per_task", "cost_benchmark", "cost_source"]) assert.equal(snapshot.rows[0][field], prior.rows[0][field]);
    assert.deepEqual(needsCost, []);
  });

  it("leaves a real score move without cost and flags it for a hand check", () => {
    const prior = { ...previous, rows: [{ model: "claude-opus-5-5", effort: "max", value: 49.6258, cost_per_task: 1.25 }] };
    const { snapshot, needsCost } = build({ previous: prior, rows: [{ ...rows()[0], evaluations: { artificial_analysis_intelligence_index: 49.7 } }] });
    assert.equal(snapshot.rows[0].value, 49.7);
    assert.equal(Object.hasOwn(snapshot.rows[0], "cost_per_task"), false);
    assert.deepEqual(needsCost, ["claude-opus-5-5 max"]);
  });

  it("treats a whole-number API score as a move when the response carries decimals", () => {
    const prior = { ...previous, rows: [{ model: "claude-opus-5-5", effort: "max", value: 55.6, cost_per_task: 1.25 }] };
    const { snapshot, needsCost } = build({ previous: prior, rows: [{ ...rows()[0], evaluations: { artificial_analysis_intelligence_index: 56 } }, { ...rows()[1], evaluations: { artificial_analysis_intelligence_index: 51.8 } }] });
    assert.equal(Object.hasOwn(snapshot.rows.find((row) => row.effort === "max"), "cost_per_task"), false);
    assert.ok(needsCost.includes("claude-opus-5-5 max"));
  });

  it("compares Terminal-Bench at the converted fraction's precision despite float noise", () => {
    const prior = { ...previous, benchmark: "aa-terminal-bench", version: "4.0", rows: [{ model: "claude-opus-5-5", effort: "max", value: 31.313131313131297, cost_per_task: 2.07, interval: { low: 30, high: 33 }, harness: "Default" }] };
    const { snapshot, needsCost } = build({ previous: prior, rows: [{ ...rows()[0], evaluations: { terminalbench_v4_0: 0.313131313131313 } }] });
    assert.equal(snapshot.rows[0].value, 31.3131313131313);
    for (const field of ["cost_per_task", "interval", "harness"]) assert.deepEqual(snapshot.rows[0][field], prior.rows[0][field]);
    assert.deepEqual(needsCost, []);
  });
});

describe("AA input", () => {
  it("validates --aa-raw before fetching any source", () => {
    assert.equal(rawFileArg([]), undefined);
    assert.equal(rawFileArg(["--aa-raw", fixture]), fixture);
    for (const args of [["--aa-raw"], ["--aa-raw", "--other"], ["--typo"]]) assert.throws(() => rawFileArg(args), /usage/);
  });

  it("skips without credentials and dates a saved response by its file timestamp", async () => {
    const options = { apiKey: "", keyFile: join(tmpdir(), "wink-MODEL-REFRESH", "no-key") };
    assert.equal(await loadResponse(options), null);
    const saved = await loadResponse({ ...options, rawFile: fixture });
    assert.deepEqual(saved.rows, rows());
    assert.equal(saved.retrievedAt, statSync(fixture).mtime.toISOString());
  });

  it("prefers the environment key, then the trimmed file key, and redacts failures", async () => {
    const dir = mkdtempSync(join(scratch, "aa-"));
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "  file-secret\n");
    const original = globalThis.fetch;
    const keys = [];
    globalThis.fetch = async (url, options) => {
      assert.equal(url, API_URL);
      keys.push(options.headers["x-api-key"]);
      return { status: 200, text: async () => readFileSync(fixture, "utf8") };
    };
    try {
      await loadResponse({ apiKey: " env-secret ", keyFile, rawFile: "missing" });
      await loadResponse({ apiKey: "", keyFile });
      assert.deepEqual(keys, ["env-secret", "file-secret"]);
      globalThis.fetch = async () => { throw new Error("env-secret"); };
      await assert.rejects(loadResponse({ apiKey: "env-secret", keyFile }), (error) => !error.message.includes("env-secret") && /request failed/.test(error.message));
      globalThis.fetch = async () => ({ status: 401, text: async () => "env-secret" });
      await assert.rejects(loadResponse({ apiKey: "env-secret", keyFile }), /request failed/);
    } finally {
      globalThis.fetch = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AA refresh integration", () => {
  it("refreshes all fetched sources and both API charts together, leaving manual charts intact", () => {
    const dir = mkdtempSync(join(scratch, "refresh-"));
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    try {
      cpSync(join(root, "scripts/model-index"), join(dir, "scripts/model-index"), { recursive: true });
      cpSync(join(root, "shared/model-index-sources"), join(dir, "shared/model-index-sources"), { recursive: true });
      const stub = pathToFileURL(join(dir, "offline.mjs"));
      writeFileSync(stub, `
        import { readFileSync } from "node:fs";
        const fixture = (name) => readFileSync(new URL("./scripts/model-index/fixtures/" + name, import.meta.url), "utf8");
        const pages = { "platform.claude.com": "anthropic", "ai.google.dev": "google", "dev.meta.ai": "meta", "developers.openai.com": "openai", "docs.x.ai": "xai" };
        globalThis.fetch = async (url) => {
          const parsed = new URL(url);
          if (parsed.hostname === "artificialanalysis.ai") throw new Error("unexpected live API call");
          if (parsed.hostname === "ai.google.dev" && parsed.searchParams.get("hl") !== "en") throw new Error("missing English locale");
          const file = pages[parsed.hostname] ? pages[parsed.hostname] + "-pricing.html"
            : parsed.hostname === "datasets-server.huggingface.co" ? "lmarena-webdev.json"
            : parsed.pathname.endsWith("legal_bench") ? "vals-legal-bench.html" : "vals-cyber.html";
          return { status: 200, text: async () => fixture(file) };
        };
      `);
      const env = { ...process.env, AA_API_KEY: "", USERPROFILE: dir, HOME: dir };
      const script = join(dir, "scripts/model-index/refresh.mjs");
      const run = spawnSync(process.execPath, ["--import", stub.href, script, "--aa-raw", fixture], { encoding: "utf8", env });
      assert.equal(run.status, 2, run.stderr + run.stdout);
      for (const name of ["lmarena-webdev", "vals-legalbench", "vals-cyberbench", "list-prices", "aa-intelligence-index", "aa-terminal-bench"]) assert.match(run.stdout, new RegExp(`${name}: (CHANGED|no change)`));
      for (const name of ["aa-gdpval", "aa-frontiercode"]) {
        assert.match(run.stdout, new RegExp(`${name}: MANUAL`));
        assert.equal(readFileSync(join(dir, "shared/model-index-sources", name + ".json"), "utf8"), readFileSync(join(root, "shared/model-index-sources", name + ".json"), "utf8"));
      }
      const intelligence = JSON.parse(readFileSync(join(dir, "shared/model-index-sources/aa-intelligence-index.json")));
      assert.equal(intelligence.rows.length, 3);
      assert.match(run.stdout, /needs hand check: cost:/);
      assert(intelligence.rows.every((row) => row.source_url.startsWith("https://artificialanalysis.ai/models/")));
      assert.match(readFileSync(join(dir, "shared/model-index-data.ts"), "utf8"), /score: 62.9/);
      const skipped = spawnSync(process.execPath, ["--import", stub.href, script], { encoding: "utf8", env });
      assert.equal(skipped.status, 0, skipped.stderr + skipped.stdout);
      assert.match(skipped.stdout, /AA: skipped/);
      const bad = spawnSync(process.execPath, ["--import", stub.href, script, "--aa-raw", "--typo"], { encoding: "utf8", env });
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /usage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
