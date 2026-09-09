#!/usr/bin/env node
// Reads the skin blocks out of src/styles.css and measures every text/surface
// pair the components actually produce. Run it after touching a palette:
//
//   node scripts/check-skin-contrast.mjs
//
// It parses the CSS rather than taking a second copy of the values, so the
// check can never pass against a palette that is no longer the shipped one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

function declarations(body) {
  const tokens = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

/** The tokens every skin starts from: the `@theme` defaults plus the bare
 * `:root` block. A skin that does not redefine one of these still SHIPS it,
 * so the check has to measure it — otherwise a token upstream adds is
 * inherited untested by every skin, and the run stays green while a light
 * skin wears a dark skin's focus ring. That is exactly what happened when
 * upstream introduced --color-focus. */
function parseBase(source) {
  const base = {};
  for (const [, body] of source.matchAll(/(?:@theme|:root)\s*\{([^}]*)\}/g)) {
    Object.assign(base, declarations(body));
  }
  return base;
}

/** Every `[data-skin="x"] { … }` block, as id → {token: value}, over the
 * inherited base so a skin is measured as it actually renders. */
function parseSkins(source) {
  const base = parseBase(source);
  const skins = new Map();
  for (const [, id, body] of source.matchAll(/\[data-skin="([a-z-]+)"\]\s*\{([^}]*)\}/g)) {
    skins.set(id, { ...base, ...declarations(body) });
  }
  return skins;
}

