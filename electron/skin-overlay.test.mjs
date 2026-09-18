import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  SKIN_CHROME,
  DEFAULT_SKIN,
  skinChrome,
  isKnownSkin,
  skinThemeSource,
  extractOmbSkin,
  readPersistedSkin,
  writePersistedSkin,
} = require("./skin-overlay.cjs");

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../src/styles.css"), "utf8");
const skinIds = readFileSync(join(here, "../src/lib/skins.ts"), "utf8");

const scratchDirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "omb-skin-"));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (scratchDirs.length) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

// The value CSS defines for one custom property inside one skin's block.
function cssToken(skin, name) {
  const block = css.match(new RegExp(`\\[data-skin="${skin}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return block.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]+)`))?.[1]?.toLowerCase() ?? null;
}

describe("skin overlay chrome", () => {
  it("covers exactly the skins the renderer ships", () => {
    // SKIN_IDS is the source of truth (src/lib/skins.ts); a skin added there
    // without a chrome entry here would leave that skin's caption buttons on
    // the previous colour — the issue #454 failure, but for a new skin.
    const registered = [...skinIds.matchAll(/"([a-z-]+)"/g)]
      .map(([, id]) => id)
      .filter((id) => css.includes(`[data-skin="${id}"]`));
    expect(new Set(registered)).toEqual(new Set(Object.keys(SKIN_CHROME)));
  });

  it("matches each skin's --color-app (the header strip is bg-app)", () => {
    for (const [skin, chrome] of Object.entries(SKIN_CHROME)) {
      expect(chrome.color.toLowerCase()).toBe(cssToken(skin, "--color-app"));
    }
  });

  it("uses opaque symbol colours the overlay can accept", () => {
    // The Windows overlay rejects alpha, so every symbolColor must be a plain
    // 6-digit hex even though the CSS ink tokens may carry an alpha byte.
    for (const chrome of Object.values(SKIN_CHROME)) {
      expect(chrome.symbolColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("recolors the window ground and shows a waiting Windows window", () => {
    // 61b9905's desktop:skin handler returned isKnownSkin and did nothing
    // else, so a saved light skin sat behind Midnight #070707 until the 5s
    // fallback. The handler has to call skinChrome + setBackgroundColor +
    // show, and on Windows also recolor the titleBarOverlay.
    const main = readFileSync(join(here, "main.mjs"), "utf8");
    const handler = main.match(/ipcMain\.handle\("desktop:skin",[\s\S]*?\n\}\);/)?.[0] ?? "";
    expect(handler).toContain("skinChrome");
    expect(handler).toContain("setBackgroundColor");
    expect(handler).toContain("nativeTheme.themeSource");
    expect(handler).toContain(".show()");
    expect(handler).toContain("writePersistedSkin");
    expect(handler).toContain("applyWindowsTitleBarOverlay");
    expect(handler).toContain("win !== mainWindow");
  });

  it("paints connecting-page ink from the skin's symbolColor", () => {
    const main = readFileSync(join(here, "main.mjs"), "utf8");
    const href = main.slice(
      main.indexOf("function connectingPageHref"),
      main.indexOf("function packagedWindowHref"),
    );
    expect(href).toContain("chrome.symbolColor");
    expect(href).toContain("color: chrome.symbolColor");
  });

  it("shows from the persisted skin at create, not after renderer IPC", () => {
    // Visual QA: first visible frame was Ledger gray, but only after the
    // 5s desktop:skin fallback. createWindow must read the stored skin,
    // paint nativeTheme + backgroundColor, then show() without waiting.
    const main = readFileSync(join(here, "main.mjs"), "utf8");
    expect(main).toContain("readPersistedSkin(app.getPath(\"userData\"))");
    expect(main).toContain("skinThemeSource");
    expect(main).not.toContain("waitsForSkinSync");
    expect(main).not.toContain("skinSyncFallback");
    const create = main.slice(main.indexOf("function createWindow()"), main.indexOf("ipcMain.handle(\"screen:frame\""));
    expect(create).toContain("nativeTheme.themeSource = skinThemeSource(persistedSkin)");
    expect(create).not.toMatch(/if \(isKnownSkin\(persistedSkin\)\) \{\s*nativeTheme\.themeSource/);
    expect(create).toContain("setBackgroundColor");
    expect(create).toContain("win.show()");
    expect(create).toContain("backgroundColor: chrome.color");
    expect(create).not.toContain("5_000");
  });

  it("falls back to the default skin for anything unknown, never throwing", () => {
    expect(DEFAULT_SKIN).toBe("ledger");
    expect(isKnownSkin("midnight")).toBe(true);
    expect(isKnownSkin("onyx")).toBe(true);
    expect(isKnownSkin("dracula")).toBe(true);
    expect(isKnownSkin("cobalt")).toBe(true);
    expect(isKnownSkin("does-not-exist")).toBe(false);
    expect(isKnownSkin(undefined)).toBe(false);
    expect(isKnownSkin(42)).toBe(false);
    expect(skinChrome("does-not-exist")).toEqual(SKIN_CHROME[DEFAULT_SKIN]);
    expect(skinChrome(null)).toEqual(SKIN_CHROME[DEFAULT_SKIN]);
  });

  it("locks caption chrome for onyx, dracula, and cobalt", () => {
    expect(SKIN_CHROME.onyx).toEqual({ color: "#000000", symbolColor: "#a8a6a3" });
    expect(SKIN_CHROME.dracula).toEqual({ color: "#282a36", symbolColor: "#a4abcc" });
    expect(SKIN_CHROME.cobalt).toEqual({ color: "#292a2b", symbolColor: "#bcaafe" });
  });

  it("locks caption chrome for the optional editor skins", () => {
    expect(SKIN_CHROME["vscode-dark"]).toEqual({ color: "#1e1e1e", symbolColor: "#a7a7a7" });
    expect(SKIN_CHROME["studio-gray"]).toEqual({ color: "#242424", symbolColor: "#b8b8b8" });
    expect(SKIN_CHROME["steel-gray"]).toEqual({ color: "#2b3038", symbolColor: "#b9c3d0" });
    expect(SKIN_CHROME.claude).toEqual({ color: "#171615", symbolColor: "#b8b0a6" });
  });

  it("locks caption chrome for the eight added skins", () => {
    expect(SKIN_CHROME.precision).toEqual({ color: "#121316", symbolColor: "#a3a7b3" });
    expect(SKIN_CHROME.notebook).toEqual({ color: "#ffffff", symbolColor: "#686862" });
    expect(SKIN_CHROME.messenger).toEqual({ color: "#f8f9fb", symbolColor: "#606671" });
    expect(SKIN_CHROME.community).toEqual({ color: "#313338", symbolColor: "#b5bac1" });
    expect(SKIN_CHROME["code-review"]).toEqual({ color: "#ffffff", symbolColor: "#59636e" });
    expect(SKIN_CHROME.blueprint).toEqual({ color: "#eaf2fa", symbolColor: "#4f6680" });
    expect(SKIN_CHROME["blueprint-gray"]).toEqual({ color: "#3a414a", symbolColor: "#d8e0e8" });
    expect(SKIN_CHROME["blueprint-charcoal"]).toEqual({ color: "#1f252c", symbolColor: "#b7c4d0" });
  });

  it("extracts onyx, dracula, and cobalt from the omb-skin marker", () => {
    expect(extractOmbSkin(Buffer.from("xxomb-skin\u0000\u0001onyx\u0000yy"))).toBe("onyx");
    expect(extractOmbSkin(Buffer.from("xxomb-skin\u0000\u0001dracula\u0000yy"))).toBe("dracula");
    expect(extractOmbSkin(Buffer.from("xxomb-skin\u0000\u0001cobalt\u0000yy"))).toBe("cobalt");
  });

  it("returns null when the omb-skin marker is missing or the buffer is empty", () => {
    expect(extractOmbSkin(Buffer.from("no marker here"))).toBe(null);
    expect(extractOmbSkin(Buffer.alloc(0))).toBe(null);
    expect(extractOmbSkin(Buffer.from("xxomb-skin\u0000\u0001future-skin\u0000yy"))).toBe(null);
  });

  it("maps light skins to nativeTheme light and the rest dark", () => {
    expect(skinThemeSource("ledger")).toBe("light");
    expect(skinThemeSource("atelier")).toBe("light");
    expect(skinThemeSource("lagoon")).toBe("light");
    expect(skinThemeSource("midnight")).toBe("dark");
    expect(skinThemeSource("foundry")).toBe("dark");
    expect(skinThemeSource("catppuccin-frappe")).toBe("dark");
    expect(skinThemeSource("tokyo-night")).toBe("dark");
    expect(skinThemeSource("vesper")).toBe("dark");
    expect(skinThemeSource("onyx")).toBe("dark");
    expect(skinThemeSource("dracula")).toBe("dark");
    expect(skinThemeSource("cobalt")).toBe("dark");
    expect(skinThemeSource("gruvbox")).toBe("dark");
    expect(skinThemeSource("precision")).toBe("dark");
    expect(skinThemeSource("community")).toBe("dark");
    expect(skinThemeSource("notebook")).toBe("light");
    expect(skinThemeSource("messenger")).toBe("light");
    expect(skinThemeSource("code-review")).toBe("light");
    expect(skinThemeSource("blueprint")).toBe("light");
    expect(skinThemeSource("blueprint-gray")).toBe("dark");
    expect(skinThemeSource("blueprint-charcoal")).toBe("dark");
  });

  it("maps a missing persisted skin to Ledger light nativeTheme", () => {
    expect(skinThemeSource(null)).toBe("light");
    expect(skinThemeSource(undefined)).toBe("light");
    expect(skinThemeSource("not-a-skin")).toBe("light");
    expect(skinThemeSource(DEFAULT_SKIN)).toBe("light");
  });

  it("round-trips a known skin through the userData preference file", () => {
    const dir = scratch();
    expect(readPersistedSkin(dir)).toBe(null);
    writePersistedSkin(dir, "ledger");
    expect(readPersistedSkin(dir)).toBe("ledger");
    expect(JSON.parse(readFileSync(join(dir, "skin-preference.json"), "utf8"))).toEqual({
      skin: "ledger",
    });
    writePersistedSkin(dir, "not-a-skin");
    expect(readPersistedSkin(dir)).toBe("ledger");
  });

  it("reads omb-skin out of Chromium localStorage logs when no preference file exists", () => {
    const dir = scratch();
    const level = join(dir, "Local Storage", "leveldb");
    mkdirSync(level, { recursive: true });
    writeFileSync(join(level, "000003.log"), Buffer.from("xxomb-skin\u0000\u0001ledger\u0000yy"));
    expect(readPersistedSkin(dir)).toBe("ledger");
  });

  it("reads a hyphenated skin id at the 17-character buffer limit from localStorage logs", () => {
    const dir = scratch();
    const level = join(dir, "Local Storage", "leveldb");
    mkdirSync(level, { recursive: true });
    writeFileSync(join(level, "000003.log"), Buffer.from("xxomb-skin\u0000\u0001catppuccin-frappe\u0000yy"));
    expect(readPersistedSkin(dir)).toBe("catppuccin-frappe");
  });

  it("does not treat a longer hyphenated value as a known skin", () => {
    const dir = scratch();
    const level = join(dir, "Local Storage", "leveldb");
    mkdirSync(level, { recursive: true });
    writeFileSync(join(level, "000003.log"), Buffer.from("xxomb-skin\u0000\u0001catppuccin-frappe-extra\u0000yy"));
    expect(readPersistedSkin(dir)).toBe(null);
  });

  it("prefers the preference file over a stale localStorage log", () => {
    const dir = scratch();
    const level = join(dir, "Local Storage", "leveldb");
    mkdirSync(level, { recursive: true });
    writeFileSync(join(level, "000003.log"), Buffer.from("omb-skin\u0000\u0001ledger"));
    writePersistedSkin(dir, "atelier");
    expect(readPersistedSkin(dir)).toBe("atelier");
  });

  it("migrates a stored Catppuccin Mocha preference to Catppuccin Frappe", () => {
    const dir = scratch();
    writeFileSync(join(dir, "skin-preference.json"), JSON.stringify({ skin: "catppuccin-mocha" }), "utf8");
    expect(readPersistedSkin(dir)).toBe("catppuccin-frappe");
  });

  it("migrates a Catppuccin Mocha localStorage log to Catppuccin Frappe", () => {
    const dir = scratch();
    const level = join(dir, "Local Storage", "leveldb");
    mkdirSync(level, { recursive: true });
    writeFileSync(join(level, "000003.log"), Buffer.from("xxomb-skin\u0000\u0001catppuccin-mocha\u0000yy"));
    expect(readPersistedSkin(dir)).toBe("catppuccin-frappe");
  });

  it("resolves catppuccin-mocha to catppuccin-frappe chrome and dark theme", () => {
    expect(skinChrome("catppuccin-mocha")).toEqual(SKIN_CHROME["catppuccin-frappe"]);
    expect(skinThemeSource("catppuccin-mocha")).toBe("dark");
  });
});
