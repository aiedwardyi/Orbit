// Refreshes shared/model-index-sources/list-prices.json from the five vendor pricing pages. Usage: node scripts/model-index/fetch-list-prices.mjs
import { pathToFileURL } from "node:url";
import { get, pageText, readModels, readSnapshot, saveRaw, sortRows, sourceIds, Unverifiable, writeSnapshot } from "./lib.mjs";

export const PAGES = {
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  google: "https://ai.google.dev/gemini-api/docs/pricing",
  meta: "https://dev.meta.ai/docs/pricing-rate-limits",
  openai: "https://developers.openai.com/api/docs/pricing",
  xai: "https://docs.x.ai/developers/pricing",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isoDate(text) {
  const m = text.match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/);
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (month < 0) throw new Unverifiable(`unexpected date ${text}`);
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Prices by page name; a name the page does not list is left out. */
export function parseAnthropic(html, names) {
  const text = pageText(html);
  const header = text.indexOf("Name Input Output 5m writes 1h writes Hits and refreshes");
  if (header < 0) throw new Unverifiable("Anthropic pricing table header not found");
  const table = text.slice(header);
  const prices = {};
  for (const name of names) {
    const start = table.search(new RegExp(`\\n\\s*${escape(name)}(?![\\w.])`));
    if (start < 0) continue;
    const rest = table.slice(start + 1);
    const end = rest.slice(name.length).search(/\n\s*(?:Claude [A-Z]|Additional models)/);
    const segment = end < 0 ? rest.slice(0, 1500) : rest.slice(0, name.length + end);
    const amounts = [...segment.matchAll(/\$([\d.]+) \/ MTok(?: for prompts (up to|over) ([\d,]+) tokens)?/g)].map((m) => ({ value: Number(m[1]), tier: m[2], tokens: m[3] }));
    const tiered = amounts.length === 10 && amounts[0].tier === "up to" && amounts[5].tier === "over" && amounts[0].tokens === amounts[5].tokens;
    if (!(amounts.length === 5 && !amounts.some((a) => a.tier)) && !tiered) throw new Unverifiable(`Anthropic ${name}: unexpected price cells`);
    const v = amounts.map((a) => a.value);
    prices[name] = {
      input: v[0],
      cachedInput: v[4],
      output: v[1],
      ...(tiered && { upToTokens: Number(amounts[0].tokens.replace(/,/g, "")), above: { input: v[5], cachedInput: v[9], output: v[6] } }),
    };
  }
  return prices;
}

/** A price like `$0.75 through December 31, 2026. $1.50 starting January 1, 2027.` or a plain `$0.30`. */
function googlePrice(line, what, id) {
  const m = line.match(/^\$([\d.]+)(?: through ([A-Z][a-z]+ \d{1,2}, \d{4})\. \$([\d.]+) starting ([A-Z][a-z]+ \d{1,2}, \d{4})\.)?/);
  if (!m) throw new Unverifiable(`Google ${id}: unexpected ${what} price`);
  return { now: Number(m[1]), until: m[2] && isoDate(m[2]), next: m[3] && Number(m[3]), from: m[4] && isoDate(m[4]) };
}

export function parseGoogle(html, names) {
  const text = pageText(html);
  if (!text.includes("Gemini Developer API pricing")) throw new Unverifiable("Google pricing page heading not found");
  const prices = {};
  for (const id of names) {
    const start = text.search(new RegExp(`\\n\\s*${escape(id)}\\s*\\n`));
    if (start < 0) continue;
    const nextModel = text.slice(start + id.length + 2).search(/\n\s*gemini-[\w.-]+\s*\n/);
    const block = text.slice(start, nextModel < 0 ? start + 8000 : start + id.length + 2 + nextModel);
    const standard = block.slice(0, block.search(/\n\s*Batch\s*\n/) < 0 ? undefined : block.search(/\n\s*Batch\s*\n/));
    const line = (label) => standard.match(new RegExp(`\\n\\s*${label}[^\\n]*?\\n\\s*Free of charge\\s*\\n\\s*([^\\n]+)`))?.[1].trim();
    const parts = [["Input price", "input"], ["Context caching price", "cached input"], ["Output price", "output"]].map(([label, what]) => {
      const value = line(label);
      if (!value) throw new Unverifiable(`Google ${id}: ${what} price not found`);
      return googlePrice(value, what, id);
    });
    const [input, cached, output] = parts;
    const promo = [input, cached, output].filter((p) => p.until);
    if (promo.length !== 0 && (promo.length !== 3 || new Set(promo.map((p) => `${p.until} ${p.from}`)).size !== 1)) {
      throw new Unverifiable(`Google ${id}: promo dates disagree across prices`);
    }
    prices[id] = {
      input: input.now,
      cachedInput: cached.now,
      output: output.now,
      ...(promo.length && { until: input.until, next: { from: input.from, input: input.next, cachedInput: cached.next, output: output.next } }),
    };
  }
  return prices;
}

export function parseMeta(html, names) {
  const text = pageText(html);
  const prices = {};
  const tiers = [...text.matchAll(/Models:([^\n]*)\n[\s\S]{0,700}?Usage Price per 1M tokens\s+Cached input \$([\d.]+)\s+Input \$([\d.]+)\s+Output \$([\d.]+)/g)];
  if (tiers.length === 0) throw new Unverifiable("Meta pricing tiers not found");
  for (const id of names) {
    const found = tiers.filter((t) => new RegExp(`(?<![\\w.-])${escape(id)}(?![\\w-]|\\.\\d)`).test(t[1]));
    if (found.length > 1) throw new Unverifiable(`Meta ${id}: listed in more than one tier`);
    if (found.length) prices[id] = { input: Number(found[0][3]), cachedInput: Number(found[0][2]), output: Number(found[0][4]) };
  }
  return prices;
}

export function parseOpenAI(html, names) {
  const props = html.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const islands = [...props.matchAll(/"tier":\[0,"standard"\],[^\n]*?"rows":\[1,(\[\[[\s\S]*?\]\]\])\}"/g)];
  if (islands.length !== 1) throw new Unverifiable(`OpenAI standard price table: ${islands.length} found`);
  const cells = [...islands[0][1].matchAll(/\[1,\[\[0,"([^"]+)"\],\[0,([\d.]+)\],\[0,([\d.]+)\],\[0,(?:[\d.]+|"-")\],\[0,([\d.]+)\]\]\]/g)];
  const priced = new Map(cells.map((m) => [m[1], { input: Number(m[2]), cachedInput: Number(m[3]), output: Number(m[4]) }]));
  if (priced.size === 0) throw new Unverifiable("OpenAI standard price table has no rows in the expected shape");
  const prices = {};
  for (const id of names) {
    if (priced.has(id)) prices[id] = priced.get(id);
    else if (islands[0][1].includes(`"${id}"`)) throw new Unverifiable(`OpenAI ${id}: row shape changed`);
  }
  return prices;
}

export function parseXai(html, names) {
  const text = pageText(html);
  if (!/Model Context Short context Long context\s+Input Cached Output Input Cached Output/.test(text)) throw new Unverifiable("xAI pricing table header not found");
  const prices = {};
  for (const id of names) {
    const m = text.match(new RegExp(`\\n\\s*${escape(id)} Long context[^\\n]*\\n\\s*[\\w.]+ \\$([\\d.]+) \\$([\\d.]+) \\$([\\d.]+) \\$[\\d.]+ \\$[\\d.]+ \\$[\\d.]+`));
    if (m) prices[id] = { input: Number(m[1]), cachedInput: Number(m[2]), output: Number(m[3]) };
  }
  return prices;
}

const PARSERS = { anthropic: parseAnthropic, google: parseGoogle, meta: parseMeta, openai: parseOpenAI, xai: parseXai };

export function buildSnapshot({ pages, models, previous }) {
  const ids = sourceIds(models, "list-prices");
  const rows = [];
  for (const [vendor, { html, retrievedAt }] of Object.entries(pages)) {
    const names = Object.keys(ids).filter((name) => models[ids[name]].provider === vendor);
    const prices = PARSERS[vendor](html, names);
    for (const name of names) {
      if (!prices[name]) continue;
      rows.push({ model: ids[name], effort: "all", price: prices[name], source_url: PAGES[vendor], retrieved_at: retrievedAt, kind: "vendor" });
    }
  }
  if (rows.length === 0) throw new Unverifiable("no vendor page lists a Wink model");
  return { snapshot: { ...previous, rows: sortRows(rows, models) }, unmapped: [] };
}

export async function fetchSnapshot() {
  const pages = {};
  for (const [vendor, url] of Object.entries(PAGES)) {
    const { text, retrievedAt } = await get(url);
    saveRaw(`list-prices-${vendor}`, text, "html");
    pages[vendor] = { html: text, retrievedAt };
  }
  return buildSnapshot({ pages, models: readModels(), previous: readSnapshot("list-prices") });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { snapshot } = await fetchSnapshot();
    writeSnapshot("list-prices", snapshot);
    console.log(`list-prices: ${snapshot.rows.length} rows`);
  } catch (error) {
    console.error(`list-prices: UNVERIFIABLE - ${error.message}`);
    process.exitCode = 1;
  }
}
