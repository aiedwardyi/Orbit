// Refreshes AA snapshots from its API or a saved response. Usage: node scripts/model-index/fetch-aa.mjs [--aa-raw file]
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { percent, readModels, readSnapshot, sortRows, sourceIds, Unverifiable, writeSnapshot } from "./lib.mjs";

export const API_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
export const BENCHMARKS = {
  "aa-intelligence-index": { field: "artificial_analysis_intelligence_index" },
  "aa-terminal-bench": { field: "terminalbench_v4_0", version: "4.0", fraction: true },
};
export const MANUAL = [
  { name: "aa-gdpval", why: "AA's LLM API has no GDPval field" },
  { name: "aa-frontiercode", why: "AA's LLM API has no FrontierCode field" },
];

export function rawFileArg(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--aa-raw" || !args[1] || args[1].startsWith("-")) throw new Error("usage: --aa-raw <file>");
  return args[1];
}

export function parseResponse(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Unverifiable("AA response is not JSON");
  }
  if (data?.status !== 200 || !Array.isArray(data.data) || data.data.length === 0) throw new Unverifiable("AA response shape changed");
  for (const row of data.data) {
    if (typeof row.id !== "string" || typeof row.slug !== "string" || typeof row.name !== "string" || !row.evaluations || typeof row.evaluations !== "object") {
      throw new Unverifiable("AA model shape changed");
    }
  }
  return data.data;
}

function places(value) {
  const [digits, exponent = "0"] = String(value).split("e");
  return Math.max(0, (digits.split(".")[1]?.length ?? 0) - Number(exponent));
}

export function buildSnapshot({ rows, models, retrievedAt, previous }) {
  const benchmark = BENCHMARKS[previous.benchmark];
  if (!benchmark) throw new Unverifiable("AA benchmark has no API field");
  if (benchmark.version && previous.version !== benchmark.version) throw new Unverifiable(`AA API supports Terminal-Bench 2.1, 4.0 and hard; snapshot version does not match ${benchmark.version}`);
  if (!rows.some((row) => Object.hasOwn(row.evaluations, benchmark.field))) throw new Unverifiable(`AA API has no ${benchmark.field} field`);
  // JSON drops a trailing zero (56.0 parses as 56), so precision comes from the whole response; past 10 places is float noise
  const precision = Math.min(10, Math.max(0, ...rows.map((row) => row.evaluations[benchmark.field]).filter(Number.isFinite).map((value) => places(benchmark.fraction ? percent(value) : value))));
  const ids = sourceIds(models, "aa");
  const out = [];
  const unmapped = [];
  const needsCost = [];
  const old = new Map(previous.rows.map((row) => [`${row.model} ${row.effort}`, row]));
  const landed = new Set();
  for (const row of rows) {
    const tier = row.slug.match(/-(low|medium|high|xhigh|max)$/)?.[1];
    const base = tier ? row.slug.slice(0, -tier.length - 1) : row.slug;
    const model = ids[row.id] ?? ids[row.slug] ?? ids[base];
    if (!model) {
      unmapped.push(row.slug);
      continue;
    }
    const value = row.evaluations[benchmark.field];
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || (benchmark.fraction && value > 1)) throw new Unverifiable("AA score is not in the expected scale");
    const named = row.name.match(/\((Low|Medium|High|Xhigh|Max)(?:,|\))/i)?.[1].toLowerCase();
    if (named && tier && named !== tier) throw new Unverifiable("AA effort disagrees between name and slug");
    const effort = named ?? tier ?? "max";
    const key = `${model} ${effort}`;
    if (landed.has(key)) throw new Unverifiable(`repeated ${key}`);
    landed.add(key);
    const score = benchmark.fraction ? percent(value) : value;
    const prev = old.get(key);
    const carried = {};
    if (prev && Number(prev.value.toFixed(precision)) === Number(score.toFixed(precision))) {
      for (const field of ["cost_per_task", "cost_benchmark", "cost_source", "interval", "harness"]) {
        if (Object.hasOwn(prev, field)) carried[field] = prev[field];
      }
    } else needsCost.push(key);
    out.push({ model, effort, value: score, ...carried, source_url: `https://artificialanalysis.ai/models/${row.slug}`, retrieved_at: retrievedAt, kind: "independent" });
  }
  if (out.length === 0) throw new Unverifiable(`no AA ${benchmark.field} score maps to a Wink model`);
  return { snapshot: { ...previous, updated: null, rows: sortRows(out, models) }, unmapped: unmapped.sort(), needsCost };
}

export async function loadResponse({ rawFile, apiKey = process.env.AA_API_KEY, keyFile = join(homedir(), ".aa", "key") } = {}) {
  if (rawFile) {
    try {
      return { rows: parseResponse(readFileSync(rawFile, "utf8")), retrievedAt: statSync(rawFile).mtime.toISOString() };
    } catch {
      throw new Unverifiable("AA saved response could not be read or parsed");
    }
  }
  let key = apiKey?.trim();
  if (!key) {
    try {
      key = readFileSync(keyFile, "utf8").trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw new Unverifiable("AA key file could not be read");
    }
  }
  if (key) {
    try {
      const response = await fetch(API_URL, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(60_000) });
      if (response.status !== 200) throw new Error();
      return { rows: parseResponse(await response.text()), retrievedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof Unverifiable) throw error;
      throw new Unverifiable("AA API request failed; snapshot untouched");
    }
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const response = await loadResponse({ rawFile: rawFileArg(process.argv.slice(2)) });
    if (!response) console.log("AA: skipped; set AA_API_KEY, save ~/.aa/key, or pass --aa-raw <file>");
    else {
      for (const name of Object.keys(BENCHMARKS)) {
        try {
          const { snapshot, needsCost } = buildSnapshot({ ...response, models: readModels(), previous: readSnapshot(name) });
          writeSnapshot(name, snapshot);
          console.log(`${name}: ${snapshot.rows.length} rows`);
          if (needsCost.length) console.log(`  needs hand check: cost: ${needsCost.join(", ")}`);
        } catch (error) {
          console.error(`${name}: UNVERIFIABLE - ${error.message}`);
          process.exitCode = 1;
        }
      }
    }
    for (const { name, why } of MANUAL) console.log(`${name}: MANUAL - ${why}`);
  } catch (error) {
    console.error(`AA: UNVERIFIABLE - ${error.message}`);
    process.exitCode = 1;
  }
}
