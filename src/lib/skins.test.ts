// The registry and the stylesheet are two halves of one contract: a skin listed
// here without a matching CSS block renders as whatever was active before, with
// no error anywhere. That failure is silent, so it gets a test.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { SKINS, SKIN_IDS, DEFAULT_SKIN, LIGHT_SKIN_IDS, applySkin, readSkin } from "./skins";
import { terminalTheme } from "./terminal-appearance";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
  "utf8",
).replace(/\r\n/g, "\n");

const blocks = new Set(
  [...css.matchAll(/\[data-skin="([a-z-]+)"\]/g)].map(([, id]) => id),
);

function cssToken(id: string, name: string): string | null {
  const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return body.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]+)`))?.[1]?.toLowerCase() ?? null;
}

// A shared list (`[data-skin="a"],\n[data-skin="b"] {`) gives every listed skin its tokens.
function sharedBodies(id: string): string[] {
  return [...css.matchAll(/((?:\[data-skin="[a-z-]+"\],\s*)+\[data-skin="[a-z-]+"\])\s*\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.includes(`[data-skin="${id}"]`))
    .map(([, , body]) => body);
}

function tokensOf(id: string): Set<string> {
  const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return new Set([body, ...sharedBodies(id)].flatMap((b) => [...b.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name)));
}

function channels(hex: string) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function spread(hex: string) {
  const { r, g, b } = channels(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function luminance(hex: string) {
  const { r, g, b } = channels(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(hex1: string, hex2: string) {
  const [hi, lo] = [luminance(hex1), luminance(hex2)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// Model brightness-110 as each sRGB channel of both fill and ink times 1.1, capped at 255.
function brightness110(hex: string) {
  const { r, g, b } = channels(hex);
  const scale = (c: number) => Math.min(255, Math.round(c * 1.1));
  const hex2 = (c: number) => scale(c).toString(16).padStart(2, "0");
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

function blend(fgHex: string, bgHex: string, alpha: number): string {
  const f = channels(fgHex);
  const b = channels(bgHex);
  const c = (vf: number, vb: number) =>
    Math.round(vf * alpha + vb * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  return `#${c(f.r, b.r)}${c(f.g, b.g)}${c(f.b, b.b)}`;
}

function skinToken(id: string, name: string): string {
  if (id === "default") {
    const rootBody = css.match(/(?:@theme|:root)\s*\{([^}]*)\}/)?.[1] ?? "";
    const match = rootBody.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]+)`));
    if (match) return match[1].toLowerCase();
    throw new Error(`Token ${name} missing for skin ${id}`);
  }
  const token = cssToken(id, name);
  if (token) return token;
  const rootBody = css.match(/(?:@theme|:root)\s*\{([^}]*)\}/)?.[1] ?? "";
  const rootMatch = rootBody.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]+)`));
  if (rootMatch) return rootMatch[1].toLowerCase();
  throw new Error(`Token ${name} missing for skin ${id}`);
}


describe("skins", () => {
  it("insets Claude bot replies only when Boxy geometry is active", () => {
    expect(css).toMatch(
      /:root\[data-shape="boxy"\]\[data-skin="claude"\]\s+\[data-orbit-message="bot"\] \[data-orbit-message-content\]\s*\{\s*padding-left:\s*12px;/,
    );
    const claude = css.match(/\[data-skin="claude"\] \[data-orbit-message="bot"\] \[data-orbit-message-content\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(claude).toContain("padding: 0;");
  });

  it("insets all added bot replies when Boxy geometry is active", () => {
    const boxy = css.match(
      /:root\[data-shape="boxy"\]:is\(([\s\S]*?)\)\s*\[data-orbit-message="bot"\][^{]+\{([^}]*)\}/,
    )?.[0] ?? "";
    const ids = ["precision", "notebook", "messenger", "community", "community-light", "code-review", "blueprint", "blueprint-gray", "blueprint-charcoal"];
    for (const id of ids) {
      expect(boxy).toContain(`[data-skin="${id}"]`);
    }
    expect(boxy).toContain("padding-left: 12px;");

    const boxyIndex = css.indexOf("/* Keep the rail-to-glyph gap after skin-specific bot padding rules. */");
    expect(boxyIndex).toBeGreaterThan(-1);
    for (const id of ids) {
      expect(boxyIndex).toBeGreaterThan(css.indexOf(`[data-skin="${id}"]`));
    }
  });

  it("gives every registered skin a stylesheet block", () => {
    for (const id of SKIN_IDS) expect(blocks).toContain(id);
  });

  it("registers every stylesheet block", () => {
    const registered = new Set<string>(SKIN_IDS);
    for (const id of blocks) expect(registered).toContain(id);
  });

  it("defines the same tokens in every skin", () => {
    // Midnight is the shared set. Light skins add --color-syntax-* on top;
    // those must not become a requirement for dark skins.
    const reference = tokensOf("midnight");
    expect(reference.size).toBeGreaterThan(15);
    for (const id of SKIN_IDS) {
      expect([...reference].filter((t) => !tokensOf(id).has(t))).toEqual([]);
    }
  });

  it("gives light skins and VS Code Dark a syntax palette and leaves other dark skins alone", () => {
    const roles = [
      "--color-syntax-fg",
      "--color-syntax-comment",
      "--color-syntax-keyword",
      "--color-syntax-string",
      "--color-syntax-function",
      "--color-syntax-constant",
      "--color-syntax-variable",
      "--color-syntax-tag",
      "--color-syntax-invalid",
    ];
    const remapped = [
      "atelier",
      "lagoon",
      "ledger",
      "vscode-dark",
      "notebook",
      "messenger",
      "community-light",
      "code-review",
      "blueprint",
      "wink-day",
    ];
    for (const id of remapped) {
      expect([...tokensOf(id)]).toEqual(expect.arrayContaining(roles));
    }
    for (const id of SKIN_IDS) {
      if (remapped.includes(id)) continue;
      expect([...tokensOf(id)].filter((t) => t.startsWith("--color-syntax-"))).toEqual([]);
    }
  });

  it("drives native input color-scheme from the skin, not a hardcoded dark utility", () => {
    const rootBody = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rootBody).toMatch(/color-scheme:\s*dark\s*;/);
    const light = ["atelier", "lagoon", "ledger", "notebook", "messenger", "community-light", "code-review", "blueprint", "wink-day"];
    for (const id of light) {
      const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body).toMatch(/color-scheme:\s*light\s*;/);
    }
    const components = join(dirname(fileURLToPath(import.meta.url)), "../components");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (readFileSync(p, "utf8").includes("[color-scheme:dark]")) hits.push(p);
      }
    };
    walk(components);
    expect(hits).toEqual([]);
  });

  it("drives remapped syntax contrast from github-dark-default emitted foregrounds", () => {
    const check = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../scripts/check-skin-contrast.mjs"),
      "utf8",
    );
    expect(check).toContain("github-dark-default");
    expect(check).toContain("tokenColors");
    expect(check).toContain("emittedForegrounds");
    expect(check).toContain('"vscode-dark"');
    expect(check).not.toContain("SYNTAX_ROLES");
  });

  it("defaults a fresh install to Precision and does not rename Atelier", () => {
    expect(DEFAULT_SKIN).toBe("precision");
    expect(SKINS.some((s) => s.id === "atelier" && s.name === "Atelier")).toBe(true);
    expect(SKIN_IDS).not.toContain("letelier");
  });

  it("gives every non-Midnight skin its own focus and control tokens", () => {
    // Midnight inherits Grok-blue --color-focus from @theme. A light skin
    // that skips the token wears that blue on stone, paper, or porcelain.
    for (const id of SKIN_IDS) {
      if (id === "midnight") continue;
      expect([...tokensOf(id)]).toEqual(expect.arrayContaining(["--color-focus", "--color-control"]));
    }
  });

  it("declares every color token the stylesheet reads without a fallback", () => {
    // An undeclared var() voids its whole declaration at computed-value time.
    const declared = new Set([...css.matchAll(/(--color-[\w-]+)\s*:/g)].map(([, name]) => name));
    const read = new Set([...css.matchAll(/var\((--color-[\w-]+)\s*\)/g)].map(([, name]) => name));
    expect([...read].filter((t) => !declared.has(t))).toEqual([]);
  });

  it("describes each skin exactly once", () => {
    expect(SKINS.map((s) => s.id).sort()).toEqual([...SKIN_IDS].sort());
    for (const skin of SKINS) {
      expect(skin.name.length).toBeGreaterThan(0);
      expect(skin.tagline.length).toBeGreaterThan(0);
    }
  });

  it("keeps provider model dots at full color in every skin", () => {
    const dotRules = [...css.matchAll(/\[data-sidebar-model-dot\][^{]*\{([^}]*)\}/g)];
    for (const [, body] of dotRules) expect(body).not.toMatch(/filter|opacity/);
  });
});

