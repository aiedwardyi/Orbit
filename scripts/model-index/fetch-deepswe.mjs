// Refreshes shared/model-index-sources/deepswe.json from the DeepSWE v1.1 leaderboard. Usage: node scripts/model-index/fetch-deepswe.mjs
import { pathToFileURL } from "node:url";
import { get, percent, readModels, readSnapshot, saveRaw, sortRows, sourceIds, Unverifiable, writeSnapshot } from "./lib.mjs";

const JSON_URL = "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json";
const PAGE_URL = "https://deepswe.datacurve.ai/";
const TOP_KEYS = ["generated_at", "latest_job", "n_tasks_in_set", "rows", "scope", "unit"];
const ROW_KEYS = [
  "ci_attempted", "ci_half", "ci_hi", "ci_lo", "ci_method", "ci_passed", "completed_by_attempt", "config", "cost_basis", "harness", "median_agent_steps",
  "median_cache_read_tokens", "median_cache_write_tokens", "median_compute_units", "median_cost_usd", "median_duration_seconds", "median_input_tokens",
  "median_output_tokens", "median_output_tokens_to_pass", "median_peak_context_tokens", "median_reasoning_tokens", "median_uncached_input_tokens",
  "mean_agent_steps", "mean_cache_read_tokens", "mean_cache_tokens", "mean_cache_write_tokens", "mean_compute_units", "mean_cost_usd", "mean_duration_seconds",
  "mean_input_tokens", "mean_output_tokens", "mean_reasoning_tokens", "mean_uncached_input_tokens", "model", "n_attempted", "n_passed", "n_runs",
  "n_tasks_attempted", "n_tasks_passed_any", "pass_at_1", "pass_at_4", "pass_rate", "pass_rate_by_attempt", "provider", "reasoning_effort", "source",
].sort();

const REQUIRED = ["ci_hi", "ci_lo", "config", "harness", "model", "pass_at_1", "reasoning_effort"];

const sameKeys = (actual, expected) => actual.length === expected.length && [...actual].sort().every((key, i) => key === expected[i]);

/** Scores and intervals from leaderboard-live.json, keyed by config. */
export function parseLeaderboard(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Unverifiable("leaderboard-live.json is not JSON");
  }
  if (!data || !sameKeys(Object.keys(data), TOP_KEYS) || !Array.isArray(data.rows) || data.rows.length === 0) {
    throw new Unverifiable("leaderboard-live.json top-level shape changed");
  }
  const updated = String(data.generated_at).match(/^(\d{4}-\d{2}-\d{2})T/)?.[1];
  if (!updated) throw new Unverifiable("leaderboard-live.json generated_at is not a date");
  const rows = new Map();
  for (const row of data.rows) {
    const keys = Object.keys(row);
    if (REQUIRED.some((key) => !keys.includes(key)) || keys.some((key) => !ROW_KEYS.includes(key))) {
      throw new Unverifiable(`leaderboard row keys changed (${row.config ?? "?"})`);
    }
    for (const key of ["pass_at_1", "ci_lo", "ci_hi"]) {
      if (!Number.isFinite(row[key]) || row[key] < 0 || row[key] > 1) throw new Unverifiable(`${row.config}: ${key} is not a fraction`);
    }
    if (row.harness !== "mini-swe-agent") throw new Unverifiable(`${row.config}: harness ${row.harness}`);
    if (rows.has(row.config)) throw new Unverifiable(`duplicate config ${row.config}`);
    rows.set(row.config, row);
  }
  return { updated, rows };
}

/** Displayed (repriced) cost per task from the page's hydration data, keyed by config. */
export function parseHydration(html) {
  const costs = new Map();
  const chunks = html.split(/\{model:"/).slice(1);
  for (const chunk of chunks) {
    const config = chunk.match(/,config:"([^"]+)"/)?.[1];
    const cost = chunk.match(/,mean_cost_usd:(\d+(?:\.\d+)?(?:e-?\d+)?)[,}]/)?.[1];
    const passAt1 = chunk.match(/,pass_at_1:(\d+(?:\.\d+)?)[,}]/)?.[1];
    if (!config || !cost || !passAt1) continue;
    if (costs.has(config)) throw new Unverifiable(`hydration repeats ${config}`);
    costs.set(config, { cost: Number(cost), passAt1: Number(passAt1) });
  }
  if (costs.size === 0) throw new Unverifiable("no rows in the page hydration data");
  return costs;
}

export function buildSnapshot({ leaderboard, hydration, models, retrievedAt, previous }) {
  const ids = sourceIds(models, "deepswe");
  const unmapped = new Set();
  const rows = [];
  for (const [config, row] of leaderboard.rows) {
    const model = ids[row.model];
    if (!model) {
      unmapped.add(row.model);
      continue;
    }
    const shown = hydration.get(config);
    if (!shown) throw new Unverifiable(`${config}: not in the page hydration data`);
    if (shown.passAt1 !== row.pass_at_1) throw new Unverifiable(`${config}: page and JSON disagree on pass_at_1`);
    rows.push({
      model,
      effort: row.reasoning_effort,
      value: percent(row.pass_at_1),
      interval: { low: percent(row.ci_lo), high: percent(row.ci_hi) },
      cost_per_task: shown.cost,
      cost_benchmark: "deepswe",
      cost_source: PAGE_URL,
      source_url: JSON_URL,
      retrieved_at: retrievedAt,
      kind: "independent",
      harness: row.harness,
    });
  }
  if (rows.length === 0) throw new Unverifiable("no source model maps to a Wink model");
  return { snapshot: { ...previous, updated: leaderboard.updated, rows: sortRows(rows, models) }, unmapped: [...unmapped].sort() };
}

export async function fetchSnapshot() {
  const json = await get(JSON_URL);
  saveRaw("deepswe", json.text, "json");
  const page = await get(PAGE_URL);
  saveRaw("deepswe-page", page.text, "html");
  return buildSnapshot({
    leaderboard: parseLeaderboard(json.text),
    hydration: parseHydration(page.text),
    models: readModels(),
    retrievedAt: json.retrievedAt,
    previous: readSnapshot("deepswe"),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { snapshot, unmapped } = await fetchSnapshot();
    writeSnapshot("deepswe", snapshot);
    console.log(`deepswe: ${snapshot.rows.length} rows, updated ${snapshot.updated}, unmapped ${unmapped.length}`);
  } catch (error) {
    console.error(`deepswe: UNVERIFIABLE - ${error.message}`);
    process.exitCode = 1;
  }
}
