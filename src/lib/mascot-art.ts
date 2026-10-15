import peachSvg from "@/assets/mascots/peach.svg?raw";
import tealSvg from "@/assets/mascots/teal.svg?raw";
import lavenderSvg from "@/assets/mascots/lavender.svg?raw";
import coralSvg from "@/assets/mascots/coral.svg?raw";
import squircleSvg from "@/assets/mascots/squircle.svg?raw";
import circleSvg from "@/assets/mascots/circle.svg?raw";
import pillSvg from "@/assets/mascots/pill.svg?raw";
import { type MascotStyle } from "../../shared/bot-avatar";
import { mausColorHex } from "./mascot";

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
  return painted;
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

/** Splits a mascot SVG around its eyes so they can animate on an HTML layer. */
export function mascotLayerMarkup(svg: string): string {
  const start = svg.indexOf('<g class="mascot-idle">');
  const blink = svg.indexOf('<g class="mascot-blink">', start);
  const close = svg.indexOf("</g>", blink);
  const end = svg.indexOf("</g>", close + 4) + 4;
  if (start < 0 || blink < 0 || close < 0 || end < 4) return svg;
  const eyes = svg.slice(blink + '<g class="mascot-blink">'.length, close);
  const top = svg.slice(end, svg.lastIndexOf("</svg>")).trim();
  const open = svg.slice(0, svg.indexOf(">") + 1);
  // Eye paths sit inside their circles, so the circles give the fill box.
  const circles = [...eyes.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
  if (!circles.length) return svg;
  const x = Math.min(...circles.map(([cx, , r]) => cx! - r!));
  const y = Math.min(...circles.map(([, cy, r]) => cy! - r!));
  const w = Math.max(...circles.map(([cx, , r]) => cx! + r!)) - x;
  const h = Math.max(...circles.map(([, cy, r]) => cy! + r!)) - y;
  const pct = (n: number) => `${(n / 2.56).toFixed(4)}%`;
  // Full-size layers keep the eyes on the body's pixel grid; vars carry the eye box.
  return `${svg.slice(0, start).trimEnd()}\n</svg>`
    + `<span class="mascot-idle" style="--mascot-eye-w:${pct(w)};--mascot-eye-h:${pct(h)};--mascot-eye-origin:${pct(x + w / 2)} ${pct(y + h / 2)}">`
    + `<span class="mascot-blink">${open}${eyes}</svg></span></span>`
    + (top ? `${open.replace("<svg", '<svg class="mascot-top"')}${top}</svg>` : "");
}

export function mascotDataUrl(style: MascotStyle, color: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mascotSvgMarkup(style, color))}`;
}