function parseHex(hex) {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

/** Foreground alpha composited over an opaque background. */
function flatten(fg, bg) {
  if (fg.a === 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fgHex, bgHex) {
  const bg = parseHex(bgHex);
  const fg = flatten(parseHex(fgHex), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// Pairs taken from what the components render, not from what looks plausible:
// body copy sits on all five surfaces, the filled accent/danger buttons carry
// their own ink token, and the status colours are used as text on cards.
const SURFACES = ["--color-app", "--color-panel", "--color-raised", "--color-raised-hover", "--color-card", "--color-inset"];
const PAIRS = [
  ...SURFACES.map((s) => ["--color-ink", s, 4.5]),
  ...SURFACES.map((s) => ["--color-ink-secondary", s, 4.5]),
  ["--color-ink", "--color-bubble-user", 4.5],
  ["--color-accent-ink", "--color-accent", 4.5],
  ["--color-danger-ink", "--color-danger", 4.5],
  ["--color-accent-text", "--color-app", 4.5],
  ["--color-accent-text", "--color-panel", 4.5],
  ["--color-accent-text", "--color-card", 4.5],
  ["--color-danger", "--color-card", 4.5],
  ["--color-success", "--color-card", 4.5],
  ["--color-warning", "--color-card", 4.5],
  // borders and dots are UI components, not text — AA asks 3:1 of them
  ["--color-hairline", "--color-app", 1.5],
  ["--color-accent", "--color-app", 3],
  ["--color-scrollbar", "--color-app", 1.5],
  // The focus ring sits outside the control (outline-offset: 2px), so it
  // lands on whatever surface is behind it — a skin that inherits another
  // skin's ring keeps a colour that was never checked against its ground.
  // WCAG 1.4.11 asks 3:1 of a non-text indicator.
  ["--color-focus", "--color-app", 3],
  ["--color-focus", "--color-panel", 3],
  ["--color-focus", "--color-card", 3],
  // Surface against surface. Text contrast alone will not catch a skin that
  // gives two surfaces the same value: Atelier and Lagoon both defined
  // `raised` as the pure white they use for a card, so every chip, hover fill
  // and answered row painted in `raised` on a card was invisible while this
  // file stayed green. A surface is not text — it only has to be seen at all —
  // so the bar is a just-perceptible step rather than a WCAG ratio.
  //
  // `control` is measured against every surface it can land on, which is the
  // whole list: a tone chosen to clear the card and the panel drifted into
  // `inset` instead, and the badges inside an inset row went invisible again.
  ["--color-control", "--color-card", 1.06],
  ["--color-control", "--color-panel", 1.06],
  ["--color-control", "--color-app", 1.04],
  ["--color-control", "--color-inset", 1.04],
  ["--color-control", "--color-raised-hover", 1.04],
  ["--color-raised-hover", "--color-card", 1.04],
  ["--color-inset", "--color-card", 1.04],
  ["--color-card", "--color-app", 1.04],
  ["--color-panel", "--color-app", 1.03],
];

// ChatMarkdown paints fenced blocks with `bg-inset` and strips Shiki's pre
// background, so syntax colours sit on --color-inset. Code is 13px (body),
// so AA is 4.5:1. Dark skins skip this. The emitted set is github-dark-default's
// tokenColors foregrounds plus editor.foreground — not the --color-syntax-*
// names we happened to define — so a new token in that theme fails the run
// until it is remapped.
const CODE_BLOCK_BG = "--color-inset";
const SYNTAX_MIN = 4.5;

function githubDarkDefaultPath() {
  const pnpm = join(root, "node_modules", ".pnpm");
  if (existsSync(pnpm)) {
    for (const dir of readdirSync(pnpm)) {
      if (!dir.startsWith("@shikijs+themes@")) continue;
      const p = join(pnpm, dir, "node_modules", "@shikijs", "themes", "dist", "github-dark-default.mjs");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("github-dark-default theme file not found");
}

function loadGithubDarkDefault() {
  const src = readFileSync(githubDarkDefaultPath(), "utf8");
  const mark = "JSON.parse(" + String.fromCharCode(34);
  const i = src.indexOf(mark);
  if (i === -1) throw new Error("github-dark-default: missing JSON.parse payload");
  let k = i + mark.length;
  let out = "";
  while (k < src.length) {
    const c = src[k];
    if (c === "\\") {
      out += src[k + 1];
      k += 2;
      continue;
    }
    if (c === "\"") break;
    out += c;
    k += 1;
  }
  return JSON.parse(out);
}

function emittedForegrounds(theme) {
  const set = new Set();
  for (const entry of theme.tokenColors ?? []) {
    const fg = entry.settings?.foreground;
    if (typeof fg === "string" && /^#[0-9a-fA-F]{6}$/.test(fg)) set.add(fg.toLowerCase());
  }
  const editor = theme.colors?.["editor.foreground"];
  if (typeof editor === "string" && /^#[0-9a-fA-F]{6}$/.test(editor)) set.add(editor.toLowerCase());
  return [...set].sort();
}

function parseCssRemaps(source) {
  const bySkin = new Map();
  for (const [, selectors, token] of source.matchAll(
    /([^{}]+)\{[^{}]*color:\s*var\((--color-syntax-[\w-]+)\)/gi,
  )) {
    const skins = [...selectors.matchAll(/\[data-skin="([a-z0-9-]+)"\]/gi)].map((m) => m[1]);
    const hexes = [
      ...selectors.matchAll(new RegExp("\\[style\\*=\"#([0-9a-fA-F]{6})\"", "gi")),
    ].map((m) => `#${m[1].toLowerCase()}`);
    for (const id of skins) {
      if (!bySkin.has(id)) bySkin.set(id, new Map());
      const map = bySkin.get(id);
      for (const hex of hexes) map.set(hex, token);
    }
  }
  return bySkin;
}

function unmappedEmittedHexes(cssSource, skinId, hexes) {
  const remaps = parseCssRemaps(cssSource);
  const skinRemaps = remaps.get(skinId) ?? new Map();
  return hexes.filter((hex) => !skinRemaps.has(hex));
}

function isLightSkin(tokens) {
  const app = tokens["--color-app"];
  if (!app || !/^#[0-9a-fA-F]{3,8}$/.test(app.trim())) return false;
  return luminance(parseHex(app)) > 0.5;
}

export { parseCssRemaps, unmappedEmittedHexes };

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const skins = parseSkins(css);
  const emitted = emittedForegrounds(loadGithubDarkDefault());
  const remaps = parseCssRemaps(css);
  // Midnight is shipped as a faithful copy of upstream, contrast gaps included;
  // it is reported but not allowed to fail the run.
  const ADVISORY = new Set(["midnight"]);

  let failed = false;
  for (const [id, tokens] of skins) {
    const problems = [];
    const missing = [];
    let measured = 0;
    const pairs = [...PAIRS];
    if (isLightSkin(tokens)) {
      const skinRemaps = remaps.get(id) ?? new Map();
      for (const hex of emitted) {
        const token = skinRemaps.get(hex);
        if (!token) {
          missing.push(`unmapped github-dark-default ${hex}`);
          continue;
        }
        pairs.push([token, CODE_BLOCK_BG, SYNTAX_MIN]);
      }
    }
    for (const [fg, bg, min] of pairs) {
      // A pair we cannot measure is reported, never silently skipped: an
      // unmeasured pair used to be counted as a passing one.
      if (!tokens[fg] || !tokens[bg]) {
        missing.push(!tokens[fg] ? fg : bg);
        continue;
      }
      measured++;
      const ratio = contrast(tokens[fg], tokens[bg]);
      if (ratio < min) problems.push({ fg, bg, ratio, min });
    }
    const advisory = ADVISORY.has(id);
    if (missing.length) {
      console.log(`✗ ${id} — undefined token(s): ${[...new Set(missing)].join(", ")}`);
      if (!advisory) failed = true;
    }
    if (problems.length === 0) {
      if (!missing.length) console.log(`✓ ${id} — ${measured} pairs, none below target`);
      continue;
    }
    console.log(`${advisory ? "~" : "✗"} ${id}${advisory ? " (advisory — upstream copy)" : ""}`);
    for (const { fg, bg, ratio, min } of problems) {
      console.log(`    ${fg} on ${bg}: ${ratio.toFixed(2)}:1 (needs ${min}:1)`);
    }
    if (!advisory) failed = true;
  }

  process.exit(failed ? 1 : 0);
}