describe("Ledger", () => {
  it("is registered as a first-class skin", () => {
    expect(SKIN_IDS).toContain("ledger");
    expect(SKINS.some((s) => s.id === "ledger" && s.name === "Ledger")).toBe(true);
  });

  it("keeps the existing four skins and does not revive rejected ones", () => {
    for (const id of ["midnight", "atelier", "foundry", "lagoon"]) {
      expect(SKIN_IDS).toContain(id);
    }
    const ids: readonly string[] = SKIN_IDS;
    expect(ids).not.toContain("graphite");
    expect(ids).not.toContain("boreal");
    expect(css).not.toMatch(/\[data-skin="graphite"\]/);
  });

  it("is a neutral gray, distinct from Atelier's paper and Lagoon's porcelain", () => {
    const ledgerApp = cssToken("ledger", "--color-app");
    const atelierApp = cssToken("atelier", "--color-app");
    const lagoonApp = cssToken("lagoon", "--color-app");
    expect(ledgerApp).toBeTruthy();
    expect(ledgerApp).not.toBe(atelierApp);
    expect(ledgerApp).not.toBe(lagoonApp);
    expect(cssToken("ledger", "--color-accent")).not.toBe(cssToken("atelier", "--color-accent"));
    expect(cssToken("ledger", "--color-accent")).not.toBe(cssToken("lagoon", "--color-accent"));
    expect(cssToken("ledger", "--color-accent")).not.toBe("#a05f25");
    expect(cssToken("ledger", "--color-accent")).not.toBe("#11736d");
    // Channel spread is the tint: Atelier's cream and Lagoon's teal both
    // drift further from gray than Ledger's stone ground.
    expect(spread(ledgerApp!)).toBeLessThan(spread(atelierApp!));
    expect(spread(ledgerApp!)).toBeLessThan(spread(lagoonApp!));
  });

  it("keeps raised distinct from card so chips stay visible", () => {
    expect(cssToken("ledger", "--color-raised")).toBeTruthy();
    expect(cssToken("ledger", "--color-card")).toBeTruthy();
    expect(cssToken("ledger", "--color-raised")).not.toBe(cssToken("ledger", "--color-card"));
    expect(cssToken("ledger", "--color-control")).not.toBe(cssToken("ledger", "--color-card"));
    expect(cssToken("ledger", "--color-control")).not.toBe(cssToken("ledger", "--color-raised"));
  });

  it("ships the full light-skin token set, including focus", () => {
    const required = [
      "--color-app",
      "--color-panel",
      "--color-raised",
      "--color-raised-hover",
      "--color-card",
      "--color-inset",
      "--color-control",
      "--color-hairline",
      "--color-ink",
      "--color-ink-secondary",
      "--color-accent",
      "--color-accent-border",
      "--color-accent-text",
      "--color-accent-ink",
      "--color-focus",
      "--color-bubble-user",
      "--color-success",
      "--color-danger",
      "--color-danger-ink",
      "--color-warning",
      "--color-scrollbar",
      "--color-maus-line",
      "--font-sans",
      "--radius-lg",
      "--radius-xl",
    ];
    expect([...tokensOf("ledger")]).toEqual(expect.arrayContaining(required));
  });
});

describe("Community Light", () => {
  it("shares Community's open, wide replies on a light gray ground", () => {
    expect(css).toContain('@scope ([data-skin="community"], [data-skin="community-light"]) to ([data-skin])');
    expect(LIGHT_SKIN_IDS.has("community-light")).toBe(true);
    const app = cssToken("community-light", "--color-app")!;
    expect(luminance(app)).toBeGreaterThan(0.75);
    expect(spread(app)).toBeLessThanOrEqual(6);
  });
});

const EDITOR_DARK_SKINS = [
  {
    id: "vscode-dark",
    name: "VS Code Dark",
    tokens: {
      "--color-app": "#1e1e1e",
      "--color-panel": "#252526",
      "--color-inset": "#181818",
      "--color-ink": "#d4d4d4",
      "--color-accent": "#007acc",
      "--color-syntax-comment": "#6a9955",
      "--color-syntax-string": "#ce9178",
      "--color-syntax-constant": "#4fc1ff",
      "--color-syntax-tag": "#4ec9b0",
      "--color-syntax-function": "#dcdcaa",
    },
  },
  {
    id: "studio-gray",
    name: "Studio Gray",
    tokens: {
      "--color-app": "#242424",
      "--color-panel": "#303030",
      "--color-inset": "#1d1d1d",
      "--color-ink": "#e5e5e5",
      "--color-accent": "#7c9cff",
    },
  },
  {
    id: "steel-gray",
    name: "Steel Gray",
    tokens: {
      "--color-app": "#2b3038",
      "--color-panel": "#363c46",
      "--color-inset": "#22262d",
      "--color-ink": "#e2e8f0",
      "--color-accent": "#63d6be",
    },
  },
] as const;

