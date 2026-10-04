// App settings → Model index (experimental): lab-published benchmark scores
// against cost, per model and effort, so picking a model never needs a web
// search. Numbers come only from shared/model-index-data.ts; nothing is fetched.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Maximize2, X } from "lucide-react";
import { useStore } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-catalog";
import { cn } from "@/lib/cn";
import { isPhone } from "@/lib/phone-swipe";
import {
  CHART_PROVIDERS,
  chartProvider,
  effortRank,
  formatCost,
  formatPrice,
  formatUsd,
  indexView,
  linearTicks,
  fitLogTicks,
  markUniverse,
  modelShapes,
  paretoFrontier,
  scoredIndexes,
  winkCatalog,
  type ChartProvider,
  type ModelIndexPoint,
} from "@/lib/model-index";
import { MODEL_INDEX_AS_OF, type ModelIndexKey } from "../../shared/model-index-data.ts";
import "./ModelIndexSection.css";

type View = "scatter" | "bars";
type Mark = ReturnType<typeof markUniverse>[number];
type Box = { x: number; y: number; w: number; h: number };
type Spot = { x: number; y: number };
type Avoid = { dots: Spot[]; line: Spot[] };
type Hover = { key: string; box: Box; avoid?: Avoid };
type OnHover = (key: string | null, el?: Element, avoid?: Avoid) => void;
type Translate = ReturnType<typeof useI18n>["t"];

const INDEXES = scoredIndexes();
const MARKS = markUniverse();

const INDEX_KEY: Record<ModelIndexKey, MessageKey> = {
  intelligence: "modelIndex.index.intelligence",
  coding: "modelIndex.index.coding",
  agentic: "modelIndex.index.agentic",
  general: "modelIndex.index.general",
  legal: "modelIndex.index.legal",
  cost: "modelIndex.index.cost",
};

const AXIS_KEY: Record<ModelIndexKey, MessageKey> = {
  intelligence: "modelIndex.axis.intelligence",
  coding: "modelIndex.axis.coding",
  agentic: "modelIndex.axis.agentic",
  general: "modelIndex.axis.general",
  legal: "modelIndex.axis.legal",
  cost: "modelIndex.cost.hint",
};

const PERCENT = new Set<ModelIndexKey>(["coding", "agentic", "legal"]);

const PROVIDER_NAME: Record<Exclude<ChartProvider, "other">, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
};

// Color names the lab; shape names the model within it.
const SHAPES = [
  "M-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0z",
  "M-2.7-2.7h5.4v5.4h-5.4z",
  "M0-3.7L3.7 0L0 3.7L-3.7 0z",
  "M0-3.8L3.6 2.6H-3.6z",
  "M0 3.8L3.6-2.6H-3.6z",
  "M0-4.3L1.03-1.42L4.09-1.33L1.66 0.54L2.53 3.48L0 1.75L-2.53 3.48L-1.66 0.54L-4.09-1.33L-1.03-1.42z",
  "M-1.2-3.5h2.4v2.3h2.3v2.4h-2.3v2.3h-2.4v-2.3h-2.3v-2.4h2.3z",
  "M1.63-3.32L3.32-1.63L1.7 0L3.32 1.63L1.63 3.32L0 1.7L-1.63 3.32L-3.32 1.63L-1.7 0L-3.32-1.63L-1.63-3.32L0-1.7z",
];
const MODEL_SHAPE = modelShapes(SHAPES.length);
const shapeOf = (model: string) => SHAPES[MODEL_SHAPE.get(model) ?? 0]!;

const ROW = 26;
const CAPTION_LINE = 13;
const MARGIN = { top: 30, right: 16, bottom: 46, left: 44 };
// Every line keeps a fixed point count so CSS can morph its `d` between tabs.
const LINE_SLOTS = 6;
const FRONTIER_SLOTS = 16;
// Outlasts --mi-ease, so a leaving tick finishes its fade before it unmounts.
const LEAVE_MS = 600;

const color = (provider: string) => `var(--mi-${chartProvider(provider)})`;
const labName = (provider: string) => {
  const slot = chartProvider(provider);
  return slot === "other" ? provider : PROVIDER_NAME[slot];
};
const shortLabel = (label: string) => label.replace(/^Claude /, "");
const formatCostTick = (usd: number) => `$${usd}`;
const formatValue = (index: ModelIndexKey, point: ModelIndexPoint) =>
  index === "cost" && point.price
    ? formatPrice(point.price)
    : index === "general"
      ? Math.round(point.score).toLocaleString("en-US")
      : `${point.score.toFixed(1)}${PERCENT.has(index) ? "%" : ""}`;
const unitOf = (index: ModelIndexKey) => (PERCENT.has(index) ? "%" : index === "general" ? "elo" : "pts");
const formatTick = (unit: string, value: number) =>
  unit === "elo" ? value.toLocaleString("en-US") : `${value}${unit === "%" ? "%" : ""}`;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function padPath(spots: Spot[], slots: number) {
  return Array.from({ length: Math.max(slots, spots.length) }, (_, i) => spots[Math.min(i, spots.length - 1)]!)
    .map((spot, i) => `${i ? "L" : "M"}${spot.x.toFixed(1)} ${spot.y.toFixed(1)}`)
    .join("");
}

