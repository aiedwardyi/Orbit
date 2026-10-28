// Refreshes shared/model-index-sources/lmarena-webdev.json from LMArena's CC BY 4.0 leaderboard dataset on Hugging Face. Usage: node scripts/model-index/fetch-lmarena.mjs
import { pathToFileURL } from "node:url";
import { get, readModels, readSnapshot, saveRaw, sortRows, sourceIds, Unverifiable, writeSnapshot } from "./lib.mjs";

const API_URL = "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=webdev&split=latest";
export const PAGE_URL = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/viewer/webdev/latest";
const PAGE_SIZE = 100;
const FEATURES = ["category", "leaderboard_publish_date", "license", "model_name", "organization", "rank", "rating", "rating_lower", "rating_upper", "variance", "vote_count"];
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Rows and total from one page of the datasets-server filter response. */
export function parseRows(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Unverifiable("datasets-server response is not JSON");
  }
  const names = data?.features?.map((feature) => feature.name).sort();
  if (!Array.isArray(data?.rows) || !Number.isInteger(data.num_rows_total) || names?.join() !== FEATURES.join()) {
    throw new Unverifiable("LMArena webdev dataset shape changed");
  }
  return { total: data.num_rows_total, rows: data.rows.map((entry) => entry.row) };
}

/** "Claude Opus 5.5 (Max)" or "GPT-5.6 Terra (xHigh, Codex Harness)" to its base name, effort and harness. */
export function splitName(name) {
  const m = name.match(/^(.+?) \(([^()]+)\)$/);
  if (!m) return { base: name };
  const [tier, ...rest] = m[2].split(", ");
  const effort = tier.toLowerCase();
  const harness = rest.length === 1 ? rest[0].match(/^(.+) Harness$/)?.[1] : undefined;
  return { base: m[1], effort: EFFORTS.has(effort) ? effort : undefined, harness, odd: rest.length > 0 && !harness };
}

export function buildSnapshot({ rows, models, retrievedAt, previous }) {
  const dates = new Set(rows.map((row) => row.leaderboard_publish_date));
  if (dates.size !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test([...dates][0])) throw new Unverifiable(`publish dates ${[...dates].join(", ")}`);
  const ids = sourceIds(models, "lmarena");
  const unmapped = [];
  const out = [];
  const landed = new Set();
  for (const row of rows) {
    if (row.category !== "overall") throw new Unverifiable(`${row.model_name}: category ${row.category}`);
    const { base, effort, harness, odd } = splitName(row.model_name);
    const model = ids[base];
    if (!model) {
      unmapped.push(row.model_name);
      continue;
    }
    if (!effort || odd) throw new Unverifiable(`${row.model_name}: no effort Wink can read`);
    if (!Number.isFinite(row.rating)) throw new Unverifiable(`${row.model_name}: rating is not a number`);
    const key = `${model} ${effort}`;
    if (landed.has(key)) throw new Unverifiable(`repeated ${key}`);
    landed.add(key);
    out.push({ model, effort, value: row.rating, source_url: PAGE_URL, retrieved_at: retrievedAt, kind: "independent", ...(harness && { harness }) });
  }
  if (out.length === 0) throw new Unverifiable("no LMArena model maps to a Wink model");
  // LMArena versions the board by its publish date.
  const [date] = dates;
  return { snapshot: { ...previous, version: date, updated: date, rows: sortRows(out, models) }, unmapped: unmapped.sort() };
}

export async function fetchSnapshot() {
  const rows = [];
  let retrievedAt;
  for (let offset = 0, total = 1; offset < total; offset += PAGE_SIZE) {
    const page = await get(`${API_URL}&offset=${offset}&length=${PAGE_SIZE}`);
    saveRaw(`lmarena-webdev-${offset}`, page.text, "json");
    const parsed = parseRows(page.text);
    total = parsed.total;
    retrievedAt ??= page.retrievedAt;
    rows.push(...parsed.rows.filter((row) => row.category === "overall"));
  }
  return buildSnapshot({ rows, models: readModels(), retrievedAt, previous: readSnapshot("lmarena-webdev") });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { snapshot, unmapped } = await fetchSnapshot();
    writeSnapshot("lmarena-webdev", snapshot);
    console.log(`lmarena-webdev: ${snapshot.rows.length} rows, updated ${snapshot.updated}, unmapped ${unmapped.length}`);
  } catch (error) {
    console.error(`lmarena-webdev: UNVERIFIABLE - ${error.message}`);
    process.exitCode = 1;
  }
}
