import type { ITheme } from "@xterm/xterm";

const KEY = "omb-terminal-match-profile";
export const TERMINAL_APPEARANCE_EVENT = "orbit-terminal-appearance";

type ColorReader = (name: string) => string;

function hex(value: string): [number, number, number] | null {
  const match = value.trim().match(/^#([\da-f]{6})$/i);
  if (!match) return null;
  return [Number.parseInt(match[1].slice(0, 2), 16), Number.parseInt(match[1].slice(2, 4), 16), Number.parseInt(match[1].slice(4, 6), 16)];
}

function luminance(value: string): number | null {
  const rgb = hex(value);
  if (!rgb) return null;
  return rgb.reduce((sum, channel, index) => {
    const linear = channel / 255 <= 0.03928 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function contrast(a: string, b: string): number | null {
  const first = luminance(a);
  const second = luminance(b);
  if (first === null || second === null) return null;
  const [light, dark] = first >= second ? [first, second] : [second, first];
  return (light + 0.05) / (dark + 0.05);
}

function readable(value: string, background: string, fallback: string): string {
  return (contrast(value, background) ?? 0) >= 4.5 ? value : fallback;
}

export function terminalAnsiPalette(color: ColorReader): Pick<ITheme, "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite"> {
  const background = color("inset");
  const foreground = color("ink");
  const secondary = color("ink-secondary");
  const fallback = foreground || "#1a1a1a";
  const pick = (name: string, backup: string) => readable(color(name) || backup, background, fallback);
  return {
    black: readable(foreground, background, fallback),
    red: pick("syntax-keyword", color("danger") || "#8b1a24"),
    green: pick("syntax-tag", color("success") || "#0b4d24"),
    yellow: pick("syntax-variable", color("warning") || "#7a3500"),
    blue: pick("syntax-string", color("accent-text") || "#0a3069"),
    magenta: pick("syntax-function", color("accent-text") || "#5b21b6"),
    cyan: pick("syntax-constant", color("accent-text") || "#084298"),
    white: readable(secondary, background, fallback),
    brightBlack: readable(secondary, background, fallback),
    brightRed: pick("danger", "#8b1a24"),
    brightGreen: pick("success", "#0b4d24"),
    brightYellow: pick("warning", "#7a3500"),
    brightBlue: pick("accent-text", "#0a3069"),
    brightMagenta: pick("accent", "#5b21b6"),
    brightCyan: pick("accent-text", "#084298"),
    brightWhite: readable(foreground, background, fallback),
  };
}

export function terminalTheme(color: ColorReader): ITheme {
  const background = color("inset");
  const theme: ITheme = {
    background,
    foreground: color("ink"),
    cursor: color("accent-text"),
    cursorAccent: background,
    selectionBackground: color("raised-hover"),
  };
  if ((luminance(background) ?? 0) > 0.45) Object.assign(theme, terminalAnsiPalette(color));
  return theme;
}

export function readTerminalMatch(): boolean {
  try { return localStorage.getItem(KEY) === "true"; } catch { return false; }
}

export function applyTerminalMatch(enabled: boolean): void {
  localStorage.setItem(KEY, String(enabled));
  window.dispatchEvent(new Event(TERMINAL_APPEARANCE_EVENT));
}