let canvas: CanvasRenderingContext2D | null | undefined;
/** Label width in the live font; server rendering falls back to an estimate. */
function measurer(): (text: string) => number {
  canvas ??=
    typeof document !== "undefined" && typeof document.createElement === "function"
      ? document.createElement("canvas").getContext("2d")
      : null;
  const ctx = canvas;
  if (!ctx) return (text) => text.length * 6;
  // Skins set the app font on body; html keeps the browser default.
  ctx.font = `500 10.5px ${getComputedStyle(document.body).fontFamily}`;
  return (text) => ctx.measureText(text).width;
}

function wrapLines(text: string, max: number, measure: (text: string) => number) {
  // A parenthesised group wraps as one word, so "(USD, log scale)" never splits.
  const words: string[] = [];
  for (const word of text.split(" ")) {
    const last = words[words.length - 1];
    if (last?.includes("(") && !last.includes(")")) words[words.length - 1] = `${last} ${word}`;
    else words.push(word);
  }
  const lines: string[] = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && measure(`${last} ${word}`) <= max) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(160, Math.round(entry.contentRect.width)));
      setHeight(Math.round(entry.contentRect.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width, height] as const;
}

/** Items that just left, held at their last spot until their fade-out ends. */
function useLeaving<T extends { key: string }>(items: T[]): T[] {
  const last = useRef(items);
  const keys = items.map((item) => item.key).join("|");
  const [shown, setShown] = useState(keys);
  const [leaving, setLeaving] = useState<T[]>([]);
  if (keys !== shown) {
    const live = new Set(items.map((item) => item.key));
    setShown(keys);
    setLeaving([...leaving, ...last.current].filter((item, i, all) => !live.has(item.key) && all.findIndex((other) => other.key === item.key) === i));
  }
  useLayoutEffect(() => {
    last.current = items;
  });
  useEffect(() => {
    if (!leaving.length) return;
    const timer = window.setTimeout(() => setLeaving([]), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return leaving;
}

function Shape({ model, provider, hollow = false }: { model?: string; provider?: string; hollow?: boolean }) {
  const paint = provider ? color(provider) : "currentColor";
  return (
    <svg width="10" height="10" viewBox="-5 -5 10 10" aria-hidden className="shrink-0">
      <path d={model ? shapeOf(model) : SHAPES[0]} style={hollow ? { fill: "none", stroke: paint, strokeWidth: 1.25 } : { fill: paint }} />
    </svg>
  );
}

function Swatch({ provider }: { provider: string }) {
  return <span aria-hidden className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: color(provider) }} />;
}

function edgeFade(el: HTMLElement): string | undefined {
  const start = el.scrollLeft > 1;
  const end = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
  if (!start && !end) return undefined;
  return `linear-gradient(to right, ${start ? "transparent" : "black"}, black 24px, black calc(100% - 24px), ${end ? "transparent" : "black"})`;
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (id: T) => void;
  disabled?: (id: T) => boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const [mask, setMask] = useState<string | undefined>();
  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    const place = () => {
      const on = group.querySelector<HTMLElement>('[aria-checked="true"]');
      setThumb(on ? { x: on.offsetLeft, w: on.offsetWidth } : null);
      setMask(edgeFade(group));
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(group);
    for (const button of group.querySelectorAll("button")) observer.observe(button);
    return () => observer.disconnect();
  }, [value, options.length]);
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onScroll={(e) => setMask(edgeFade(e.currentTarget))}
      className="relative flex w-fit min-w-0 max-w-full gap-0.5 overflow-x-auto rounded-lg bg-inset p-[3px] pointer-coarse:[scrollbar-width:none] pointer-coarse:[&::-webkit-scrollbar]:hidden"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {thumb && (
        <span
          aria-hidden
          data-mi-thumb
          className="pointer-events-none absolute inset-y-[3px] left-0 rounded-[max(0px,calc(var(--radius-lg)_-_3px))] bg-raised shadow-sm ring-1 ring-hairline/60"
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
        />
      )}
      {options.map((option) => {
        const selected = value === option.id;
        const off = disabled?.(option.id) ?? false;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={off}
            onClick={() => onChange(option.id)}
            className={cn(
              "relative shrink-0 whitespace-nowrap rounded-[max(0px,calc(var(--radius-lg)_-_3px))] px-3 py-1 text-[12.5px] font-medium transition-colors disabled:opacity-40",
              selected ? "text-ink" : "text-ink-secondary enabled:hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Greedy, in priority order: eight spots hugging each anchor, then rings farther out
 * on a leader line; a label that fits nowhere is skipped.
 */
function placeLabels(
  items: Array<{ id: string; text: string; anchors: Spot[] }>,
  taken: Box[],
  bounds: { left: number; top: number; right: number; bottom: number },
  measure: (text: string) => number,
) {
  const placed = [...taken];
  const out = new Map<string, Spot & { leader?: [Spot, Spot] }>();
  for (const item of items) {
    const w = measure(item.text) + 2;
    const h = 12;
    const hug = item.anchors.flatMap(({ x, y }) => [
      { x: x + 7, y: y - h / 2 },
      { x: x - 7 - w, y: y - h / 2 },
      { x: x - w / 2, y: y - 8 - h },
      { x: x - w / 2, y: y + 8 },
      { x: x + 5, y: y - 5 - h },
      { x: x - 5 - w, y: y - 5 - h },
      { x: x + 5, y: y + 5 },
      { x: x - 5 - w, y: y + 5 },
    ]);
    const end = item.anchors[0]!;
    const rings = [20, 32, 46, 62].flatMap((reach) =>
      [0, -30, 30, -60, 60, -90, 90, -120, 120, -150, 150, 180].map((deg) => {
        const [cos, sin] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
        return { x: end.x + cos * (reach + (w / 2) * Math.abs(cos)) - w / 2, y: end.y + sin * (reach + (h / 2) * Math.abs(sin)) - h / 2, from: end };
      }),
    );
    const spot = [...hug, ...rings].find(
      (c) =>
        c.x >= bounds.left &&
        c.x + w <= bounds.right &&
        c.y >= bounds.top &&
        c.y + h <= bounds.bottom &&
        !placed.some((box) => overlaps({ x: c.x, y: c.y, w, h }, box)),
    );
    if (!spot) continue;
    placed.push({ x: spot.x - 2, y: spot.y - 1, w: w + 4, h: h + 2 });
    const to = "from" in spot ? { x: Math.min(Math.max(end.x, spot.x), spot.x + w), y: Math.min(Math.max(end.y, spot.y), spot.y + h) } : undefined;
    const along = to && Math.hypot(to.x - end.x, to.y - end.y);
    out.set(item.id, {
      x: spot.x,
      y: spot.y + 9,
      leader: to && along ? [{ x: end.x + ((to.x - end.x) / along) * 7, y: end.y + ((to.y - end.y) / along) * 7 }, to] : undefined,
    });
  }
  return out;
}

function segmentGap(p: Spot, a: Spot, b: Spot) {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

/** Liang-Barsky: does segment a-b pass through the box? */
function crosses(a: Spot, b: Spot, box: Box) {
  let [t0, t1] = [0, 1];
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  for (const [p, q] of [[-dx, a.x - box.x], [dx, box.x + box.w - a.x], [-dy, a.y - box.y], [dy, box.y + box.h - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

/** Beside the hovered mark, clear of its own effort line, hiding as few neighbors as it can. */
function placeTooltip(anchor: Box, tip: { w: number; h: number }, frame: { w: number; h: number }, view: View, avoid?: Avoid) {
  const cx = anchor.x + anchor.w / 2;
  const cy = anchor.y + anchor.h / 2;
  if (view === "bars") {
    return { left: Math.max(0, frame.w - tip.w), top: cy < frame.h / 2 ? anchor.y + anchor.h + 4 : anchor.y - 4 - tip.h };
  }
  const gap = 16;
  const cost = ({ left, top }: { left: number; top: number }) => {
    const box = { x: left - 6, y: top - 6, w: tip.w + 12, h: tip.h + 12 };
    const covers = (dot: Spot) => dot.x > box.x && dot.x < box.x + box.w && dot.y > box.y && dot.y < box.y + box.h;
    const line = avoid?.line ?? [];
    const own = line.slice(1).filter((spot, i) => crosses(line[i]!, spot, box)).length + line.filter(covers).length;
    const far = Math.hypot(left + tip.w / 2 - cx, top + tip.h / 2 - cy);
    return (covers({ x: cx, y: cy }) ? 1000 : 0) + own * 100 + (avoid?.dots ?? []).filter(covers).length * 2 + far / 100;
  };
  // Sweep each side of the mark; the tooltip may spill past the plot onto the card's controls or legend.
  const spots = Array.from({ length: 9 }, (_, i) => i / 8).flatMap((step) => {
    const top = cy - tip.h - gap + step * (tip.h + 2 * gap);
    const left = cx - tip.w - gap + step * (tip.w + 2 * gap);
    return [
      { left: cx + gap, top },
      { left: cx - gap - tip.w, top },
      { left, top: cy + gap },
      { left, top: cy - gap - tip.h },
    ];
  });
  return spots
    .map(({ left, top }) => ({
      left: Math.min(Math.max(0, frame.w - tip.w), Math.max(0, left)),
      top: Math.min(frame.h - tip.h + 64, Math.max(-96, top)),
    }))
    .reduce((best, spot) => (cost(spot) < cost(best) ? spot : best));
}

function Scatter({
  index,
  marks,
  points,
  width,
  fitHeight,
  phone,
  hover,
  onHover,
  t,
}: {
  index: ModelIndexKey;
  marks: Mark[];
  points: ModelIndexPoint[];
  width: number;
  /** Full screen hands the chart its height instead of deriving one from the width. */
  fitHeight?: number;
  phone: boolean;
  hover: string | null;
  onHover: OnHover;
  t: Translate;
}) {
  const [lineFocus, setLineFocus] = useState<string | null>(null);
  const plotted = points.filter((point) => point.cost !== undefined && point.cost > 0);
  const left = MARGIN.left;
  const right = width - MARGIN.right;
  const top = MARGIN.top;
  const measure = measurer();
  const caption = wrapLines(`${t("modelIndex.axis.cost")}\u00a0→`, right - left, (text) => (measure(text) * 11) / 10.5);
  const height =
    fitHeight ??
    Math.round(Math.min(420, Math.max(300, width * 0.62, phone ? Math.min(360, width * 1.15) : 0))) + (caption.length - 1) * CAPTION_LINE;
  const bottom = height - (caption.length - 1) * CAPTION_LINE - MARGIN.bottom;

  const costs = plotted.map((point) => point.cost!);
  const xMin = costs.length ? Math.min(...costs) / 1.6 : 1;
  const xMax = costs.length ? Math.max(...costs) * 1.6 : 1000;
  const x = (usd: number) =>
    Math.min(right, Math.max(left, left + ((Math.log10(usd) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin))) * (right - left)));
  const xTicks = fitLogTicks(xMin, xMax, right - left, (usd) => measure(formatCostTick(usd)));

  const scores = plotted.map((point) => point.score);
  const lo = scores.length ? Math.min(...scores) : 0;
  const hi = scores.length ? Math.max(...scores) : 100;
  const pad = (hi - lo) * 0.1 || 1;
  const { domain: [y0, y1], ticks: yTicks } = linearTicks(Math.max(0, lo - pad), Math.min(PERCENT.has(index) ? 100 : Infinity, hi + pad), 5);
  const y = (score: number) => bottom - ((score - y0) / (y1 - y0)) * (bottom - top);

  const unit = unitOf(index);
  const title = t(AXIS_KEY[index]);
  const dots = useRef(new Map<string, Element>());
  const gradient = `mi-best${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const yItems = yTicks.map((tick) => ({ key: `${unit}:${tick}`, label: formatTick(unit, tick), at: y(tick) }));
  const xItems = xTicks.map((tick) => ({ key: String(tick), label: formatCostTick(tick), at: x(tick) }));
  const yLeaving = useLeaving(yItems);
  const xLeaving = useLeaving(xItems);
  const titleLeaving = useLeaving([{ key: title }]);

  const at = new Map(plotted.map((point) => [point.key, { x: x(point.cost!), y: y(point.score) }]));
  const lab = new Set(plotted.filter((point) => point.reported === "lab").map((point) => point.key));
  const byModel = new Map<string, ModelIndexPoint[]>();
  for (const point of plotted) byModel.set(point.model, [...(byModel.get(point.model) ?? []), point]);
  for (const list of byModel.values()) list.sort((a, b) => effortRank(a.effort) - effortRank(b.effort));
  const models = [...new Map(marks.map((mark) => [mark.model, mark])).values()];
  const ends = new Set([...byModel.values()].filter((list) => list.length > 1).map((list) => list[list.length - 1]!.key));
  const rest = (mark: Mark): Spot => ({ x: mark.cost ? x(mark.cost) : left, y: bottom });
  const focus = (hover ? marks.find((mark) => mark.key === hover)?.model : undefined) ?? lineFocus;
  const dim = (model: string) => (focus && focus !== model ? "dim" : "");
  const avoidFor = (key: string): Avoid => {
    const model = plotted.find((point) => point.key === key)?.model;
    return { dots: [...at.values()], line: (byModel.get(model ?? "") ?? []).map((point) => at.get(point.key)!) };
  };

  const quad = plotted.length >= 3 ? { x: x(10 ** median(costs.map(Math.log10))), y: y(median(scores)) } : undefined;
  const bestValue = t("modelIndex.bestValue");
  const frontier = paretoFrontier(plotted).map((point) => at.get(point.key)!);
  const labels = placeLabels(
    [...byModel.values()]
      .sort((a, b) => Math.max(...b.map((p) => p.score)) - Math.max(...a.map((p) => p.score)))
      .map((list) => ({
        id: list[0]!.model,
        text: shortLabel(list[0]!.label),
        anchors: [list[list.length - 1]!, list[0]!, ...list.slice(1, -1)].map((point) => at.get(point.key)!),
      })),
    [
      ...[...at.values()].map((spot) => ({ x: spot.x - 5, y: spot.y - 5, w: 10, h: 10 })),
      ...(quad ? [{ x: left + 2, y: top + 2, w: bestValue.length * 7 + 10, h: 14 }] : []),
    ],
    { left, top, right, bottom },
    measurer(),
  );

  return (
    <svg width={width} height={height} className="block overflow-visible" role="img" aria-label={title}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--color-ink)", stopOpacity: 0.085 }} />
          <stop offset="1" style={{ stopColor: "var(--color-ink)", stopOpacity: 0.02 }} />
        </linearGradient>
      </defs>
      <path
        data-mi-line
        fill={`url(#${gradient})`}
        style={{ d: `path("M${left} ${top}H${quad?.x ?? left}V${quad?.y ?? top}H${left}Z")`, opacity: quad ? 1 : 0 } as React.CSSProperties}
      />
      {[...yItems.map((item) => [item, true] as const), ...yLeaving.map((item) => [item, false] as const)].map(([item, live]) => (
        <g
          key={`y${item.key}`}
          data-mi-move
          data-mi-enter
          data-mi-leave={live ? undefined : ""}
          style={{ transform: `translate(0px, ${item.at}px)`, opacity: live ? 1 : 0 }}
        >
          <line x1={left} x2={right} className="stroke-hairline" strokeWidth={1} style={{ opacity: 0.7 }} />
          <text x={left - 8} dy="0.32em" textAnchor="end" className="fill-ink-secondary text-[10.5px] tabular-nums">
            {item.label}
          </text>
        </g>
      ))}
      {[...xItems.map((item) => [item, true] as const), ...xLeaving.map((item) => [item, false] as const)].map(([item, live]) => (
        <g
          key={`x${item.key}`}
          data-mi-move
          data-mi-enter
          data-mi-leave={live ? undefined : ""}
          style={{ transform: `translate(${item.at}px, 0px)`, opacity: live ? 1 : 0 }}
        >
          <line y1={top} y2={bottom} className="stroke-hairline" strokeWidth={1} style={{ opacity: 0.35 }} />
          <text y={bottom + 16} textAnchor="middle" className="fill-ink-secondary text-[10.5px] tabular-nums">
            {item.label}
          </text>
        </g>
      ))}
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="stroke-hairline" strokeWidth={1} />
      {[[title, true] as const, ...titleLeaving.map((item) => [item.key, false] as const)].map(([text, live]) => (
        <text
          key={text}
          data-mi-move
          data-mi-rise={live ? "" : undefined}
          data-mi-leave={live ? undefined : ""}
          y={12}
          className="fill-ink-secondary text-[11px] font-medium"
          style={{ opacity: live ? 1 : 0, transform: live ? undefined : "translateY(-6px)" }}
        >
          ↑ {text}
        </text>
      ))}
      <text x={(left + right) / 2} y={height - 8 - (caption.length - 1) * CAPTION_LINE} textAnchor="middle" className="fill-ink-secondary text-[11px]">
        {caption.length > 1
          ? caption.map((line, i) => (
              <tspan key={i} x={(left + right) / 2} dy={i ? CAPTION_LINE : 0}>
                {line}
              </tspan>
            ))
          : caption[0]}
      </text>
      <text
        data-mi-move
        x={left + 8}
        y={top + 13}
        className="pointer-events-none fill-ink-secondary text-[9.5px] font-semibold uppercase tracking-[0.08em]"
        style={{ opacity: quad ? 0.8 : 0 }}
      >
        {bestValue}
      </text>
      <path
        data-mi-line
        fill="none"
        strokeWidth={9}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-ink"
        style={{ d: `path("${padPath(frontier.length ? frontier : [{ x: left, y: bottom }], FRONTIER_SLOTS)}")`, opacity: frontier.length > 1 ? 0.08 : 0 } as React.CSSProperties}
      />
      {models.map((mark) => {
        const list = byModel.get(mark.model) ?? [];
        return (
          <g key={`line-${mark.model}`} data-mi-focus={dim(mark.model)}>
            <path
              data-mi-line
              fill="none"
              strokeWidth={1.25}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={list.some((point) => lab.has(point.key)) ? "2.5 2.5" : undefined}
              style={{
                stroke: color(mark.provider),
                opacity: list.length > 1 ? 0.8 : 0,
                d: `path("${padPath(list.length ? list.map((point) => at.get(point.key)!) : [rest(mark)], LINE_SLOTS)}")`,
              } as React.CSSProperties}
            />
          </g>
        );
      })}
      {marks.map((mark) => {
        const spot = at.get(mark.key);
        const { x: px, y: py } = spot ?? rest(mark);
        const hollow = lab.has(mark.key);
        return (
          <g key={mark.key} data-mi-focus={dim(mark.model)}>
            <g
              data-mi-move
              style={{
                transform: `translate(${px}px, ${py}px)`,
                opacity: spot ? 1 : 0,
                pointerEvents: spot ? undefined : "none",
              }}
            >
              <g data-mi-pop style={{ transform: `scale(${hover === mark.key ? 1.6 : 1})` }}>
                <circle
                  data-mi-paint
                  r={6}
                  fill="none"
                  strokeWidth={1}
                  style={{ stroke: color(mark.provider), opacity: ends.has(mark.key) ? 0.6 : 0 }}
                />
                <path
                  data-mi-paint
                  d={shapeOf(mark.model)}
                  paintOrder="stroke"
                  style={
                    hollow
                      ? { fill: "var(--color-card)", stroke: color(mark.provider), strokeWidth: 2.5 }
                      : { fill: color(mark.provider), stroke: "var(--color-card)", strokeWidth: 3 }
                  }
                />
              </g>
              <circle
                ref={(el) => {
                  if (el) dots.current.set(mark.key, el);
                  else dots.current.delete(mark.key);
                }}
                r={12}
                fill="transparent"
                tabIndex={spot ? 0 : -1}
                aria-label={`${mark.label} ${mark.effort}`}
                className="pointer-events-none outline-none"
                onFocus={(e) => onHover(mark.key, e.currentTarget, avoidFor(mark.key))}
                onBlur={() => onHover(null)}
              />
            </g>
          </g>
        );
      })}
      <rect
        x={left - 14}
        y={top - 14}
        width={right - left + 28}
        height={bottom - top + 28}
        fill="transparent"
        onMouseMove={(e) => {
          const frame = e.currentTarget.getBoundingClientRect();
          const pointer = { x: e.clientX - frame.left + left - 14, y: e.clientY - frame.top + top - 14 };
          let nearest: string | null = null;
          let reach = 22;
          for (const [key, spot] of at) {
            const gap = Math.hypot(spot.x - pointer.x, spot.y - pointer.y);
            if (gap < reach) [nearest, reach] = [key, gap];
          }
          let line: string | null = null;
          let near = 7;
          for (const [model, list] of nearest ? [] : byModel) {
            for (let i = 1; i < list.length; i++) {
              const gap = segmentGap(pointer, at.get(list[i - 1]!.key)!, at.get(list[i]!.key)!);
              if (gap < near) [line, near] = [model, gap];
            }
          }
          setLineFocus(line);
          if (nearest !== hover) onHover(nearest, nearest ? dots.current.get(nearest) : undefined, nearest ? avoidFor(nearest) : undefined);
        }}
        onMouseLeave={() => {
          setLineFocus(null);
          onHover(null);
        }}
      />
      {models.map((mark) => {
        const list = byModel.get(mark.model);
        const label = labels.get(mark.model);
        const { x: lx, y: ly } = label ?? (list ? at.get(list[list.length - 1]!.key)! : rest(mark));
        const [from, to] = label?.leader ?? [{ x: lx, y: ly }, { x: lx, y: ly }];
        return (
          <g key={`label-${mark.model}`} data-mi-focus={dim(mark.model)}>
            <path
              data-mi-line
              fill="none"
              strokeWidth={1}
              className="stroke-ink-secondary"
              style={{ d: `path("M${from.x.toFixed(1)} ${from.y.toFixed(1)}L${to.x.toFixed(1)} ${to.y.toFixed(1)}")`, opacity: label?.leader ? 0.55 : 0 } as React.CSSProperties}
            />
            <text
              data-mi-move
              className="pointer-events-none fill-ink text-[10.5px] font-medium"
              style={{
                stroke: "var(--color-card)",
                strokeWidth: 3,
                strokeLinejoin: "round",
                paintOrder: "stroke",
                transform: `translate(${lx}px, ${ly}px)`,
                opacity: label ? 0.92 : 0,
              }}
            >
              {shortLabel(mark.label)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Bars({
  marks,
  points,
  index,
  onHover,
}: {
  marks: Mark[];
  points: ModelIndexPoint[];
  index: ModelIndexKey;
  onHover: OnHover;
}) {
  // Cost ranks cheapest blended price first; every score ranks best first.
  const ranked = [...points].sort((a, b) => (index === "cost" ? a.score - b.score : b.score - a.score));
  const rank = new Map(ranked.map((point, i) => [point.key, i]));
  const byKey = new Map(points.map((point) => [point.key, point]));
  const max = linearTicks(0, Math.max(1, ...points.map((point) => point.score))).domain[1];
  return (
    <div data-mi-size className="relative" style={{ height: ranked.length * ROW }}>
      <div aria-hidden className="absolute inset-y-0 w-px bg-hairline/70" style={{ left: "calc(40% + 0.625rem)" }} />
      {marks.map((mark) => {
        const point = byKey.get(mark.key);
        const hollow = point?.reported === "lab";
        return (
          <div
            key={mark.key}
            data-mi-move
            tabIndex={point ? 0 : -1}
            onMouseEnter={(e) => onHover(mark.key, e.currentTarget)}
            onMouseLeave={() => onHover(null)}
            onFocus={(e) => onHover(mark.key, e.currentTarget)}
            onBlur={() => onHover(null)}
            className="absolute inset-x-0 top-0 flex items-center gap-2.5 rounded-md outline-none hover:bg-control/40 focus-visible:bg-control/40"
            style={{
              height: ROW,
              transform: `translateY(${(rank.get(mark.key) ?? ranked.length) * ROW}px)`,
              opacity: point ? 1 : 0,
              pointerEvents: point ? undefined : "none",
            }}
          >
            <div className="flex w-[40%] min-w-0 shrink-0 items-center justify-end gap-1.5 text-[12px]">
              <span className="truncate font-medium text-ink">{mark.label}</span>
              {mark.effort !== "all" && <span className="shrink-0 text-[11px] text-ink-secondary">{mark.effort}</span>}
              <Shape provider={mark.provider} model={mark.model} hollow={hollow} />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div
                data-mi-bar
                className="h-3.5 rounded-r-[4px]"
                style={{
                  width: `calc((100% - ${index === "cost" ? 5.5 : 4}rem) * ${point ? point.score / max : 0})`,
                  backgroundColor: hollow ? `color-mix(in srgb, ${color(mark.provider)} 16%, transparent)` : color(mark.provider),
                  boxShadow: hollow ? `inset 0 0 0 1.5px ${color(mark.provider)}` : undefined,
                }}
              />
              <span className="shrink-0 text-[12px] tabular-nums text-ink">{point ? formatValue(index, point) : ""}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ModelIndexSection() {
  const { t } = useI18n();
  const { state } = useStore();
  const catalog = useMemo(() => winkCatalog(state.instances ?? []), [state.instances]);
  const [index, setIndex] = useState<ModelIndexKey>(INDEXES[0] ?? "intelligence");
  const [view, setView] = useState<View>("scatter");
  const [hover, setHover] = useState<Hover | null>(null);
  const [place, setPlace] = useState<{ key: string; left: number; top: number } | null>(null);
  const [full, setFull] = useState(false);
  const [wrapRef, width, height] = useSize();
  const tipRef = useRef<HTMLDivElement>(null);
  const phone = isPhone();

  const shown = index === "cost" ? "bars" : view;
  const { points, missing } = useMemo(() => indexView(index, catalog), [index, catalog]);
  const noCost = shown === "scatter" ? points.filter((point) => !point.cost).length : 0;
  const providers = CHART_PROVIDERS.filter((provider) => points.some((point) => chartProvider(point.provider) === provider));
  const sources = [...new Map(points.map((point) => [point.source, point])).values()];
  const hovered = hover ? points.find((point) => point.key === hover.key) : undefined;
  const labShown = points.some((point) => point.reported === "lab");
  const frontier = shown === "scatter" && paretoFrontier(points).length > 1;
  const charted = shown === "scatter" ? points.filter((point) => point.cost) : points;
  const lines = shown === "scatter" && new Set(charted.map((point) => point.model)).size < charted.length;

  useEffect(() => {
    // Capture phase, so a focused terminal never sees the keystroke.
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.code !== "KeyI") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || e.isComposing) return;
      setHover(null);
      setIndex((current) => INDEXES[(INDEXES.indexOf(current) + 1) % INDEXES.length]!);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!full || !wrap) return;
    // Best effort: real full screen, turned sideways, where the browser allows it; the fixed overlay covers the rest.
    const turn: { lock?: (to: "landscape") => Promise<void>; unlock?: () => void } | undefined = window.screen?.orientation;
    let live = true;
    let entered = false;
    let shown = false;
    void wrap
      .requestFullscreen?.()
      ?.then(async () => {
        if (!live) return document.exitFullscreen();
        entered = true;
        await turn?.lock?.("landscape");
      })
      .catch(() => undefined);
    // Back on Android leaves real full screen first, even before the request settles; follow it out
    const onExit = () => {
      if (document.fullscreenElement) shown = true;
      else if (shown) setFull(false);
    };
    document.addEventListener("fullscreenchange", onExit);
    return () => {
      live = false;
      document.removeEventListener("fullscreenchange", onExit);
      if (entered) turn?.unlock?.();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [full, wrapRef]);

  const onHover: OnHover = (key, el, avoid) => {
    const wrap = wrapRef.current;
    if (!key || !el || !wrap) return setHover(null);
    const box = el.getBoundingClientRect();
    const frame = wrap.getBoundingClientRect();
    setHover({ key, box: { x: box.left - frame.left, y: box.top - frame.top, w: box.width, h: box.height }, avoid });
  };

  useLayoutEffect(() => {
    const tip = tipRef.current;
    const wrap = wrapRef.current;
    if (!hover || !tip || !wrap) return;
    const frame = { w: wrap.offsetWidth, h: wrap.offsetHeight };
    setPlace({ key: hover.key, ...placeTooltip(hover.box, { w: tip.offsetWidth, h: tip.offsetHeight }, frame, shown, hover.avoid) });
  }, [hover, shown, wrapRef]);

  return (
    <div className="model-index flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("modelIndex.subtitle")}</p>
      <div className="rounded-xl border border-hairline/40 bg-card shadow-sm max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:shadow-none">
        <div className="flex flex-col gap-2.5 p-4 pb-3 max-md:px-0 max-md:pt-0">
          <div className="flex min-w-0 items-center gap-3">
            <Segmented
              label={t("modelIndex.indexLabel")}
              value={index}
              options={INDEXES.map((id) => ({ id, label: t(INDEX_KEY[id]) }))}
              onChange={(id) => {
                setHover(null);
                setIndex(id);
              }}
            />
            <kbd
              aria-label={t("shortcuts.modelsIndexCycle")}
              className="shrink-0 font-mono text-[10px] tracking-wide text-ink-secondary/55 max-md:hidden"
            >
              Alt+Shift+I
            </kbd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<View>
              label={t("modelIndex.viewLabel")}
              value={shown}
              options={[
                { id: "scatter", label: t("modelIndex.view.scatter") },
                { id: "bars", label: t("modelIndex.view.bars") },
              ]}
              onChange={(id) => {
                setHover(null);
                setView(id);
              }}
              disabled={(id) => id === "scatter" && index === "cost"}
            />
            {phone && shown === "scatter" && points.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setHover(null);
                  setFull(true);
                }}
                className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-control"
                aria-label={t("modelIndex.fullScreen")}
              >
                <Maximize2 size={16} />
              </button>
            )}
          </div>
        </div>

        <div className="px-4 pb-4 max-md:px-0 max-md:pb-2">
          {shown === "bars" && points.length > 0 && (
            <div className="mb-2 text-[11.5px] font-medium text-ink-secondary">{t(AXIS_KEY[index])}</div>
          )}
          <div ref={wrapRef} className={full ? "fixed inset-0 z-[60] overflow-y-auto bg-panel px-3 pb-3 pt-12" : "relative min-w-0"}>
            {full && (
              <>
                <div className="absolute left-4 top-3.5 text-[13px] font-semibold text-ink">{t(INDEX_KEY[index])}</div>
                <button
                  type="button"
                  onClick={() => {
                    setHover(null);
                    setFull(false);
                  }}
                  className="absolute right-2 top-1.5 flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-control"
                  aria-label={t("modelIndex.exitFullScreen")}
                >
                  <X size={19} />
                </button>
              </>
            )}
            {points.length === 0 ? (
              <p className="py-10 text-center text-[13px] text-ink-secondary">{t("modelIndex.empty")}</p>
            ) : (
              <div key={shown} data-mi-view>
                {shown === "scatter" ? (
                  <Scatter
                    index={index}
                    marks={MARKS}
                    points={points}
                    width={width}
                    fitHeight={full ? height : undefined}
                    phone={phone}
                    hover={hover?.key ?? null}
                    onHover={onHover}
                    t={t}
                  />
                ) : (
                  <Bars marks={MARKS} points={points} index={index} onHover={onHover} />
                )}
              </div>
            )}
            {hovered && hover && (
              <div
                ref={tipRef}
                role="tooltip"
                className="pointer-events-none absolute z-10 w-[224px] rounded-lg border border-hairline/60 bg-raised px-3 py-2 text-[12px] shadow-lg"
                style={{ left: place?.left ?? 0, top: place?.top ?? 0, visibility: place?.key === hover.key ? undefined : "hidden" }}
              >
                <div className="flex items-center gap-1.5 text-ink">
                  <Shape provider={hovered.provider} model={hovered.model} hollow={hovered.reported === "lab"} />
                  <span className="truncate font-medium">{hovered.label}</span>
                  {hovered.effort !== "all" && (
                    <span className="shrink-0 rounded bg-inset px-1.5 text-[11px] text-ink-secondary">{hovered.effort}</span>
                  )}
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="shrink-0 text-[17px] font-semibold leading-tight text-ink">{formatValue(index, hovered)}</span>
                  <span className="truncate text-ink-secondary">{t(index === "cost" ? "modelIndex.tooltip.cost" : INDEX_KEY[index])}</span>
                </div>
                <div className="mt-1 flex justify-between gap-3 tabular-nums">
                  <span className="text-ink-secondary">{t(index === "cost" ? "modelIndex.tooltip.blended" : "modelIndex.tooltip.runCost")}</span>
                  <span className="text-ink">{index === "cost" ? formatUsd(hovered.score) : hovered.cost ? formatCost(hovered.cost) : "-"}</span>
                </div>
                {index !== "cost" && (
                  <>
                    <div className="flex justify-between gap-3 tabular-nums">
                      <span className="break-keep text-ink-secondary">{t("modelIndex.tooltip.cost")}</span>
                      <span className="shrink-0 text-ink">{hovered.price ? formatPrice(hovered.price) : "-"}</span>
                    </div>
                    <p className="text-[11px] leading-snug text-ink-secondary">{t("modelIndex.tooltip.sameEffort")}</p>
                  </>
                )}
                <p className="mt-1.5 border-t border-hairline/40 pt-1.5 text-[11px] leading-snug text-ink-secondary">
                  {t("modelIndex.tooltip.source")}: {hovered.sourceLabel} · {hovered.date}
                </p>
                {hovered.reported === "lab" && (
                  <p className="mt-1 text-[11px] leading-snug text-ink-secondary">
                    {t("modelIndex.labReported", { lab: labName(hovered.provider) })}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {providers.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-hairline/30 px-4 py-3 text-[12px] text-ink-secondary max-md:px-0">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {providers.map((provider) => (
                <span key={provider} className="flex items-center gap-1.5">
                  <Swatch provider={provider} />
                  {provider === "other" ? t("modelIndex.provider.other") : PROVIDER_NAME[provider]}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-secondary/80">
              {lines && (
                <span className="flex items-center gap-1.5">
                  <svg width="20" height="12" viewBox="0 0 20 12" aria-hidden>
                    <path d="M2 10L14 4" className="stroke-ink-secondary" strokeWidth={1.25} strokeLinecap="round" />
                    <circle cx={15} cy={3.5} r={3.5} fill="none" className="stroke-ink-secondary" strokeWidth={1} />
                  </svg>
                  {t("modelIndex.effortLine")}
                </span>
              )}
              {frontier && (
                <span className="flex items-center gap-1.5">
                  <svg width="16" height="8" aria-hidden>
                    <path d="M3 4H13" className="stroke-ink-secondary" strokeWidth={6} strokeLinecap="round" style={{ opacity: 0.35 }} />
                  </svg>
                  {t("modelIndex.frontier")}
                </span>
              )}
              {labShown && (
                <span className="flex items-center gap-1.5">
                  <Shape hollow />
                  {t("modelIndex.hollow")}
                </span>
              )}
            </div>
            {noCost > 0 && <p>{t("modelIndex.noCost", { count: noCost })}</p>}
            {index === "coding" && labShown && <p>{t("modelIndex.labCoding")}</p>}
          </div>
        )}
      </div>

      {missing.length > 0 && (
        <div className="rounded-xl border border-hairline/40 bg-card px-4 py-3">
          <div className="text-[13px] font-medium text-ink">{t("modelIndex.noData")}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {missing.map((model) => (
              <span key={model.model} className="flex items-center gap-1.5 rounded-md bg-inset px-2 py-1 text-[12px] text-ink-secondary">
                <Swatch provider={model.provider} />
                {model.label}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="text-[12px] leading-relaxed text-ink-secondary">
        <div>{t("modelIndex.asOf", { date: MODEL_INDEX_AS_OF })}</div>
        {sources.length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer select-none">
              {t("modelIndex.sources")} {[...new Set(sources.map((point) => point.sourceLabel))].join(" · ")}
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {sources.map((point) => (
                <li key={point.source} className="truncate">
                  <a href={point.source} target="_blank" rel="noreferrer" className="text-accent-text underline-offset-2 hover:underline">
                    {point.source.replace(/^https:\/\//, "")}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
