// Refreshes shared/model-index-sources/vals-legalbench.json from the Vals.ai LegalBench page. Usage: node scripts/model-index/fetch-vals.mjs
import { pathToFileURL } from "node:url";
import { get, readModels, readSnapshot, saveRaw, sortRows, sourceIds, Unverifiable, writeSnapshot } from "./lib.mjs";

const PAGE_URL = "https://www.vals.ai/benchmarks/legal_bench";

/** Version, update date, overall accuracy and cost per test per Vals model id, from the page's island props. */
export function parsePage(html) {
  const props = html.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
  const meta = props.match(/"benchmark_id":\[0,"legal_bench"\],"family":\[0,"legal_bench"\],"version":\[0,"([^"]+)"\],"updated":\[0,"(\d{4}-\d{2}-\d{2})"\]/);
  if (!meta) throw new Unverifiable("Vals version and updated date not found");
  const start = props.search(/"overall":\[0,\{"(?=[a-z0-9_-]+\/)/);
  const end = props.indexOf('"issue_tasks":[0,{', start);
  if (start < 0 || end < 0) throw new Unverifiable("Vals overall table not found");
  const accuracy = new Map();
  const cost = new Map();
  for (const m of props.slice(start, end).matchAll(/"([a-z0-9_-]+\/[a-z0-9_.-]+)":\[0,\{"accuracy":\[0,([0-9.]+)\](?:,"latency":\[0,[^\]]*\],"cost_per_test":\[0,([0-9.]+(?:e-?\d+)?)\])?/g)) {
    if (accuracy.has(m[1]) && accuracy.get(m[1]) !== Number(m[2])) throw new Unverifiable(`Vals lists ${m[1]} with two accuracies`);
    accuracy.set(m[1], Number(m[2]));
    if (m[3]) cost.set(m[1], Number(m[3]));
  }
  if (accuracy.size === 0) throw new Unverifiable("Vals overall table has no accuracy entries");
  if (cost.size === 0) throw new Unverifiable("Vals overall table has no cost per test");
  const listed = new Set([...props.slice(start, end).matchAll(/"([a-z0-9_-]+\/[a-z0-9_.-]+)":\[0,\{/g)].map((m) => m[1]));
  const lacking = [...listed].filter((id) => !accuracy.has(id));
  if (lacking.length) throw new Unverifiable(`Vals overall table: no numeric accuracy for ${lacking.join(", ")}`);
  return { version: meta[1], updated: meta[2], accuracy, cost };
}

export function buildSnapshot({ page, models, retrievedAt, previous }) {
  if (page.version !== previous.version) throw new Unverifiable(`Vals LegalBench is now version ${page.version}, snapshot is ${previous.version}`);
  const ids = sourceIds(models, "vals");
  const unmapped = [];
  const rows = [];
  for (const [id, value] of page.accuracy) {
    const model = ids[id];
    if (!model) {
      unmapped.push(id);
      continue;
    }
    const cost = page.cost.get(id);
    rows.push({
      model,
      effort: "all",
      value,
      ...(cost !== undefined && { cost_per_task: cost, cost_benchmark: "vals-legalbench", cost_source: PAGE_URL }),
      source_url: PAGE_URL,
      retrieved_at: retrievedAt,
      kind: "independent",
    });
  }
  if (rows.length === 0) throw new Unverifiable("no Vals model maps to a Wink model");
  return { snapshot: { ...previous, updated: page.updated, rows: sortRows(rows, models) }, unmapped: unmapped.sort() };
}

export async function fetchSnapshot() {
  const { text, retrievedAt } = await get(PAGE_URL);
  saveRaw("vals", text, "html");
  return buildSnapshot({ page: parsePage(text), models: readModels(), retrievedAt, previous: readSnapshot("vals-legalbench") });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { snapshot, unmapped } = await fetchSnapshot();
    writeSnapshot("vals-legalbench", snapshot);
    console.log(`vals: ${snapshot.rows.length} rows, updated ${snapshot.updated}, unmapped ${unmapped.length}`);
  } catch (error) {
    console.error(`vals: UNVERIFIABLE - ${error.message}`);
    process.exitCode = 1;
  }
}
