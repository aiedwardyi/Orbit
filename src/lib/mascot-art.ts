import peachSvg from "@/assets/mascots/peach.svg?raw";
import tealSvg from "@/assets/mascots/teal.svg?raw";
import lavenderSvg from "@/assets/mascots/lavender.svg?raw";
import coralSvg from "@/assets/mascots/coral.svg?raw";
import { type MascotStyle } from "../../shared/bot-avatar";
import { mausColorHex } from "./mascot";

const ART = {
  peach: peachSvg,
  teal: tealSvg,
  lavender: lavenderSvg,
  coral: coralSvg,
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
  return ART[style]
    .replaceAll("{{BODY_LIGHT}}", mix(fill, "#ffffff", 0.55))
    .replaceAll("{{BODY}}", fill)
    .replaceAll("{{BODY_SHADOW}}", mix(fill, "#000000", 0.42))
    .replaceAll("{{BODY_DEEP}}", mix(fill, "#000000", 0.28));
}

export function mascotDataUrl(style: MascotStyle, color: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mascotSvgMarkup(style, color))}`;
}
