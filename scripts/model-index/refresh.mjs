// Re-fetches sources, rebuilds shared/model-index-data.ts and prints what changed. Exit 0 = no change, 2 = changed, 1 = error. Usage: node scripts/model-index/refresh.mjs [--aa-raw file]
// Weekly routine: commit the rewritten snapshots on exit 0 and exit 2, so the checked date stays true.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as lmarena from "./fetch-lmarena.mjs";
import * as listPrices from "./fetch-list-prices.mjs";
import * as vals from "./fetch-vals.mjs";
import * as aa from "./fetch-aa.mjs";
import { beginRun, readModels, readSnapshot, root, saveRaw, writeSnapshot } from "./lib.mjs";

const FETCHED = [
  { name: "lmarena-webdev", fetcher: lmarena },
  { name: "vals-legalbench", fetcher: vals.legal },
  { name: "vals-cyberbench", fetcher: vals.cyber },
  { name: "list-prices", fetcher: listPrices },
];
const MANUAL = aa.MANUAL;

// How each provider Wink carries spells its models in source ids.
const FAMILY = { anthropic: /claude/i, google: /gemini/i, openai: /gpt/i, xai: /grok/i, meta: /muse/i };
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

/** stderr is null when spawn itself fails, so prefer error.message. */
export function formatBuildFailure(build) {
  return `build-data: FAILED - ${build.error?.message ?? build.stderr?.trim()}`;
}

export async function refresh(today = day(new Date().toISOString()), { rawFile, ...credentials } = {}) {
  beginRun();
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
  try {
    const response = await aa.loadResponse({ rawFile, ...credentials });
    if (!response) out.push("AA: skipped; set AA_API_KEY, save ~/.aa/key, or pass --aa-raw <file>");
    else {
      for (const name of Object.keys(aa.BENCHMARKS)) {
        const before = readSnapshot(name);
        try {
          const { snapshot, unmapped, needsCost } = aa.buildSnapshot({ ...response, models, previous: before });
          writeSnapshot(name, snapshot);
          wrote = true;
          const result = report(name, before, snapshot, unmapped, models, today);
          out.push(...result.lines);
          if (needsCost.length) out.push(`  needs hand check: cost: ${needsCost.join(", ")}`);
          changed ||= result.changed;
        } catch (error) {
          failed = true;
          out.push(`${name}: UNVERIFIABLE, snapshot untouched - ${error.message}`);
        }
      }
    }
  } catch (error) {
    failed = true;
    out.push(`AA: UNVERIFIABLE, snapshots untouched - ${error.message}`);
  }
  for (const { name, why } of MANUAL) {
    const retrieved = readSnapshot(name).rows.map((row) => row.retrieved_at).sort()[0];
    out.push(`${name}: MANUAL, last retrieved ${day(retrieved)} (${why})`);
  }
  if (wrote) {
    const build = spawnSync(process.execPath, [join(root, "scripts/model-index/build-data.mjs")], { encoding: "utf8" });
    if (build.status !== 0) {
      failed = true;
      out.push(formatBuildFailure(build));
    }
  }
  return { out, code: failed ? 1 : changed ? 2 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rawFile = aa.rawFileArg(process.argv.slice(2));
    const { out, code } = await refresh(undefined, { rawFile });
    console.log(out.join("\n"));
    process.exitCode = code;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
