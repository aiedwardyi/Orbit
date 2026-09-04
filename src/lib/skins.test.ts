// The registry and the stylesheet are two halves of one contract: a skin listed
// here without a matching CSS block renders as whatever was active before, with
// no error anywhere. That failure is silent, so it gets a test.
import { readFileSync } from "node:fs";
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

describe("skins", () => {
  it("gives every registered skin a stylesheet block", () => {
    for (const id of SKIN_IDS) expect(blocks).toContain(id);
  });

  it("registers every stylesheet block", () => {
    const registered = new Set<string>(SKIN_IDS);
    for (const id of blocks) expect(registered).toContain(id);
  });

  it("defines the same tokens in every skin", () => {
    const reference = tokensOf(DEFAULT_SKIN);
    expect(reference.size).toBeGreaterThan(15);
    for (const id of SKIN_IDS) {
      expect([...reference].filter((t) => !tokensOf(id).has(t))).toEqual([]);
    }
  });

  it("gives every non-Midnight skin its own focus and control tokens", () => {
    // Midnight inherits Grok-blue --color-focus from @theme. A light skin
    // that skips the token wears that blue on stone, paper, or porcelain.
    for (const id of SKIN_IDS) {
      if (id === "midnight") continue;
      expect([...tokensOf(id)]).toEqual(expect.arrayContaining(["--color-focus", "--color-control"]));
    }
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

const DARK_INK_SKINS = [
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    tokens: {
      "--color-app": "#1e1e2e",
      "--color-raised": "#313244",
      "--color-ink": "#cdd6f4",
      "--color-ink-secondary": "#a6adc8",
      "--color-accent": "#cba6f7",
      "--color-hairline": "#45475a",
      "--color-danger": "#f38ba8",
      "--color-success": "#a6e3a1",
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
      "--color-app": "#0a0a0b",
      "--color-raised": "#1a1a1d",
      "--color-ink": "#ededf0",
      "--color-ink-secondary": "#9c9ca5",
      "--color-accent": "#e4e4e7",
      "--color-hairline": "#343438",
      "--color-danger": "#f2655f",
      "--color-success": "#5fcf86",
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

  it("puts each skin's ground on accent and danger fills, not Midnight white", () => {
    for (const skin of DARK_INK_SKINS) {
      const bg = skin.tokens["--color-app"];
      expect(cssToken(skin.id, "--color-accent-ink")).toBe(bg);
      expect(cssToken(skin.id, "--color-danger-ink")).toBe(bg);
      expect(cssToken(skin.id, "--color-accent-ink")).not.toBe("#ffffff");
      expect(cssToken(skin.id, "--color-danger-ink")).not.toBe("#ffffff");
    }
  });

  it("gives Onyx a blue link colour so silver accent is not the only cue", () => {
    expect(cssToken("onyx", "--color-accent-text")).toBe("#8fb3e6");
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

  it("falls back to Midnight for an unknown stored value", () => {
    store.set("omb-skin", "graphite");
    expect(readSkin()).toBe(DEFAULT_SKIN);
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
