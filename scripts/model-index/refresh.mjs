// Re-fetches every source we may fetch, rewrites its snapshot, rebuilds shared/model-index-data.ts and prints what changed. Exit 0 = no change, 2 = changed, 1 = error. Usage: node scripts/model-index/refresh.mjs
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as deepswe from "./fetch-deepswe.mjs";
import * as listPrices from "./fetch-list-prices.mjs";
import * as vals from "./fetch-vals.mjs";
import { readModels, readSnapshot, root, saveRaw, writeSnapshot } from "./lib.mjs";

const FETCHED = [
  { name: "deepswe", fetcher: deepswe },
  { name: "vals-legalbench", fetcher: vals },
  { name: "list-prices", fetcher: listPrices },
];
const MANUAL = [
  { name: "aa-intelligence-index", why: "artificialanalysis.ai terms bar scripted access; its API needs an account key" },
  { name: "aa-terminal-bench", why: "artificialanalysis.ai terms bar scripted access; its API needs an account key" },
  { name: "aa-gdpval", why: "artificialanalysis.ai terms bar scripted access; its API needs an account key" },
];

// How each provider Wink carries spells its models in source ids.
const FAMILY = { anthropic: /claude/, google: /gemini/, openai: /gpt/, xai: /grok/, meta: /muse/ };
const rowKey = (row) => `${row.model} ${row.effort}`;
const show = (value) => (value === undefined ? "none" : JSON.stringify(value));

/** New, dropped and changed rows between two snapshots; retrieved_at is not a change. */
export function diffSnapshots(before, after) {
  const old = new Map(before.rows.map((row) => [rowKey(row), row]));
  const next = new Map(after.rows.map((row) => [rowKey(row), row]));
  const added = [...next.keys()].filter((key) => !old.has(key));
  const dropped = [...old.keys()].filter((key) => !next.has(key));
  const changed = [];
  for (const [key, row] of next) {
    const prev = old.get(key);
    if (!prev) continue;
    for (const field of new Set([...Object.keys(prev), ...Object.keys(row)])) {
      if (field !== "retrieved_at" && JSON.stringify(prev[field]) !== JSON.stringify(row[field])) {
        changed.push(`${key}: ${field} ${show(prev[field])} -> ${show(row[field])}`);
      }
    }
  }
  const dateChanged = before.updated !== after.updated;
  return { added, dropped, changed, dateChanged, any: added.length + dropped.length + changed.length > 0 || dateChanged };
}

const day = (iso) => iso.slice(0, 10);

function report(name, before, after, unmapped, models, today) {
  const diff = diffSnapshots(before, after);
  const lines = [`${name}: ${diff.any ? "CHANGED" : "no change"}, ${after.rows.length} rows`];
  const age = after.updated ? `${after.updated} (${Math.round((Date.parse(today) - Date.parse(after.updated)) / 864e5)} days before ${today})` : "none published";
  lines.push(`  source date: ${age}`);
  for (const key of diff.added) lines.push(`  new row: ${key}`);
  for (const line of diff.changed) lines.push(`  changed: ${line}`);
  for (const key of diff.dropped) lines.push(`  dropped: ${key}`);
  if (unmapped.length) {
    saveRaw(`${name}-unmapped`, unmapped.join("\n"), "txt");
    const carried = Object.values(models).map((meta) => FAMILY[meta.provider]);
    const near = unmapped.filter((id) => carried.some((family) => family?.test(id)));
    const others = unmapped.length - near.length;
    lines.push(`  unmapped source models (${unmapped.length}), from Wink's providers: ${near.join(", ") || "none"}${others ? `; ${others} others in .model-index-cache` : ""}`);
  }
  const scored = new Set(after.rows.map((row) => row.model));
  const missing = Object.keys(models).filter((id) => !scored.has(id));
  if (missing.length) lines.push(`  picker models with no row: ${missing.join(", ")}`);
  return { lines, changed: diff.any };
}

export async function refresh(today = day(new Date().toISOString())) {
  const models = readModels();
  const out = [];
  let changed = false;
  let failed = false;
  let wrote = false;
  for (const { name, fetcher } of FETCHED) {
    const before = readSnapshot(name);
    try {
      const { snapshot, unmapped } = await fetcher.fetchSnapshot();
      writeSnapshot(name, snapshot);
      wrote = true;
      const result = report(name, before, snapshot, unmapped, models, today);
      out.push(...result.lines);
      changed ||= result.changed;
    } catch (error) {
      failed = true;
      out.push(`${name}: UNVERIFIABLE, snapshot untouched - ${error.message}`);
    }
  }
  for (const { name, why } of MANUAL) {
    const retrieved = readSnapshot(name).rows.map((row) => row.retrieved_at).sort()[0];
    out.push(`${name}: manual, last retrieved ${day(retrieved)} (${why})`);
  }
  if (wrote) {
    const build = spawnSync(process.execPath, [join(root, "scripts/model-index/build-data.mjs")], { encoding: "utf8" });
    if (build.status !== 0) {
      failed = true;
      out.push(`build-data: FAILED - ${build.stderr.trim()}`);
    }
  }
  return { out, code: failed ? 1 : changed ? 2 : 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { out, code } = await refresh();
  console.log(out.join("\n"));
  process.exitCode = code;
}
