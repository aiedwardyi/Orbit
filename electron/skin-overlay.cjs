// The native window chrome that CSS cannot reach, per skin. Everything the
// renderer paints follows `[data-skin]` in src/styles.css; the Windows
// caption-button overlay and the window's own background are drawn by the
// main process and have to be told the same colours. The values mirror each
// skin's `--color-app` (the header strip is `bg-app`) and, for the symbols,
// its `--color-ink-secondary` — flattened to opaque hex because the overlay
// accepts no alpha. Keep in step with src/styles.css and src/lib/skins.ts.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SKIN_CHROME = Object.freeze({
  midnight: Object.freeze({ color: "#070707", symbolColor: "#b5b5b5" }),
  atelier: Object.freeze({ color: "#f5f1eb", symbolColor: "#6b6559" }),
  foundry: Object.freeze({ color: "#100e0b", symbolColor: "#b0a696" }),
  lagoon: Object.freeze({ color: "#dfeceb", symbolColor: "#4d5c5b" }),
  ledger: Object.freeze({ color: "#e9e9e9", symbolColor: "#575757" }),
  "catppuccin-mocha": Object.freeze({ color: "#1e1e2e", symbolColor: "#a6adc8" }),
  "tokyo-night": Object.freeze({ color: "#1a1b26", symbolColor: "#a9b1d6" }),
  vesper: Object.freeze({ color: "#101010", symbolColor: "#a0a0a0" }),
  onyx: Object.freeze({ color: "#0a0a0b", symbolColor: "#9c9ca5" }),
  dracula: Object.freeze({ color: "#282a36", symbolColor: "#a4abcc" }),
  cobalt: Object.freeze({ color: "#292a2b", symbolColor: "#bcaafe" }),
});

const DEFAULT_SKIN = "midnight";
const LIGHT_SKINS = new Set(["atelier", "lagoon", "ledger"]);
const SKIN_PREFERENCE_FILE = "skin-preference.json";
const LOCAL_STORAGE_DIR = path.join("Local Storage", "leveldb");
const OMB_SKIN_MARKER = Buffer.from("omb-skin");
const KNOWN_SKIN_RE =
  /^(midnight|atelier|foundry|lagoon|ledger|catppuccin-mocha|tokyo-night|vesper|onyx|dracula|cobalt)(?![A-Za-z0-9_-])/;
const MAX_SKIN_ID_LEN = Math.max(...Object.keys(SKIN_CHROME).map((id) => id.length));

/** The chrome colours for a skin id sent by the renderer. Anything that is
 * not a known skin — a renamed skin, a stale value, a non-string — falls
 * back to Midnight rather than throwing, because the renderer has already
 * painted and a wrong overlay is recoverable while a broken IPC is not. */
function skinChrome(skin) {
  return Object.hasOwn(SKIN_CHROME, skin) ? SKIN_CHROME[skin] : SKIN_CHROME[DEFAULT_SKIN];
}

/** True when the id names a skin this module knows. A non-string coerces to a
 * property key that cannot match a skin id, so it answers false without a
 * separate type guard. */
function isKnownSkin(skin) {
  return Object.hasOwn(SKIN_CHROME, skin);
}

/** Windows caption glyphs and DWM follow nativeTheme; light skins need
 * `light` or the symbols stay Midnight-on-Midnight. */
function skinThemeSource(skin) {
  return LIGHT_SKINS.has(skin) ? "light" : "dark";
}

function preferencePath(userDataDir) {
  return path.join(userDataDir, SKIN_PREFERENCE_FILE);
}

function readSkinPreferenceFile(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencePath(userDataDir), "utf8"));
    if (isKnownSkin(parsed?.skin)) return parsed.skin;
  } catch {
    /* missing or unreadable — try Chromium localStorage next */
  }
  return null;
}

/** Last-match scan of Chromium localStorage logs for the renderer key
 * `omb-skin`. The main process cannot read localStorage through Electron
 * APIs at window-create time, but the previous run left the value on disk
 * in Local Storage/leveldb. Binary separators around the key are skipped;
 * compacted records may miss — the preference file covers that after the
 * first desktop:skin. */
function extractOmbSkin(bytes) {
  let found = null;
  let from = 0;
  while (from <= bytes.length - OMB_SKIN_MARKER.length) {
    const at = bytes.indexOf(OMB_SKIN_MARKER, from);
    if (at === -1) break;
    let i = at + OMB_SKIN_MARKER.length;
    while (i < bytes.length && bytes[i] < 0x20) i += 1;
    const slice = bytes.toString("utf8", i, Math.min(bytes.length, i + MAX_SKIN_ID_LEN + 1));
    const match = slice.match(KNOWN_SKIN_RE);
    if (match) found = match[1];
    from = at + OMB_SKIN_MARKER.length;
  }
  return found;
}

function readSkinFromChromiumLocalStorage(userDataDir) {
  const dir = path.join(userDataDir, LOCAL_STORAGE_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let found = null;
  for (const name of names) {
    if (!/\.(log|ldb|sst)$/i.test(name)) continue;
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(dir, name));
    } catch {
      continue;
    }
    const extracted = extractOmbSkin(bytes);
    if (extracted) found = extracted;
  }
  return found;
}

/** The skin id the renderer last stored (omb-skin) and mirrored over
 * desktop:skin. Preference file wins; Chromium localStorage is the
 * upgrade path for a saved Ledger (or any skin) that has not been
 * written to userData yet. */
function readPersistedSkin(userDataDir) {
  if (typeof userDataDir !== "string" || !userDataDir) return null;
  return readSkinPreferenceFile(userDataDir) ?? readSkinFromChromiumLocalStorage(userDataDir);
}

function writePersistedSkin(userDataDir, skin) {
  if (typeof userDataDir !== "string" || !userDataDir || !isKnownSkin(skin)) return;
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(preferencePath(userDataDir), `${JSON.stringify({ skin })}\n`, "utf8");
}

module.exports = {
  SKIN_CHROME,
  DEFAULT_SKIN,
  skinChrome,
  isKnownSkin,
  skinThemeSource,
  extractOmbSkin,
  readPersistedSkin,
  writePersistedSkin,
};
