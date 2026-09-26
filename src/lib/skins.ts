// Skins are pure CSS. Every one of them is a block of custom properties in
// styles.css, selected by a `data-skin` attribute; this module only decides
// which one is active and remembers the choice. Nothing here knows a colour —
// that keeps the two halves from drifting apart, and it means adding a skin is
// one CSS block plus one line in SKINS.

export const SKIN_IDS = [
  "midnight",
  "atelier",
  "foundry",
  "lagoon",
  "ledger",
  "catppuccin-frappe",
  "tokyo-night",
  "vesper",
  "onyx",
  "dracula",
  "cobalt",
  "gruvbox",
  "kanagawa",
  "haxor-blue",
  "hurtado",
  "rose-pine",
  "nord",
  "github-dimmed",
  "tui",
  "tui-black",
  "tui-amber",
  "tui-ice",
  "tui-slate",
  "tui-smoke",
  "vscode-dark",
  "studio-gray",
  "steel-gray",
  "claude",
  "precision",
  "notebook",
  "messenger",
  "community",
  "code-review",
  "blueprint",
  "blueprint-gray",
  "blueprint-charcoal",
  "instrument",
  "matte",
  "carbon",
] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
  /** One line, shown under the name in the picker. */
  tagline: string;
};

export const SKINS: readonly Skin[] = [
  { id: "midnight", name: "Midnight", tagline: "The original. Cool and dark." },
  { id: "atelier", name: "Atelier", tagline: "Daylight on paper, warm and quiet." },
  { id: "foundry", name: "Foundry", tagline: "Night shift. Dark, warm, lit in brass." },
  { id: "lagoon", name: "Lagoon", tagline: "Cool daylight. Porcelain and deep teal." },
  { id: "ledger", name: "Ledger", tagline: "Neutral daylight. Stone and ink." },
  { id: "catppuccin-frappe", name: "Catppuccin Frappe", tagline: "Muted pastel on slate." },
  { id: "tokyo-night", name: "Tokyo Night", tagline: "Indigo night, cool counterpart to Foundry." },
  { id: "vesper", name: "Vesper", tagline: "Warm near-black, peach accent." },
  { id: "onyx", name: "Onyx", tagline: "True black, pastel accents." },
  { id: "dracula", name: "Dracula", tagline: "Slate purple, neon status." },
  { id: "cobalt", name: "Panda Syntax", tagline: "Warm charcoal, mint lamp." },
  { id: "gruvbox", name: "Gruvbox", tagline: "Warm and earthy, retro groove." },
  { id: "kanagawa", name: "Kanagawa", tagline: "Muted wave blues and warm paper." },
  { id: "haxor-blue", name: "HaX0R_BLUE", tagline: "Deep-space blue, monochrome phosphor." },
  { id: "hurtado", name: "Hurtado", tagline: "Pure black, neon pink and ice." },
  { id: "rose-pine", name: "Rosé Pine", tagline: "Dusk pine, rose and foam." },
  { id: "nord", name: "Nord", tagline: "Polar night, frost blue." },
  { id: "github-dimmed", name: "GitHub Dimmed", tagline: "Medium gray, Primer blue." },
  { id: "tui", name: "TUI", tagline: "Monospace, sharp corners, terminal chrome." },
  { id: "tui-black", name: "TUI Black", tagline: "True black, terminal chrome." },
  { id: "tui-amber", name: "TUI Amber", tagline: "Black chrome, yellow accent." },
  { id: "tui-ice", name: "TUI Ice", tagline: "True black, ice selection." },
  { id: "tui-slate", name: "TUI Slate", tagline: "True black, silver selection." },
  { id: "tui-smoke", name: "TUI Smoke", tagline: "True black, warm gray chrome." },
  { id: "vscode-dark", name: "VS Code Dark", tagline: "Editor dark, command blue, readable syntax." },
  { id: "studio-gray", name: "Studio Gray", tagline: "Quiet graphite, periwinkle signal." },
  { id: "steel-gray", name: "Steel Gray", tagline: "Cool steel, mint signal." },
  { id: "claude", name: "Claude", tagline: "Warm black, serif replies, quiet chrome." },
  { id: "precision", name: "Precision", tagline: "Compact issue discussion, cool charcoal." },
  { id: "notebook", name: "Notebook", tagline: "Document calm, paper and ink." },
  { id: "messenger", name: "Messenger", tagline: "Blue bubbles, clear conversation." },
  { id: "community", name: "Community", tagline: "Sender-first shared space, slate dark." },
  { id: "code-review", name: "Code Review", tagline: "Light review threads, crisp code." },
  { id: "blueprint", name: "Blueprint", tagline: "Technical paper, fine blue rules." },
  { id: "blueprint-gray", name: "Blueprint Gray", tagline: "Mid-gray drafting board, blue rules." },
  { id: "blueprint-charcoal", name: "Blueprint Charcoal", tagline: "Deep charcoal drafting board, blue rules." },
  { id: "instrument", name: "Instrument", tagline: "Slate ink, Plex type, ruled cards." },
  { id: "matte", name: "Matte", tagline: "Warm stone, soft light, rounded type." },
  { id: "carbon", name: "Carbon", tagline: "Near-black steel, dense monospace." },
];

export const DEFAULT_SKIN: SkinId = "precision";

const KEY = "omb-skin";

// The input is whatever localStorage handed back — a string this app wrote
// on an earlier run, a value edited by hand, or a leftover from a renamed
// skin. The list is the schema.
function isSkinId(value: unknown): value is SkinId {
  // SAFETY: the assertion only satisfies includes()' parameter type; the
  // check itself is what decides, and a non-member returns false.
  return SKIN_IDS.includes(value as SkinId);
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` alone doesn't shield it.
function getStore(): Storage | undefined {
  try {
    // A bare feature test, not a narrowing of parsed input: in a renderer
    // without storage the identifier is simply not defined.
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readSkin(): SkinId {
  try {
    const stored = getStore()?.getItem(KEY);
    if (stored === "catppuccin-mocha") return "catppuccin-frappe";
    if (stored === "tui-commander") return "tui-slate";
    if (stored === "tui-vga") return "tui-smoke";
    return isSkinId(stored) ? stored : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

/**
 * Point the document at a skin and remember it. Called once before the first
 * paint (main.tsx) and again on every change from the picker — a stamped
 * attribute rather than a class so it can never collide with Tailwind.
 */
export function applySkin(id: SkinId): void {
  document.documentElement.dataset.skin = id;
  try {
    getStore()?.setItem(KEY, id);
  } catch {
    /* quota / private mode — the skin still applies for this session */
  }
  // The one surface CSS cannot reach: on Windows the caption buttons sit in a
  // native overlay the main process paints. Left at the default it stays
  // Midnight-black on a light skin — the "black block in the top-right
  // corner" of issue #454. Best-effort: a browser tab or an older desktop
  // build has no bridge, and the skin still applies without it.
  try {
    void window.ogb?.applySkin?.(id)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }
}
