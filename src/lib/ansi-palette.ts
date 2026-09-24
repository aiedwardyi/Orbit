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

export function ansiColor(color: number | string | undefined): string | undefined {
  if (color === undefined) return undefined;
  return Number.isInteger(color) ? ANSI_PALETTE[Number(color)] : String(color);
}
