// Refreshes shared/model-index-sources/vals-legalbench.json and vals-cyberbench.json from their Vals.ai benchmark pages. Usage: node scripts/model-index/fetch-vals.mjs
import { pathToFileURL } from "node:url";
import { get, readModels, readSnapshot, saveRaw, sortRows, sourceIds, Unverifiable, writeSnapshot } from "./lib.mjs";

export const BENCHMARKS = {
  "vals-legalbench": { id: "legal_bench", name: "LegalBench", url: "https://www.vals.ai/benchmarks/legal_bench" },
  "vals-cyberbench": { id: "cyberbench", name: "CyberBench", url: "https://www.vals.ai/benchmarks/cyber" },
};

/** End of the object or array opening at `open`, skipping quoted strings. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      while (++i < text.length && text[i] !== '"') if (text[i] === "\\") i++;
    } else if (ch === "{" || ch === "[") depth++;
    else if ((ch === "}" || ch === "]") && --depth === 0) return i + 1;
  }
  return -1;
}

/** Version, update date, overall accuracy and cost per test per Vals model id, from the page's island props. */
export function parsePage(html, benchmarkId = "legal_bench") {
  const props = html.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
  const meta = props.match(new RegExp(`"benchmark_id":\\[0,"${benchmarkId}"\\],"family":\\[0,"[^"]+"\\],"version":\\[0,"([^"]+)"\\],"updated":\\[0,"(\\d{4}-\\d{2}-\\d{2})"\\]`));
  if (!meta) throw new Unverifiable("Vals version and updated date not found");
  const start = props.search(/"overall":\[0,\{"(?=[a-z0-9_-]+\/)/);
  const end = start < 0 ? -1 : closing(props, props.indexOf("{", start));
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

export function buildSnapshot({ page, models, retrievedAt, previous, benchmark = "vals-legalbench" }) {
  const { name, url } = BENCHMARKS[benchmark];
  if (page.version !== previous.version) throw new Unverifiable(`Vals ${name} is now version ${page.version}, snapshot is ${previous.version}`);
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
      // One Vals id per model reads "all"; a model Vals runs at two efforts names each in models.json.
      effort: models[model].efforts?.vals?.[id] ?? "all",
      value,
      ...(cost !== undefined && { cost_per_task: cost, cost_benchmark: benchmark, cost_source: url }),
      source_url: url,
      retrieved_at: retrievedAt,
      kind: "independent",
    });
  }
  if (rows.length === 0) throw new Unverifiable("no Vals model maps to a Wink model");
  return { snapshot: { ...previous, updated: page.updated, rows: sortRows(rows, models) }, unmapped: unmapped.sort() };
}

const fetcher = (benchmark) => ({
  async fetchSnapshot() {
    const { id, url } = BENCHMARKS[benchmark];
    const { text, retrievedAt } = await get(url);
    saveRaw(benchmark, text, "html");
    return buildSnapshot({ page: parsePage(text, id), models: readModels(), retrievedAt, previous: readSnapshot(benchmark), benchmark });
  },
});

export const legal = fetcher("vals-legalbench");
export const cyber = fetcher("vals-cyberbench");

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [benchmark, run] of [["vals-legalbench", legal], ["vals-cyberbench", cyber]]) {
    try {
      const { snapshot, unmapped } = await run.fetchSnapshot();
      writeSnapshot(benchmark, snapshot);
      console.log(`${benchmark}: ${snapshot.rows.length} rows, updated ${snapshot.updated}, unmapped ${unmapped.length}`);
    } catch (error) {
      console.error(`${benchmark}: UNVERIFIABLE - ${error.message}`);
      process.exitCode = 1;
    }
  }
}
