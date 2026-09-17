// The registry and the stylesheet are two halves of one contract: a skin listed
// here without a matching CSS block renders as whatever was active before, with
// no error anywhere. That failure is silent, so it gets a test.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SKINS, SKIN_IDS, DEFAULT_SKIN, applySkin, readSkin } from "./skins";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
  "utf8",
);

const blocks = new Set(
  [...css.matchAll(/\[data-skin="([a-z-]+)"\]/g)].map(([, id]) => id),
);

function cssToken(id: string, name: string): string | null {
  const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return body.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]+)`))?.[1]?.toLowerCase() ?? null;
}

function tokensOf(id: string): Set<string> {
  const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
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
    const remapped = ["atelier", "lagoon", "ledger", "vscode-dark"];
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
    const light = ["atelier", "lagoon", "ledger"];
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

  it("defaults a fresh install to Ledger and does not rename Atelier", () => {
    expect(DEFAULT_SKIN).toBe("ledger");
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
      "--color-hairline": "#222222",
      "--color-danger": "#f2655f",
      "--color-success": "#73daca",
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
      "--color-ink-secondary": "#908caa",
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
      "--color-ink-secondary": "#adbac7",
      "--color-accent": "#539bf5",
      "--color-hairline": "#444c56",
      "--color-danger": "#ff7b72",
      "--color-success": "#57ab5a",
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
      "--color-hairline": "#2a2a2a",
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

  it("keeps HaX0R_BLUE success distinct from danger inside the monochrome palette", () => {
    // The scheme's vivid blues sit within 1.05 of each other, so success
    // takes the pale selectionBackground ice while danger keeps the vivid
    // phosphor — go and stop can never be confused at a glance.
    const success = cssToken("haxor-blue", "--color-success");
    const danger = cssToken("haxor-blue", "--color-danger");
    expect(success).toBe("#c1e4ff");
    expect(danger).toBe("#10b6ff");
    expect(contrast(success!, danger!)).toBeGreaterThanOrEqual(1.5);
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

  it("falls back to Ledger for an unknown stored value", () => {
    store.set("omb-skin", "graphite");
    expect(readSkin()).toBe("ledger");
    expect(readSkin()).toBe(DEFAULT_SKIN);
  });

  it("keeps a stored Midnight skin on upgrade instead of migrating it to Ledger", () => {
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
