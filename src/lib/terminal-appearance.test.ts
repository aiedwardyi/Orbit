import { describe, expect, it } from "vitest";
import { terminalAnsiPalette, terminalTheme } from "./terminal-appearance";

const lightSkins = {
  atelier: { inset: "#f5f1eb", ink: "#1a1a18", secondary: "#6b6559", accent: "#a05f25", accentText: "#96551f", danger: "#a33a32", success: "#3f6b47", warning: "#7a5f31", keyword: "#8b1a24", string: "#0a3069", function: "#5b21b6", constant: "#084298", variable: "#7a3500", tag: "#0b4d24" },
  lagoon: { inset: "#d5e8e5", ink: "#14201f", secondary: "#4d5c5b", accent: "#11736d", accentText: "#0d5f5a", danger: "#a8382f", success: "#2f6b4f", warning: "#7a5a2a", keyword: "#8b1a24", string: "#0a3069", function: "#5b21b6", constant: "#084298", variable: "#7a3500", tag: "#0b4d24" },
  ledger: { inset: "#d6d6d6", ink: "#1a1a1a", secondary: "#575757", accent: "#1f4d99", accentText: "#1a4080", danger: "#a33a32", success: "#2f6b4a", warning: "#7a5a28", keyword: "#8b1a24", string: "#0a3069", function: "#5b21b6", constant: "#084298", variable: "#7a3500", tag: "#0b4d24" },
  notebook: { inset: "#f0f0ed", ink: "#252522", secondary: "#686862", accent: "#315d9b", accentText: "#284e83", danger: "#a33a32", success: "#2f6b4a", warning: "#7a5a28", keyword: "#8b1a24", string: "#0a3069", function: "#5b21b6", constant: "#084298", variable: "#7a3500", tag: "#0b4d24" },
  messenger: { inset: "#e3e6ec", ink: "#1b1d22", secondary: "#606671", accent: "#0866d9", accentText: "#0758b9", danger: "#b42318", success: "#287a45", warning: "#8a5a00", keyword: "#b42318", string: "#0a3069", function: "#6b21a8", constant: "#075985", variable: "#8a3b12", tag: "#166534" },
  "code-review": { inset: "#eaeef2", ink: "#1f2328", secondary: "#59636e", accent: "#0969da", accentText: "#0969da", danger: "#cf222e", success: "#1a7f37", warning: "#9a6700", keyword: "#cf222e", string: "#0a3069", function: "#6e40b5", constant: "#0550ae", variable: "#953800", tag: "#116329" },
  blueprint: { inset: "#dde8f3", ink: "#18324c", secondary: "#4f6680", accent: "#205ea6", accentText: "#1d5794", danger: "#b42318", success: "#2c6e49", warning: "#8a5a00", keyword: "#9e2a2b", string: "#174ea6", function: "#6336a3", constant: "#0b5394", variable: "#7a4300", tag: "#166534" },
} as const;

function channel(value: string, offset: number): number {
  return Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
}

function luminance(value: string): number {
  const channels = [channel(value, 1), channel(value, 3), channel(value, 5)];
  return channels.reduce((sum, component, index) => {
    const linear = component <= 0.03928 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("terminal ANSI palette", () => {
  it("keeps every light skin's normal and bright ANSI colors readable", () => {
    for (const [id, values] of Object.entries(lightSkins)) {
      const color = (name: string) => {
        const map = new Map(Object.entries({
          inset: values.inset,
          ink: values.ink,
          "ink-secondary": values.secondary,
          accent: values.accent,
          "accent-text": values.accentText,
          danger: values.danger,
          success: values.success,
          warning: values.warning,
          "syntax-keyword": values.keyword,
          "syntax-string": values.string,
          "syntax-function": values.function,
          "syntax-constant": values.constant,
          "syntax-variable": values.variable,
          "syntax-tag": values.tag,
        }));
        return map.get(name) ?? "";
      };
      const palette = terminalAnsiPalette(color);
      for (const [name, value] of Object.entries(palette)) {
        expect(contrast(value, values.inset), `${id} ${name}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(terminalTheme(color)).toMatchObject({ background: values.inset, foreground: values.ink, ...palette });
    }
  });

  it("leaves dark skin ANSI defaults untouched while keeping the base theme", () => {
    const color = (name: string) => ({ inset: "#191919", ink: "#fcfcfc", "accent-text": "#7fc0ff", "raised-hover": "#3d3d3d" }[name] ?? "");
    const theme = terminalTheme(color);
    expect(theme).toMatchObject({ background: "#191919", foreground: "#fcfcfc", cursor: "#7fc0ff" });
    expect(theme.red).toBeUndefined();
  });
});