describe("editor dark skins", () => {
  it("registers the optional palettes with their anchor tokens", () => {
    for (const skin of EDITOR_DARK_SKINS) {
      expect(SKIN_IDS).toContain(skin.id);
      expect(SKINS.some((s) => s.id === skin.id && s.name === skin.name)).toBe(true);
      for (const [token, value] of Object.entries(skin.tokens)) {
        expect(cssToken(skin.id, token)).toBe(value);
      }
    }
  });

  it("keeps VS Code Dark syntax accents readable on its editor inset", () => {
    const roles = [
      "--color-syntax-comment",
      "--color-syntax-string",
      "--color-syntax-constant",
      "--color-syntax-tag",
      "--color-syntax-function",
    ];
    const inset = cssToken("vscode-dark", "--color-inset")!;
    for (const role of roles) {
      expect(contrast(cssToken("vscode-dark", role)!, inset), role).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("Claude skin", () => {
  it("uses a warm near-black palette and unboxed serif bot replies", () => {
    expect(SKIN_IDS).toContain("claude");
    expect(SKINS.some((skin) => skin.id === "claude" && skin.name === "Claude")).toBe(true);
    expect(cssToken("claude", "--color-app")).toBe("#171615");
    expect(cssToken("claude", "--color-accent")).toBe("#d97757");
    expect(css).toMatch(/\[data-skin="claude"\]\s*\[data-orbit-message="bot"\][\s\S]*?background:\s*transparent/);
    expect(css).toMatch(/\[data-skin="claude"\]\s*\[data-orbit-message="bot"\][\s\S]*?Anthropic Serif/);
    expect(css).toMatch(/\[data-skin="claude"\]\s*\[data-orbit-message="user"\][\s\S]*?border:\s*1px solid var\(--color-hairline\)/);
  });
});

const BLUEPRINT_DARK_SKINS = [
  {
    id: "blueprint-gray",
    name: "Blueprint Gray",
    tokens: {
      "--color-app": "#3a414a",
      "--color-panel": "#414952",
      "--color-raised": "#4d5661",
      "--color-inset": "#30373f",
      "--color-ink": "#f1f5f9",
      "--color-ink-secondary": "#d8e0e8",
      "--color-accent": "#8db9e8",
    },
  },
  {
    id: "blueprint-charcoal",
    name: "Blueprint Charcoal",
    tokens: {
      "--color-app": "#1f252c",
      "--color-panel": "#282f37",
      "--color-raised": "#343c46",
      "--color-inset": "#181e24",
      "--color-ink": "#eef3f8",
      "--color-ink-secondary": "#b7c4d0",
      "--color-accent": "#82b5e6",
    },
  },
] as const;

describe("dark Blueprint skins", () => {
  it("registers each with a distinct dark drafting palette", () => {
    for (const skin of BLUEPRINT_DARK_SKINS) {
      expect(SKIN_IDS).toContain(skin.id);
      expect(SKINS.some((entry) => entry.id === skin.id && entry.name === skin.name)).toBe(true);
      for (const [token, value] of Object.entries(skin.tokens)) {
        expect(cssToken(skin.id, token)).toBe(value);
      }
      const body = css.match(new RegExp(`\\[data-skin="${skin.id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body).toMatch(/color-scheme:\s*dark/);
      expect(body).toContain('"Bahnschrift"');
    }
    expect(cssToken("blueprint-gray", "--color-app")).not.toBe(cssToken("blueprint-charcoal", "--color-app"));
  });

  it("keeps Blueprint message rules and monospace code treatment", () => {
    for (const id of ["blueprint-gray", "blueprint-charcoal"]) {
      expect(css).toMatch(new RegExp(`\\[data-skin="${id}"\\][\\s\\S]*?\\[data-orbit-message-content\\]`));
      expect(css).toContain(`[data-skin="${id}"]`);
    }
    expect(css).toContain("[data-orbit-message=\"bot\"] [data-orbit-message-content]");
    expect(css).toContain(".chat-md :is(code, pre)");
    expect(css).toContain('"Cascadia Mono", "Consolas", "Malgun Gothic", monospace');
  });
});

const FACE_SKINS = [
  { id: "instrument", name: "Instrument", face: "IBM Plex Sans", file: "IBMPlexSans-Variable.woff2", app: "#15181c" },
  { id: "matte", name: "Matte", face: "Nunito", file: "Nunito-Variable.woff2", app: "#1c1b19" },
  { id: "carbon", name: "Carbon", face: "JetBrains Mono", file: "JetBrainsMono-Variable.woff2", app: "#0b0c0d" },
  { id: "pewter", name: "Pewter", face: "Manrope", file: "Manrope-Variable.woff2", app: "#3a3d41" },
  { id: "coal", name: "Coal", face: "Space Grotesk", file: "SpaceGrotesk-Variable.woff2", app: "#121315" },
  { id: "folio", name: "Folio", face: "Literata", file: "Literata-Variable.woff2", app: "#232528" },
] as const;

describe("bundled-face skins", () => {
  const fonts = join(dirname(fileURLToPath(import.meta.url)), "../../public/fonts");

  it("registers each with its own bundled face first in the stack", () => {
    for (const skin of FACE_SKINS) {
      expect(SKINS.some((entry) => entry.id === skin.id && entry.name === skin.name)).toBe(true);
      expect(cssToken(skin.id, "--color-app")).toBe(skin.app);
      const body = css.match(new RegExp(`\\[data-skin="${skin.id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body, skin.id).toMatch(new RegExp(`--font-sans:\\s*"${skin.face}"`));
      expect(css).toContain(`font-family: "${skin.face}";\n  src: url("/fonts/${skin.file}") format("woff2");`);
      expect(readdirSync(fonts)).toContain(skin.file);
    }
  });

  it("gives each a different card geometry", () => {
    const radii = FACE_SKINS.map((skin) => css.match(new RegExp(`\\[data-skin="${skin.id}"\\]\\s*\\{[^}]*--radius-lg:\\s*([^;]+);`))?.[1]);
    expect(new Set(radii).size).toBe(FACE_SKINS.length);
    for (const skin of FACE_SKINS) {
      expect(css, skin.id).toMatch(new RegExp(`@scope \\([^)]*\\[data-skin="${skin.id}"\\][^)]*\\) to \\(\\[data-skin\\]\\)`));
    }
  });

  it("keeps chat ink at AA on every surface and accent fills readable", () => {
    for (const skin of FACE_SKINS) {
      const ink = cssToken(skin.id, "--color-ink")!;
      const secondary = cssToken(skin.id, "--color-ink-secondary")!;
      for (const surface of ["--color-app", "--color-card", "--color-bubble-user", "--color-inset", "--color-control"]) {
        expect(contrast(ink, cssToken(skin.id, surface)!), `${skin.id} ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(secondary, cssToken(skin.id, surface)!), `${skin.id} ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(cssToken(skin.id, "--color-accent-ink")!, cssToken(skin.id, "--color-accent")!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(cssToken(skin.id, "--color-danger-ink")!, cssToken(skin.id, "--color-danger")!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("steps Pewter Dusk and Pewter Night down from Pewter's palette only", () => {
    const pewter = SKIN_IDS.indexOf("pewter");
    expect(SKIN_IDS.slice(pewter, pewter + 3)).toEqual(["pewter", "pewter-dusk", "pewter-night"]);
    const shared = sharedBodies("pewter");
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatch(/--font-sans:\s*"Manrope"/);
    expect(css).toContain('@scope ([data-skin="pewter"], [data-skin="pewter-dusk"], [data-skin="pewter-night"]) to ([data-skin])');
    let lighter = cssToken("pewter", "--color-app")!;
    for (const id of ["pewter-dusk", "pewter-night"]) {
      expect(sharedBodies(id), id).toEqual(shared);
      expect(DEFAULT_SKIN).not.toBe(id);
      const own = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))![1];
      expect([...own.matchAll(/(--[\w-]+)\s*:/g)].every(([, name]) => name.startsWith("--color-")), id).toBe(true);
      const app = cssToken(id, "--color-app")!;
      expect(app).not.toBe("#000000");
      expect(luminance(app)).toBeLessThan(luminance(lighter));
      expect(spread(app), id).toBeLessThanOrEqual(12);
      expect(spread(cssToken(id, "--color-accent")!), id).toBeLessThanOrEqual(64);
      for (const text of ["--color-ink", "--color-ink-secondary", "--color-accent-text"]) {
        for (const surface of ["--color-app", "--color-panel", "--color-card", "--color-bubble-user", "--color-inset", "--color-control", "--color-raised"]) {
          expect(contrast(cssToken(id, text)!, cssToken(id, surface)!), `${id} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(cssToken(id, "--color-accent-ink")!, cssToken(id, "--color-accent")!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(cssToken(id, "--color-danger-ink")!, cssToken(id, "--color-danger")!)).toBeGreaterThanOrEqual(4.5);
      lighter = app;
    }
  });

  it("keeps Coal a soft black under raised gray cards", () => {
    const app = cssToken("coal", "--color-app")!;
    expect(app).not.toBe("#000000");
    expect(luminance(app)).toBeGreaterThan(luminance("#0e0e0e"));
    expect(luminance(app)).toBeLessThan(luminance("#161616"));
    expect(contrast(cssToken("coal", "--color-card")!, app)).toBeGreaterThan(1.1);
  });

  it("keeps accents and grounds low-chroma", () => {
    for (const skin of FACE_SKINS) {
      expect(spread(cssToken(skin.id, "--color-accent")!), skin.id).toBeLessThanOrEqual(64);
      expect(spread(cssToken(skin.id, "--color-app")!), skin.id).toBeLessThanOrEqual(12);
    }
  });
});

const WINK_SKINS = [
  { id: "wink", name: "Wink", face: "Space Grotesk", file: "SpaceGrotesk-Variable.woff2", lead: "#ff4d9d", caret: "#ffd447" },
  { id: "wink-cyber", name: "Wink Cyber", face: "IBM Plex Sans", file: "IBMPlexSans-Variable.woff2", lead: "#38d8ff", caret: "#aaff5a" },
  { id: "wink-violet", name: "Wink Violet", face: "Nunito", file: "Nunito-Variable.woff2", lead: "#a770ff", caret: "#6ef0be" },
  { id: "wink-black", name: "Wink Black", face: "JetBrains Mono", file: "JetBrainsMono-Variable.woff2", lead: "#ffd447", caret: "#ff4d9d" },
  { id: "wink-day", name: "Wink Day", face: "Manrope", file: "Manrope-Variable.woff2", lead: "#c81e69", caret: "var(--color-accent)" },
] as const;

const WINK_NAVY = ["wink", "wink-cyber", "wink-violet"];

describe("Wink family", () => {
  const fonts = join(dirname(fileURLToPath(import.meta.url)), "../../public/fonts");

  it("leads the picker without changing the default", () => {
    expect(SKIN_IDS.slice(0, 5)).toEqual(WINK_SKINS.map((s) => s.id));
    expect(SKINS.slice(0, 5).map((s) => s.name)).toEqual(WINK_SKINS.map((s) => s.name));
    expect(DEFAULT_SKIN).toBe("precision");
  });

  it("sets each in its own bundled face with its lead and caret", () => {
    for (const skin of WINK_SKINS) {
      const body = css.match(new RegExp(`\\[data-skin="${skin.id}"\\]\\s*\\{([^}]*)\\}`))![1];
      expect(body, skin.id).toMatch(new RegExp(`--font-sans:\\s*"${skin.face}"`));
      expect(readdirSync(fonts)).toContain(skin.file);
      expect(cssToken(skin.id, "--color-accent")).toBe(skin.lead);
      expect(css, skin.id).toContain(`[data-skin="${skin.id}"] :is(input, textarea) { caret-color: ${skin.caret}; }`);
    }
    expect(cssToken("wink", "--color-focus")).toBe("#ffd447");
    expect(cssToken("wink-cyber", "--color-focus")).toBe("#aaff5a");
    expect(cssToken("wink-violet", "--color-focus")).toBe("#6ef0be");
    expect(cssToken("wink-black", "--color-focus")).toBe("#ff4d9d");
    expect(css).toMatch(/\[data-skin="wink-day"\] ::selection \{\s*background: #ffe27a;/);
  });

  it("keeps Wink, Cyber, and Violet on the icon navy, Wink Black true black, Wink Day light", () => {
    expect(css).toContain('@scope ([data-skin="wink"], [data-skin="wink-cyber"], [data-skin="wink-violet"]) to ([data-skin])');
    for (const id of WINK_NAVY) {
      const { r, g, b } = channels(cssToken(id, "--color-app")!);
      expect(b - r, id).toBeGreaterThanOrEqual(12);
      expect(b - g, id).toBeGreaterThanOrEqual(10);
      for (const token of ["--color-app", "--color-card", "--color-raised", "--color-hairline", "--color-bubble-user"]) {
        expect(cssToken(id, token), `${id} ${token}`).toBe(cssToken("wink", token));
      }
      expect(spread(cssToken(id, "--color-accent")!), id).toBeGreaterThan(140);
    }
    expect(cssToken("wink-black", "--color-app")).toBe("#000000");
    expect(luminance(cssToken("wink-day", "--color-app")!)).toBeGreaterThan(0.85);
    for (const other of ["hurtado", "tui-amber", "midnight", "tokyo-night"]) {
      for (const skin of WINK_SKINS) {
        expect(cssToken(skin.id, "--color-accent"), `${skin.id} vs ${other}`).not.toBe(cssToken(other, "--color-accent"));
      }
    }
    expect(css).toMatch(/\[data-skin="wink-black"\] \{[^}]*--radius-lg: 10px;/);
  });

  it("keeps chat text at AA and fills readable at rest and on hover", () => {
    for (const { id } of WINK_SKINS) {
      for (const text of ["--color-ink", "--color-ink-secondary", "--color-accent-text"]) {
        for (const surface of ["--color-app", "--color-panel", "--color-card", "--color-bubble-user", "--color-inset", "--color-control", "--color-raised", "--color-raised-hover"]) {
          expect(contrast(cssToken(id, text)!, cssToken(id, surface)!), `${id} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const [ink, fill] of [["--color-accent-ink", "--color-accent"], ["--color-danger-ink", "--color-danger"]]) {
        const [i, f] = [cssToken(id, ink)!, cssToken(id, fill)!];
        expect(contrast(i, f), `${id} ${fill}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(brightness110(i), brightness110(f)), `${id} ${fill} hover`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(cssToken(id, "--color-focus")!, cssToken(id, "--color-app")!), id).toBeGreaterThanOrEqual(3);
    }
  });

  it("derives terminal colors from each palette", () => {
    for (const { id } of WINK_SKINS) {
      const theme = terminalTheme((name) => skinToken(id, `--color-${name}`));
      expect(theme.background).toBe(cssToken(id, "--color-inset"));
      expect(theme.foreground).toBe(cssToken(id, "--color-ink"));
      expect(theme.cursor).toBe(cssToken(id, "--color-accent-text"));
    }
    const day = terminalTheme((name) => skinToken("wink-day", `--color-${name}`));
    expect(day.red).toBe(cssToken("wink-day", "--color-syntax-keyword"));
  });
});

const DARK_INK_SKINS = [
  {
    id: "catppuccin-frappe",
    name: "Catppuccin Frappe",
    tokens: {
      "--color-app": "#303446",
      "--color-raised": "#363a4f",
      "--color-ink": "#c6d0f5",
      "--color-ink-secondary": "#b5bfe2",
      "--color-accent": "#a6d189",
      "--color-hairline": "#626880",
      "--color-danger": "#e78284",
      "--color-success": "#a6d189",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    tokens: {
      "--color-app": "#1a1b26",
      "--color-raised": "#24283b",
      "--color-ink": "#c0caf5",
      "--color-ink-secondary": "#a9b1d6",
      "--color-accent": "#7aa2f7",
      "--color-hairline": "#3b4261",
      "--color-danger": "#f7768e",
      "--color-success": "#9ece6a",
    },
  },
  {
    id: "vesper",
    name: "Vesper",
    tokens: {
      "--color-app": "#101010",
      "--color-raised": "#1c1c1c",
      "--color-ink": "#ffffff",
      "--color-ink-secondary": "#a0a0a0",
      "--color-accent": "#ffc799",
      "--color-hairline": "#363636",
      "--color-danger": "#ff8080",
      "--color-success": "#99ffe4",
    },
  },
  {
    id: "onyx",
    name: "Onyx",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#141414",
      "--color-ink": "#e8e6e3",
      "--color-ink-secondary": "#a8a6a3",
      "--color-accent": "#bb9af7",
      "--color-hairline": "#2d2d2d",
      "--color-danger": "#f2655f",
      "--color-success": "#73daca",
    },
  },
  {
    id: "peach",
    name: "Peach",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#13151a",
      "--color-ink": "#eceef2",
      "--color-ink-secondary": "#a6abb5",
      "--color-accent": "#ffd3b6",
      "--color-hairline": "#2a2d35",
      "--color-danger": "#ff7d7d",
      "--color-success": "#7fe0c9",
    },
  },
  {
    id: "coral",
    name: "Coral",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#141414",
      "--color-ink": "#ebe8e7",
      "--color-ink-secondary": "#aaa6a5",
      "--color-accent": "#ff8b85",
      "--color-hairline": "#2d2d2d",
      "--color-danger": "#f04a4a",
      "--color-success": "#7bdcb5",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    tokens: {
      "--color-app": "#282a36",
      "--color-raised": "#343746",
      "--color-ink": "#f8f8f2",
      "--color-ink-secondary": "#a4abcc",
      "--color-accent": "#bd93f9",
      "--color-hairline": "#44475a",
      "--color-danger": "#ff6b6b",
      "--color-success": "#50fa7b",
    },
  },
  {
    id: "cobalt",
    name: "Panda Syntax",
    tokens: {
      "--color-app": "#292a2b",
      "--color-raised": "#373b41",
      "--color-ink": "#e6e6e6",
      "--color-ink-secondary": "#bcaafe",
      "--color-accent": "#19f9d8",
      "--color-hairline": "#4a4e5c",
      "--color-danger": "#ff75b5",
      "--color-success": "#6fe7d2",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    tokens: {
      "--color-app": "#282828",
      "--color-raised": "#46413e",
      "--color-ink": "#ebdbb2",
      "--color-ink-secondary": "#d5c4a1",
      "--color-accent": "#fe8019",
      "--color-hairline": "#7c6f64",
      "--color-danger": "#ff8f85",
      "--color-success": "#b8bb26",
    },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    tokens: {
      "--color-app": "#191724",
      "--color-raised": "#26233a",
      "--color-ink": "#e0def4",
      "--color-ink-secondary": "#918daa",
      "--color-accent": "#c4a7e7",
      "--color-hairline": "#403d52",
      "--color-danger": "#eb6f92",
      "--color-success": "#9ccfd8",
    },
  },
  {
    id: "nord",
    name: "Nord",
    tokens: {
      "--color-app": "#2e3440",
      "--color-raised": "#434c5e",
      "--color-ink": "#eceff4",
      "--color-ink-secondary": "#d8dee9",
      "--color-accent": "#88c0d0",
      "--color-hairline": "#4c566a",
      "--color-danger": "#ff9aa3",
      "--color-success": "#a3be8c",
    },
  },
  {
    id: "github-dimmed",
    name: "GitHub Dimmed",
    tokens: {
      "--color-app": "#22272e",
      "--color-raised": "#373e47",
      "--color-ink": "#cdd9e5",
      "--color-ink-secondary": "#b0bdca",
      "--color-accent": "#539bf5",
      "--color-hairline": "#444c56",
      "--color-danger": "#ff7b72",
      "--color-success": "#58ad5b",
    },
  },
  {
    id: "tui",
    name: "TUI",
    tokens: {
      "--color-app": "#0c0c0c",
      "--color-raised": "#1a1a1a",
      "--color-ink": "#cccccc",
      "--color-ink-secondary": "#a0a0a0",
      "--color-accent": "#13a8a8",
      "--color-hairline": "#3a3a3a",
      "--color-danger": "#ff6b6b",
      "--color-success": "#3dd6d6",
    },
  },
  {
    id: "tui-black",
    name: "TUI Black",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#141414",
      "--color-ink": "#c8c8c8",
      "--color-ink-secondary": "#9a9a9a",
      "--color-accent": "#13a8a8",
      "--color-hairline": "#2d2d2d",
      "--color-danger": "#ff6b6b",
      "--color-success": "#3dd6d6",
    },
  },
  {
    id: "tui-amber",
    name: "TUI Amber",
    tokens: {
      "--color-app": "#1a1a1a",
      "--color-raised": "#2c2c2c",
      "--color-ink": "#dedcd7",
      "--color-ink-secondary": "#aaa7a0",
      "--color-accent": "#d6b779",
      "--color-hairline": "#3d3d3d",
      "--color-danger": "#ff6b6b",
      "--color-success": "#dedcd7",
    },
  },
  {
    id: "tui-ice",
    name: "TUI Ice",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#101418",
      "--color-ink": "#c8dce8",
      "--color-ink-secondary": "#8aa8b8",
      "--color-accent": "#7dcfff",
      "--color-hairline": "#243038",
      "--color-danger": "#ff6b6b",
      "--color-success": "#73daca",
    },
  },
  {
    id: "tui-slate",
    name: "TUI Slate",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#16161a",
      "--color-ink": "#c4c4cc",
      "--color-ink-secondary": "#8a8a94",
      "--color-accent": "#c8c8d0",
      "--color-hairline": "#2e2e36",
      "--color-danger": "#ff6b6b",
      "--color-success": "#c4c4cc",
    },
  },
  {
    id: "tui-smoke",
    name: "TUI Smoke",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#181614",
      "--color-ink": "#c8c4bc",
      "--color-ink-secondary": "#8a8680",
      "--color-accent": "#a39e96",
      "--color-hairline": "#322e28",
      "--color-danger": "#ff6b6b",
      "--color-success": "#c8c4bc",
    },
  },
] as const;

describe("dark ink skins", () => {
  it("registers each as a first-class dark skin", () => {
    for (const skin of DARK_INK_SKINS) {
      expect(SKIN_IDS).toContain(skin.id);
      expect(SKINS.some((s) => s.id === skin.id && s.name === skin.name)).toBe(true);
    }
  });

  it("keeps the existing light skins", () => {
    for (const id of ["atelier", "lagoon", "ledger"]) {
      expect(SKIN_IDS).toContain(id);
    }
  });

  it("ships the given palette tokens exactly", () => {
    for (const skin of DARK_INK_SKINS) {
      for (const [token, value] of Object.entries(skin.tokens)) {
        expect(cssToken(skin.id, token)).toBe(value);
      }
    }
  });

  it("gives each dark skin a raised surface distinct from its panel background", () => {
    for (const skin of DARK_INK_SKINS) {
      const panel = cssToken(skin.id, "--color-panel");
      const raised = cssToken(skin.id, "--color-raised");
      expect(raised).not.toBe(panel);
    }
  });

  it("puts each skin's ground on accent and danger fills, not Midnight white", () => {
    for (const skin of DARK_INK_SKINS) {
      const bg = skin.tokens["--color-app"];
      expect(cssToken(skin.id, "--color-accent-ink")).toBe(bg);
      expect(cssToken(skin.id, "--color-danger-ink")).toBe(bg);
      expect(cssToken(skin.id, "--color-accent-ink")).not.toBe("#ffffff");
      expect(cssToken(skin.id, "--color-danger-ink")).not.toBe("#ffffff");
    }
  });

  it("gives every TUI skin zero radius and a monospace stack", () => {
    for (const id of ["tui", "tui-black", "tui-amber", "tui-ice", "tui-slate", "tui-smoke"]) {
      const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body, id).toMatch(/--radius-lg:\s*0px/);
      expect(body, id).toMatch(/--radius-xl:\s*0px/);
      expect(body, id).toMatch(/ui-monospace/);
      expect(body, id).not.toMatch(/"Inter"/);
    }
  });

  it("gives Onyx ice links and peach warning, not silver chrome", () => {
    expect(cssToken("onyx", "--color-accent-text")).toBe("#7dcfff");
    expect(cssToken("onyx", "--color-warning")).toBe("#ff9e64");
    expect(cssToken("onyx", "--color-accent")).toBe("#bb9af7");
    expect(cssToken("onyx", "--color-accent")).not.toBe("#e4e4e7");
  });

  it("keeps Onyx ground true-black and ink off-white", () => {
    expect(cssToken("onyx", "--color-app")).toBe("#000000");
    expect(cssToken("onyx", "--color-ink")).toBe("#e8e6e3");
    expect(cssToken("onyx", "--color-ink")).not.toBe("#ffffff");
    expect(cssToken("onyx", "--color-ink")).not.toBe("#ededf0");
  });

  it("keeps Peach lighter and colder than Vesper, and Coral distinct from its danger", () => {
    expect(luminance(cssToken("peach", "--color-accent")!)).toBeGreaterThan(luminance(cssToken("vesper", "--color-accent")!));
    expect(cssToken("peach", "--color-app")).toBe("#000000");
    expect(cssToken("coral", "--color-app")).toBe("#000000");
    expect(cssToken("coral", "--color-danger")).not.toBe(cssToken("coral", "--color-accent"));
  });

  it("derives Peach and Coral terminal colors from the shipped palette", () => {
    for (const id of ["peach", "coral"]) {
      const theme = terminalTheme((name) => cssToken(id, `--color-${name}`) ?? "");
      expect(theme.background).toBe("#000000");
      expect(theme.cursor).toBe(cssToken(id, "--color-accent-text"));
      expect(theme.foreground).toBe(cssToken(id, "--color-ink"));
    }
  });

  it("keeps chat ink and accent text at AA on every Peach and Coral surface", () => {
    for (const id of ["peach", "coral"]) {
      for (const text of ["--color-ink", "--color-ink-secondary", "--color-accent-text", "--color-danger", "--color-success", "--color-warning"]) {
        for (const surface of ["--color-app", "--color-panel", "--color-card", "--color-bubble-user", "--color-inset", "--color-control", "--color-raised"]) {
          expect(contrast(cssToken(id, text)!, cssToken(id, surface)!), `${id} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(cssToken(id, "--color-accent-ink")!, cssToken(id, "--color-accent")!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives Panda a warning apricot distinct from the mint accent", () => {
    const warning = cssToken("cobalt", "--color-warning");
    const accent = cssToken("cobalt", "--color-accent");
    expect(warning).toBe("#ffb86c");
    expect(accent).toBe("#19f9d8");
    expect(warning).not.toBe(accent);
  });

  it("gives Panda a light-green success distinct from the mint accent", () => {
    const success = cssToken("cobalt", "--color-success");
    const accent = cssToken("cobalt", "--color-accent");
    expect(success).toBe("#6fe7d2");
    expect(accent).toBe("#19f9d8");
    expect(success).not.toBe(accent);
  });

  it("maintains WCAG AA contrast on danger fills in all dark skins", () => {
    for (const skin of DARK_INK_SKINS) {
      const danger = cssToken(skin.id, "--color-danger")!;
      const ink = cssToken(skin.id, "--color-danger-ink")!;
      expect(contrast(ink, danger)).toBeGreaterThanOrEqual(4.5);
    }
  });

  const DANGER_PAIRINGS = [
    {
      file: "src/components/EnginesSettings.tsx",
      snippet: "border border-danger/40 px-3 py-1.5 text-[13px] text-danger hover:bg-raised/40",
      textToken: "--color-danger",
      surfaceToken: "--color-card",
    },
    {
      file: "src/components/GroupView.tsx",
      snippet: "rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]",
      textToken: "--color-danger",
      surfaceToken: "--color-panel",
    },
    {
      file: "src/components/Sidebar.tsx",
      snippet: "text-danger hover:bg-raised/40",
      textToken: "--color-danger",
      surfaceToken: "--color-card",
    },
    {
      file: "src/components/ApiKeys.tsx",
      snippet: "bg-danger text-danger-ink hover:brightness-110",
      textToken: "--color-danger-ink",
      surfaceToken: "--color-danger",
    },
  ] as const;

  it("gives ApiKeys clear buttons and danger pairings WCAG AA contrast", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
    for (const row of DANGER_PAIRINGS) {
      const source = readFileSync(join(repoRoot, row.file), "utf8");
      expect.soft(source).toContain(row.snippet);
    }

    const engines = DANGER_PAIRINGS.find((p) => p.file.endsWith("EnginesSettings.tsx"))!;
    const chip = DANGER_PAIRINGS.find((p) => p.file.endsWith("GroupView.tsx"))!;
    const clear = DANGER_PAIRINGS.find((p) => p.file.endsWith("ApiKeys.tsx"))!;

    // Rest surface in gruvbox: EnginesSettings on raised, RoomToolChip on panel
    expect.soft(contrast(cssToken("gruvbox", engines.textToken)!, cssToken("gruvbox", engines.surfaceToken)!)).toBeGreaterThanOrEqual(4.5);
    expect.soft(contrast(cssToken("gruvbox", chip.textToken)!, cssToken("gruvbox", chip.surfaceToken)!)).toBeGreaterThanOrEqual(4.5);

    // bg-danger with text-danger-ink in gruvbox and catppuccin-frappe, both at rest and on hover
    const gruvFill = cssToken("gruvbox", clear.surfaceToken)!;
    const gruvInk = cssToken("gruvbox", clear.textToken)!;
    expect.soft(contrast(gruvInk, gruvFill)).toBeGreaterThanOrEqual(4.5);
    expect.soft(contrast(brightness110(gruvInk), brightness110(gruvFill))).toBeGreaterThanOrEqual(4.5);

    const frappeFill = cssToken("catppuccin-frappe", clear.surfaceToken)!;
    const frappeInk = cssToken("catppuccin-frappe", clear.textToken)!;
    expect.soft(contrast(frappeInk, frappeFill)).toBeGreaterThanOrEqual(4.5);
    expect.soft(contrast(brightness110(frappeInk), brightness110(frappeFill))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps red danger text readable at rest and on hover across all skins", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const allSkins = ["default", ...SKIN_IDS];

    const enginesSrc = readFileSync(join(repoRoot, "src/components/EnginesSettings.tsx"), "utf8");
    const sidebarSrc = readFileSync(join(repoRoot, "src/components/Sidebar.tsx"), "utf8");
    const taskSrc = readFileSync(join(repoRoot, "src/components/TaskPicker.tsx"), "utf8");
    const avatarSrc = readFileSync(join(repoRoot, "src/components/BotProfileAvatarCard.tsx"), "utf8");
    const compSrc = readFileSync(join(repoRoot, "src/components/CompanionSection.tsx"), "utf8");

    const enginesIdx = enginesSrc.indexOf("engines.saveAnyway");
    expect(enginesIdx, "engines.saveAnyway found in EnginesSettings.tsx").toBeGreaterThanOrEqual(0);
    const enginesSlice = enginesSrc.slice(enginesSrc.lastIndexOf("<button", enginesIdx), enginesIdx);

    const deleteChannelIdx = sidebarSrc.indexOf("chrome.deleteChannel");
    expect(deleteChannelIdx, "chrome.deleteChannel found in Sidebar.tsx").toBeGreaterThanOrEqual(0);
    const deleteChannelSlice = sidebarSrc.slice(sidebarSrc.lastIndexOf("<button", deleteChannelIdx), deleteChannelIdx);

    const removeFromContextIdx = sidebarSrc.indexOf("chrome.removeFromContext");
    expect(removeFromContextIdx, "chrome.removeFromContext found in Sidebar.tsx").toBeGreaterThanOrEqual(0);
    const removeFromContextSlice = sidebarSrc.slice(sidebarSrc.lastIndexOf("<button", removeFromContextIdx), removeFromContextIdx);

    const deleteIdx = sidebarSrc.indexOf('"chrome.delete"');
    expect(deleteIdx, "chrome.delete found in Sidebar.tsx").toBeGreaterThanOrEqual(0);
    const itemIdx = sidebarSrc.lastIndexOf("const item", deleteIdx);
    expect(itemIdx, "item() definition found before chrome.delete in Sidebar.tsx").toBeGreaterThanOrEqual(0);
    const buttonEnd = sidebarSrc.indexOf("</button>", itemIdx);
    const itemEnd = sidebarSrc.indexOf(");", buttonEnd);
    const itemSlice = sidebarSrc.slice(itemIdx, itemEnd + 2);

    function textHoverSurface(slice: string, danger: string, card: string, raised: string, raisedHover: string): string {
      if (slice.includes("hover:bg-raised/40")) return blend(raised, card, 0.4);
      if (slice.includes("hover:bg-danger/10")) return blend(danger, card, 0.1);
      if (slice.includes("hover:bg-raised/70")) return blend(raised, card, 0.7);
      if (slice.includes("hover:bg-raised-hover")) return raisedHover;
      throw new Error(`Unknown hover class in slice: ${slice}`);
    }

    for (const skin of allSkins) {
      const danger = skinToken(skin, "--color-danger");
      const card = skinToken(skin, "--color-card");
      const raised = skinToken(skin, "--color-raised");
      const raisedHover = skinToken(skin, "--color-raised-hover");
      const control = skinToken(skin, "--color-control");
      const inset = skinToken(skin, "--color-inset");

      // 1. EnginesSettings "engines.saveAnyway"
      const enginesRest = /(?<!hover:)bg-raised\b/.test(enginesSlice) ? raised : card;
      const enginesHover = textHoverSurface(enginesSlice, danger, card, raised, raisedHover);
      expect.soft(contrast(danger, enginesRest), `${skin} EnginesSettings rest`).toBeGreaterThanOrEqual(4.5);
      expect.soft(contrast(danger, enginesHover), `${skin} EnginesSettings hover`).toBeGreaterThanOrEqual(4.5);

      // 2. Sidebar "chrome.deleteChannel"
      const deleteChannelRest = /(?<!hover:)bg-raised\b/.test(deleteChannelSlice) ? raised : card;
      const deleteChannelHover = textHoverSurface(deleteChannelSlice, danger, card, raised, raisedHover);
      expect.soft(contrast(danger, deleteChannelRest), `${skin} Sidebar deleteChannel rest`).toBeGreaterThanOrEqual(4.5);
      expect.soft(contrast(danger, deleteChannelHover), `${skin} Sidebar deleteChannel hover`).toBeGreaterThanOrEqual(4.5);

      // 3. Sidebar "chrome.removeFromContext"
      const removeContextRest = /(?<!hover:)bg-raised\b/.test(removeFromContextSlice) ? raised : card;
      const removeContextHover = textHoverSurface(removeFromContextSlice, danger, card, raised, raisedHover);
      expect.soft(contrast(danger, removeContextRest), `${skin} Sidebar removeFromContext rest`).toBeGreaterThanOrEqual(4.5);
      expect.soft(contrast(danger, removeContextHover), `${skin} Sidebar removeFromContext hover`).toBeGreaterThanOrEqual(4.5);

      // 4. Sidebar "chrome.delete" (the item() row)
      const deleteRest = card;
      const deleteHover = itemSlice.includes("opts?.danger") && itemSlice.includes("hover:bg-raised/40")
        ? blend(raised, card, 0.4)
        : textHoverSurface(itemSlice, danger, card, raised, raisedHover);
      expect.soft(contrast(danger, deleteRest), `${skin} Sidebar chrome.delete rest`).toBeGreaterThanOrEqual(4.5);
      expect.soft(contrast(danger, deleteHover), `${skin} Sidebar chrome.delete hover`).toBeGreaterThanOrEqual(4.5);

      // Icon-only control 1: TaskPicker delete button
      const taskHover = taskSrc.includes("hover:bg-danger/10") ? blend(danger, card, 0.1) : raised;
      expect.soft(contrast(danger, taskHover), `${skin} TaskPicker hover`).toBeGreaterThanOrEqual(3.0);

      // Icon-only control 2: BotProfileAvatarCard remove button
      const avatarHover = avatarSrc.includes("hover:bg-danger/10") ? blend(danger, card, 0.1) : control;
      expect.soft(contrast(danger, avatarHover), `${skin} BotProfileAvatarCard hover`).toBeGreaterThanOrEqual(3.0);

      // Icon-only control 3: CompanionSection remove button
      const compHover = compSrc.includes("hover:bg-danger/10") ? blend(danger, inset, 0.1) : control;
      expect.soft(contrast(danger, compHover), `${skin} CompanionSection hover`).toBeGreaterThanOrEqual(3.0);
    }
  });


  it("maintains WCAG AA contrast between secondary ink and controls in dark skins", () => {
    for (const skin of DARK_INK_SKINS) {
      const secondary = cssToken(skin.id, "--color-ink-secondary")!;
      const control = cssToken(skin.id, "--color-control")!;
      expect(contrast(secondary, control)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("Boxy shape", () => {
  // Extracts one rule's { declarations } at a time, tracking brace depth so it
  // also works inside @scope/@media wrappers without matching their own braces.
  function balancedBody(source: string, openBraceIdx: number): string {
    let depth = 0;
    for (let i = openBraceIdx; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) return source.slice(openBraceIdx + 1, i);
      }
    }
    throw new Error("unbalanced braces in styles.css");
  }

  function flatRules(body: string): { selector: string; declarations: string }[] {
    return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, declarations]) => ({
      selector: selector.trim(),
      declarations,
    }));
  }

  it("leaves no theme-scoped radius rule able to escape Boxy", () => {
    // Comments (which may contain commas) would otherwise bleed into the
    // selector text a regex captures right after them.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

    // The only radius Boxy is allowed to leave alone: a decoration that was
    // never a corner in the first place (the choice-signal selection dot).
    const exempt = ["[data-choice-signal]"];

    const boxyScopeStart = stripped.indexOf('@scope (:root[data-shape="boxy"]) to ([data-skin])');
    expect(boxyScopeStart).toBeGreaterThan(-1);
    const boxyBody = balancedBody(stripped, stripped.indexOf("{", boxyScopeStart));
    const squared = new Set(
      flatRules(boxyBody)
        .filter((r) => /border-radius:\s*0\s*!important/.test(r.declarations))
        .flatMap((r) => r.selector.split(",").map((s) => s.trim())),
    );

    const offenders: string[] = [];
    const checkRadius = (selector: string, declarations: string) => {
      if (exempt.some((token) => selector.includes(token))) return;
      const decls = declarations.match(/border-[\w-]*radius\s*:\s*[^;]+;/g) ?? [];
      for (const decl of decls) {
        if (/:\s*0(px)?\s*;/.test(decl)) continue;
        if (![...squared].some((token) => selector.endsWith(token))) {
          offenders.push(`${selector} { ${decl.trim()} }`);
        }
      }
    };

    // Flat, skin-prefixed rules (e.g. `[data-skin="messenger"] [data-orbit-message-content]`).
    for (const { selector, declarations } of flatRules(stripped)) {
      if (selector.includes("[data-skin=")) checkRadius(selector, declarations);
    }

    // Rules nested in a per-skin `@scope ([data-skin="x"]) { ... }` block, whose
    // own selectors (e.g. `.chat-md blockquote`) never repeat the skin attribute.
    const scopeRe = /@scope\s*\(([^)]*)\)[^{]*\{/g;
    let m: RegExpExecArray | null;
    while ((m = scopeRe.exec(stripped))) {
      if (!m[1].includes("[data-skin=")) continue;
      const body = balancedBody(stripped, stripped.indexOf("{", m.index));
      for (const { selector, declarations } of flatRules(body)) {
        checkRadius(selector, declarations);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("skin persistence", () => {
  const store = new Map<string, string>();
  const dataset = { skin: "" };
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  beforeEach(() => {
    store.clear();
    dataset.skin = "";
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stamps data-skin and remembers the choice under omb-skin", () => {
    applySkin("ledger");
    expect(dataset.skin).toBe("ledger");
    expect(store.get("omb-skin")).toBe("ledger");
    expect(readSkin()).toBe("ledger");
  });

  it("remembers Peach and Coral and restores them for the next session", () => {
    for (const id of ["peach", "coral"] as const) {
      applySkin(id);
      expect(dataset.skin).toBe(id);
      expect(store.get("omb-skin")).toBe(id);
      expect(readSkin()).toBe(id);
    }
  });

  it("falls back to the default skin for removed Haxor and Seaglass", () => {
    for (const id of ["haxor-blue", "seaglass"]) {
      store.set("omb-skin", id);
      expect(readSkin()).toBe(DEFAULT_SKIN);
    }
  });

  it("remembers Pewter, Coal, and Folio", () => {
    for (const id of ["pewter", "pewter-dusk", "pewter-night", "coal", "folio"] as const) {
      applySkin(id);
      expect(dataset.skin).toBe(id);
      expect(store.get("omb-skin")).toBe(id);
      expect(readSkin()).toBe(id);
    }
  });

  it("remembers the Wink family", () => {
    for (const id of ["wink", "wink-cyber", "wink-violet", "wink-black", "wink-day"] as const) {
      applySkin(id);
      expect(dataset.skin).toBe(id);
      expect(store.get("omb-skin")).toBe(id);
      expect(readSkin()).toBe(id);
    }
  });

  it("falls back to Precision for an unknown stored value", () => {
    store.set("omb-skin", "graphite");
    expect(readSkin()).toBe("precision");
    expect(readSkin()).toBe(DEFAULT_SKIN);
  });

  it("uses Precision when nothing is saved", () => {
    expect(readSkin()).toBe("precision");
    expect(readSkin()).toBe(DEFAULT_SKIN);
  });

  it("keeps a stored Midnight skin on upgrade instead of migrating it to Precision", () => {
    store.set("omb-skin", "midnight");
    expect(readSkin()).toBe("midnight");
    expect(readSkin()).not.toBe(DEFAULT_SKIN);
  });

  it("migrates a stored Catppuccin Mocha to Catppuccin Frappe", () => {
    store.set("omb-skin", "catppuccin-mocha");
    expect(readSkin()).toBe("catppuccin-frappe");
  });

  it("migrates TUI Commander and VGA to Slate and Smoke", () => {
    store.set("omb-skin", "tui-commander");
    expect(readSkin()).toBe("tui-slate");
    store.set("omb-skin", "tui-vga");
    expect(readSkin()).toBe("tui-smoke");
  });

  it("lists the same light skins as the desktop overlay", () => {
    const { skinThemeSource } = createRequire(import.meta.url)("../../electron/skin-overlay.cjs");
    for (const id of SKIN_IDS) {
      expect(LIGHT_SKIN_IDS.has(id) ? "light" : "dark", id).toBe(skinThemeSource(id));
    }
  });

  it("stamps the skin before React mounts", () => {
    const main = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../main.tsx"),
      "utf8",
    );
    const applyAt = main.indexOf("applySkin(readSkin())");
    const renderAt = main.indexOf("createRoot(");
    expect(applyAt).toBeGreaterThan(-1);
    expect(applyAt).toBeLessThan(renderAt);
  });
});
