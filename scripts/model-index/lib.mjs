// Shared by the fetch-*.mjs scripts: polite fetch, raw cache, snapshot IO, id mapping.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const sourcesDir = join(root, "shared/model-index-sources");
export const cacheDir = join(root, ".model-index-cache");

const USER_AGENT = "Wink-model-index-refresh/1.0 (weekly, one request per page)";
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "all"];

/** The source is unreachable or changed shape; its snapshot stays as it was. */
export class Unverifiable extends Error {}

const seen = new Set();
let lastRequest = 0;

/** One request per second, each URL at most once per process. */
export async function get(url) {
  if (seen.has(url)) throw new Error(`${url} already fetched this run`);
  seen.add(url);
  const wait = lastRequest + 1000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequest = Date.now();
  let res;
  try {
    res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new Unverifiable(`${url}: ${error.message}`);
  }
  if (res.status !== 200) throw new Unverifiable(`${url}: HTTP ${res.status}`);
  return { text: await res.text(), retrievedAt: new Date().toISOString() };
}

/** Raw response kept so a disputed number can be traced. */
export function saveRaw(source, text, ext) {
  mkdirSync(cacheDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(cacheDir, `${source}-${stamp}.${ext}`), text);
}

export function readSnapshot(name) {
  return JSON.parse(readFileSync(join(sourcesDir, `${name}.json`), "utf8"));
}

export function writeSnapshot(name, snapshot) {
  writeFileSync(join(sourcesDir, `${name}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function readModels() {
  return JSON.parse(readFileSync(join(sourcesDir, "models.json"), "utf8"));
}

/** Rows in models.json order, then effort order, as make-snapshots wrote them. */
export function sortRows(rows, models) {
  const order = Object.keys(models);
  return rows.sort((a, b) => order.indexOf(a.model) - order.indexOf(b.model) || EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort));
}

/** Source model id to Wink id for one source, from the `sources` table in models.json. */
export function sourceIds(models, source) {
  const ids = {};
  for (const [winkId, meta] of Object.entries(models)) {
    for (const id of meta.sources?.[source] ?? []) {
      if (ids[id]) throw new Error(`${source}: ${id} maps to both ${ids[id]} and ${winkId}`);
      ids[id] = winkId;
    }
  }
  return ids;
}

/** Fraction string to percent by moving the decimal point, so no float noise is added. */
export function percent(fraction) {
  const text = String(fraction);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Unverifiable(`unexpected number ${text}`);
  const [whole, frac = ""] = text.split(".");
  const digits = (frac + "00").slice(0, Math.max(2, frac.length));
  const moved = `${whole}${digits.slice(0, 2)}.${digits.slice(2)}`.replace(/^0+(?=\d)/, "").replace(/\.$/, "");
  return Number(moved);
}

/** Visible text of an HTML page, one line per block element. */
export function pageText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<\/(tr|p|div|li|h\d)>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");
}
