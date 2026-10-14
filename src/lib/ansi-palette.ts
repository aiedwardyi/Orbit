import { contrast, hex as parseHex, isLightBackground, luminance, terminalAnsiPalette } from "./terminal-appearance";

// xterm.js default 16 colors, then the 6x6x6 cube and grayscale ramp.
const BASE = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];
const CUBE = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
const hex = (value: number) => value.toString(16).padStart(2, "0");

export const ANSI_PALETTE: readonly string[] = [
  ...BASE,
  ...Array.from({ length: 216 }, (_, i) => `#${hex(CUBE[Math.floor(i / 36)])}${hex(CUBE[Math.floor(i / 6) % 6])}${hex(CUBE[i % 6])}`),
  ...Array.from({ length: 24 }, (_, i) => `#${hex(8 + i * 10).repeat(3)}`),
];

export function ansiColor(color: number | string | undefined, palette: readonly string[] = ANSI_PALETTE): string | undefined {
  if (color === undefined) return undefined;
  return Number.isInteger(color) ? palette[Number(color)] : String(color);
}

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
const MIN_TEXT = 4.5;
const MIN_DIM = 3;
const DIM_WEIGHT = 0.6;

type RunColors = { color?: string; backgroundColor?: string };
export type RunPaint = { palette: readonly string[]; background: string; ink: string; cache: Map<string, RunColors> };

function toHsl([r, g, b]: number[]): [number, number, number] {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z);
  const min = Math.min(x, y, z);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === x ? (y - z) / d + (y < z ? 6 : 0) : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = (t + 1) % 1;
    return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
  };
  return `#${[channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Keeps the hue and moves lightness away from the background until the ratio holds. Passing colors come back as given. */
export function ensureContrast(fg: string, bg: string, ratio: number): string {
  const rgb = parseHex(fg);
  const have = contrast(fg, bg);
  if (!rgb || have === null || have >= ratio) return fg;
  const [h, s, l] = toHsl(rgb);
  const darkerFirst = (luminance(bg) ?? 0) > (luminance(fg) ?? 0);
  const reach = (edge: number) => {
    if ((contrast(fromHsl(h, s, edge), bg) ?? 0) < ratio) return null;
    let [pass, fail] = [edge, l];
    for (let i = 0; i < 16; i++) {
      const mid = (pass + fail) / 2;
      if ((contrast(fromHsl(h, s, mid), bg) ?? 0) >= ratio) pass = mid;
      else fail = mid;
    }
    return fromHsl(h, s, pass);
  };
  const [first, second] = darkerFirst ? [0, 1] : [1, 0];
  return reach(first) ?? reach(second) ?? ((contrast("#000000", bg) ?? 0) >= (contrast("#ffffff", bg) ?? 0) ? "#000000" : "#ffffff");
}

function mix(a: string, b: string, weight: number): string {
  const [x, y] = [parseHex(a), parseHex(b)];
  if (!x || !y) return a;
  return `#${x.map((channel, i) => Math.round(channel * weight + y[i] * (1 - weight)).toString(16).padStart(2, "0")).join("")}`;
}

/** Light skins get the desktop's ANSI 0-15, so a run reads the same here as in the pane. */
export function runPaint(token: (name: string) => string): RunPaint {
  // The built CSS shortens #000000 to #000, which the contrast math cannot read.
  const color = (name: string) => token(name).replace(/^#([\da-f])([\da-f])([\da-f])$/i, "#$1$1$2$2$3$3");
  const background = color("inset");
  const palette = [...ANSI_PALETTE];
  if (isLightBackground(background)) {
    const theme = terminalAnsiPalette(color);
    palette.splice(0, 16, ...ANSI_NAMES.map((name) => theme[name] ?? ""));
  }
  return { palette, background, ink: color("ink"), cache: new Map() };
}

/** Dim is painted as an explicit blend, so the floor applies to what shows rather than to the source color. */
export function paintRun(run: TerminalRun, paint: RunPaint): RunColors {
  const fg = ansiColor(run.fg, paint.palette);
  const bg = ansiColor(run.bg, paint.palette);
  const key = `${fg}|${bg}|${run.d ? 1 : 0}`;
  const hit = paint.cache.get(key);
  if (hit) return hit;
  const text = ensureContrast(fg ?? paint.ink, bg ?? paint.background, MIN_TEXT);
  let painted: RunColors;
  if (run.d) {
    const ground = bg && mix(bg, paint.background, DIM_WEIGHT);
    painted = { color: ensureContrast(mix(text, paint.background, DIM_WEIGHT), ground ?? paint.background, MIN_DIM), backgroundColor: ground };
  } else {
    painted = { color: fg === undefined && text === paint.ink ? undefined : text, backgroundColor: bg };
  }
  paint.cache.set(key, painted);
  return painted;
}
