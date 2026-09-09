import peachSvg from "@/assets/mascots/peach.svg?raw";
import tealSvg from "@/assets/mascots/teal.svg?raw";
import lavenderSvg from "@/assets/mascots/lavender.svg?raw";
import coralSvg from "@/assets/mascots/coral.svg?raw";
import squircleSvg from "@/assets/mascots/squircle.svg?raw";
import circleSvg from "@/assets/mascots/circle.svg?raw";
import pillSvg from "@/assets/mascots/pill.svg?raw";
import { type MascotStyle } from "../../shared/bot-avatar";
import { MAUS_COLORS, mausColorHex } from "./mascot";

const ART = {
  peach: peachSvg,
  teal: tealSvg,
  lavender: lavenderSvg,
  coral: coralSvg,
  squircle: squircleSvg,
  circle: circleSvg,
  pill: pillSvg,
} satisfies Record<MascotStyle, string>;

function mix(hex: string, toward: string, t: number): string {
  const a = Number.parseInt(hex.slice(1), 16);
  const b = Number.parseInt(toward.slice(1), 16);
  const channel = (shift: number) => {
    const va = (a >> shift) & 0xff;
    const vb = (b >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Fills a bundled cute-mascot SVG with the bot's palette color. */
export function mascotSvgMarkup(style: MascotStyle, color: string): string {
  const fill = mausColorHex(color);
  const painted = ART[style]
    .replaceAll("{{BODY_LIGHT}}", mix(fill, "#ffffff", 0.55))
    .replaceAll("{{BODY}}", fill)
    .replaceAll("{{BODY_SHADOW}}", mix(fill, "#000000", 0.42))
    .replaceAll("{{BODY_DEEP}}", mix(fill, "#000000", 0.28));
  // Clamped cream ground. Owner asked for the dumpling "on white" without
  // picking #FFFFFF vs this; leave the clamp alone until he answers.
  return painted.replace(/(<svg[^>]*>)/, `$1<rect width="256" height="256" fill="${MAUS_COLORS.white}"/>`);
}

/** Prefix ids so two inlined mascots on one page cannot share a gradient. */
export function scopeMascotSvgIds(svg: string, scope: string): string {
  const prefix = scope.replace(/[^A-Za-z0-9_-]/g, "") || "m";
  return svg
    .replace(/\srole="img"/, "")
    .replace(/\saria-label="[^"]*"/, "")
    .replace(/\bid="([^"]+)"/g, `id="${prefix}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`);
}

export function mascotDataUrl(style: MascotStyle, color: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mascotSvgMarkup(style, color))}`;
}
