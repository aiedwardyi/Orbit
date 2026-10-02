// App settings → Model index (experimental): lab-published benchmark scores
// against cost, per model and effort, so picking a model never needs a web
// search. Numbers come only from shared/model-index-data.ts; nothing is fetched.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-catalog";
import { cn } from "@/lib/cn";
import {
  CHART_PROVIDERS,
  MODEL_INDEXES,
  chartProvider,
  effortRank,
  indexView,
  linearTicks,
  logTicks,
  markUniverse,
  winkCatalog,
  type ChartProvider,
  type ModelIndexPoint,
} from "@/lib/model-index";
import { MODEL_INDEX_AS_OF, type ModelIndexKey } from "../../shared/model-index-data.ts";
import { Card } from "./SettingsPrimitives";
import "./ModelIndexSection.css";

type View = "scatter" | "bars";
type Mark = ReturnType<typeof markUniverse>[number];
type Hover = { key: string; x: number; y: number };

const INDEX_KEY: Record<ModelIndexKey, MessageKey> = {
  intelligence: "modelIndex.index.intelligence",
  coding: "modelIndex.index.coding",
  agentic: "modelIndex.index.agentic",
  general: "modelIndex.index.general",
  legal: "modelIndex.index.legal",
  cost: "modelIndex.index.cost",
};

const PROVIDER_NAME: Record<Exclude<ChartProvider, "other">, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
};

const CIRCLE = "M-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0z";
const SHAPE: Record<ChartProvider, string> = {
  anthropic: "M-4.5-4.5h9v9h-9z",
  openai: "M0-6L6 0L0 6L-6 0z",
  google: CIRCLE,
  xai: "M0-6L5.8 4.2H-5.8z",
  other: CIRCLE,
};

const ROW = 26;
const MARGIN = { top: 14, right: 18, bottom: 28, left: 40 };

const color = (provider: string) => `var(--mi-${chartProvider(provider)})`;
const shortLabel = (label: string) => label.replace(/^Claude /, "");
const formatScore = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const formatCost = (usd: number) =>
  usd >= 100 ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(usd < 10 ? 2 : 1)}`;
const formatCostTick = (usd: number) => (usd >= 1000 ? `$${usd / 1000}k` : `$${usd}`);
const formatValue = (index: ModelIndexKey, value: number) => (index === "cost" ? formatCost(value) : formatScore(value));

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function Shape({ provider }: { provider: string }) {
  return (
    <svg width="12" height="12" viewBox="-6.5 -6.5 13 13" aria-hidden className="shrink-0">
      <path d={SHAPE[chartProvider(provider)]} style={{ fill: color(provider) }} />
    </svg>
  );
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
  return (
    <div role="radiogroup" aria-label={label} className="flex min-w-0 gap-0.5 overflow-x-auto rounded-lg bg-inset p-0.5">
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
              "shrink-0 whitespace-nowrap rounded-[max(0px,calc(var(--radius-lg)_-_2px))] px-2.5 py-1 text-[12.5px] font-medium transition-colors disabled:opacity-40",
              selected ? "bg-raised text-ink shadow-sm" : "text-ink-secondary enabled:hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Greedy label placement around each line's end, then its start; skips a label rather than overlap. */
function placeLabels(
  items: Array<{ id: string; text: string; ends: Array<{ x: number; y: number }> }>,
  dots: Array<{ x: number; y: number }>,
  bounds: { left: number; top: number; right: number; bottom: number },
) {
  const placed = dots.map((dot) => ({ x: dot.x - 6, y: dot.y - 6, w: 12, h: 12 }));
  const out = new Map<string, { x: number; y: number; anchor: "start" | "end" | "middle" }>();
  for (const item of [...items].sort((a, b) => a.ends[0]!.y - b.ends[0]!.y)) {
    const w = item.text.length * 5.9 + 4;
    const h = 13;
    const candidates = item.ends.flatMap((end) => [
      { x: end.x + 9, y: end.y - h / 2, anchor: "start" as const, tx: end.x + 9 },
      { x: end.x - 9 - w, y: end.y - h / 2, anchor: "end" as const, tx: end.x - 9 },
      { x: end.x - w / 2, y: end.y - 9 - h, anchor: "middle" as const, tx: end.x },
      { x: end.x - w / 2, y: end.y + 9, anchor: "middle" as const, tx: end.x },
    ]);
    const spot = candidates.find(
      (c) =>
        c.x >= bounds.left &&
        c.x + w <= bounds.right &&
        c.y >= bounds.top - 10 &&
        c.y + h <= bounds.bottom &&
        !placed.some((p) => c.x < p.x + p.w && c.x + w > p.x && c.y < p.y + p.h && c.y + h > p.y),
    );
    if (!spot) continue;
    placed.push({ x: spot.x, y: spot.y, w, h });
    out.set(item.id, { x: spot.tx, y: spot.y + h - 3, anchor: spot.anchor });
  }
  return out;
}

function Scatter({
  marks,
  points,
  width,
  hover,
  onHover,
}: {
  marks: Mark[];
  points: ModelIndexPoint[];
  width: number;
  hover: string | null;
  onHover: (key: string | null, el?: Element) => void;
}) {
  const height = Math.round(Math.min(380, Math.max(260, width * 0.56)));
  const plotted = points.filter((point) => point.cost !== undefined && point.cost > 0);
  const left = MARGIN.left;
  const right = width - MARGIN.right;
  const top = MARGIN.top;
  const bottom = height - MARGIN.bottom;

  const costs = plotted.map((point) => point.cost!);
  const xMin = costs.length ? Math.min(...costs) / 1.6 : 1;
  const xMax = costs.length ? Math.max(...costs) * 1.6 : 1000;
  const x = (usd: number) =>
    Math.min(right, Math.max(left, left + ((Math.log10(usd) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin))) * (right - left)));
  const xTicks = logTicks(xMin, xMax);

  const scores = plotted.map((point) => point.score);
  const lo = scores.length ? Math.min(...scores) : 0;
  const hi = scores.length ? Math.max(...scores) : 100;
  const pad = (hi - lo) * 0.1 || 1;
  const { domain: [y0, y1], ticks: yTicks } = linearTicks(lo - pad, hi + pad, 5);
  const y = (score: number) => bottom - ((score - y0) / (y1 - y0)) * (bottom - top);

  const at = new Map(plotted.map((point) => [point.key, { x: x(point.cost!), y: y(point.score) }]));
  const byModel = new Map<string, ModelIndexPoint[]>();
  for (const point of plotted) byModel.set(point.model, [...(byModel.get(point.model) ?? []), point]);
  for (const list of byModel.values()) list.sort((a, b) => effortRank(a.effort) - effortRank(b.effort));
  const models = [...new Map(marks.map((mark) => [mark.model, mark])).values()];
  const labels = placeLabels(
    [...byModel.entries()].map(([model, list]) => ({
      id: model,
      text: shortLabel(list[0]!.label),
      ends: [at.get(list[list.length - 1]!.key)!, at.get(list[0]!.key)!],
    })),
    [...at.values()],
    { left, top, right, bottom },
  );

  return (
    <svg width={width} height={height} className="block overflow-visible" role="img">
      {yTicks.map((tick) => (
        <g key={`y${tick}`} data-mi-move data-mi-enter style={{ transform: `translate(0px, ${y(tick)}px)` }}>
          <line x1={left} x2={right} className="stroke-hairline" strokeWidth={1} />
          <text x={left - 8} dy="0.32em" textAnchor="end" className="fill-ink-secondary text-[10.5px] tabular-nums">
            {formatScore(tick)}
          </text>
        </g>
      ))}
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="stroke-hairline" strokeWidth={1} />
      {xTicks.map((tick) => (
        <g key={`x${tick}`} data-mi-move data-mi-enter style={{ transform: `translate(${x(tick)}px, 0px)` }}>
          <line y1={bottom} y2={bottom + 4} className="stroke-hairline" strokeWidth={1} />
          <text y={bottom + 16} textAnchor="middle" className="fill-ink-secondary text-[10.5px] tabular-nums">
            {formatCostTick(tick)}
          </text>
        </g>
      ))}
      {models.map((mark) => {
        const list = byModel.get(mark.model) ?? [];
        const d = list.map((point, i) => `${i ? "L" : "M"}${at.get(point.key)!.x} ${at.get(point.key)!.y}`).join("");
        return (
          <path
            key={`line-${mark.model}`}
            data-mi-line
            fill="none"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{
              stroke: color(mark.provider),
              opacity: list.length > 1 ? (mark.wink ? 0.55 : 0.2) : 0,
              d: `path("${d || "M0 0"}")`,
            } as React.CSSProperties}
          />
        );
      })}
      {marks.map((mark) => {
        const spot = at.get(mark.key);
        const px = spot?.x ?? (mark.cost ? x(mark.cost) : left);
        const py = spot?.y ?? bottom;
        return (
          <g
            key={mark.key}
            data-mi-move
            style={{
              transform: `translate(${px}px, ${py}px) scale(${hover === mark.key ? 1.3 : 1})`,
              opacity: spot ? (mark.wink ? 1 : 0.35) : 0,
              pointerEvents: spot ? undefined : "none",
            }}
          >
            <path
              d={SHAPE[chartProvider(mark.provider)]}
              strokeWidth={4}
              paintOrder="stroke"
              style={{ fill: color(mark.provider), stroke: "var(--color-card)" }}
            />
            <circle
              r={11}
              fill="transparent"
              tabIndex={spot ? 0 : -1}
              aria-label={`${mark.label} ${mark.effort}`}
              className="cursor-default outline-none"
              onMouseEnter={(e) => onHover(mark.key, e.currentTarget)}
              onMouseLeave={() => onHover(null)}
              onFocus={(e) => onHover(mark.key, e.currentTarget)}
              onBlur={() => onHover(null)}
            />
          </g>
        );
      })}
      {models.map((mark) => {
        const label = labels.get(mark.model);
        return (
          <text
            key={`label-${mark.model}`}
            data-mi-move
            textAnchor={label?.anchor ?? "start"}
            className="pointer-events-none fill-ink text-[10.5px] font-medium"
            style={{
              transform: label ? `translate(${label.x}px, ${label.y}px)` : undefined,
              opacity: label ? (mark.wink ? 0.9 : 0.45) : 0,
            }}
          >
            {shortLabel(mark.label)}
          </text>
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
  onHover: (key: string | null, el?: Element) => void;
}) {
  // Cost ranks cheapest first; every score ranks best first.
  const ranked = [...points].sort((a, b) => (index === "cost" ? a.score - b.score : b.score - a.score));
  const rank = new Map(ranked.map((point, i) => [point.key, i]));
  const byKey = new Map(points.map((point) => [point.key, point]));
  const max = linearTicks(0, Math.max(1, ...points.map((point) => point.score))).domain[1];
  return (
    <div data-mi-size className="relative" style={{ height: ranked.length * ROW }}>
      {marks.map((mark) => {
        const point = byKey.get(mark.key);
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
              opacity: point ? (mark.wink ? 1 : 0.45) : 0,
              pointerEvents: point ? undefined : "none",
            }}
          >
            <div className="flex w-[40%] min-w-0 shrink-0 items-center justify-end gap-1.5 text-[12px]">
              <span className="truncate text-ink">{mark.label}</span>
              <span className="shrink-0 text-ink-secondary">{mark.effort}</span>
              <Shape provider={mark.provider} />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <div
                data-mi-bar
                className="h-3.5 rounded-r-[4px]"
                style={{ width: `calc((100% - 4rem) * ${point ? point.score / max : 0})`, background: color(mark.provider) }}
              />
              <span className="shrink-0 text-[12px] tabular-nums text-ink-secondary">
                {point ? formatValue(index, point.score) : ""}
              </span>
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
  const [index, setIndex] = useState<ModelIndexKey>("intelligence");
  const [view, setView] = useState<View>("scatter");
  const [showAll, setShowAll] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const [wrapRef, width] = useWidth();

  // Before the engine list arrives nothing counts as "yours", so show everything.
  const all = showAll || catalog.length === 0;
  const shown = index === "cost" ? "bars" : view;
  const { points, missing } = useMemo(() => indexView(index, catalog), [index, catalog]);
  const marks = useMemo(() => markUniverse(catalog).filter((mark) => all || mark.wink), [catalog, all]);
  const visible = points.filter((point) => all || point.wink);
  const noCost = shown === "scatter" ? visible.filter((point) => !point.cost).length : 0;
  const providers = CHART_PROVIDERS.filter((provider) => visible.some((point) => chartProvider(point.provider) === provider));
  const sources = [...new Map(visible.map((point) => [point.source, point])).values()];
  const hovered = hover ? visible.find((point) => point.key === hover.key) : undefined;

  const onHover = (key: string | null, el?: Element) => {
    const wrap = wrapRef.current;
    if (!key || !el || !wrap) return setHover(null);
    const box = el.getBoundingClientRect();
    const frame = wrap.getBoundingClientRect();
    setHover({ key, x: box.left - frame.left + box.width / 2, y: box.top - frame.top });
  };

  return (
    <div className="model-index flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("modelIndex.subtitle")}</p>
      <Card>
        <div className="flex flex-col gap-3">
          <Segmented
            label={t("modelIndex.indexLabel")}
            value={index}
            options={MODEL_INDEXES.map((id) => ({ id, label: t(INDEX_KEY[id]) }))}
            onChange={(id) => {
              setHover(null);
              setIndex(id);
            }}
          />
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
            {catalog.length > 0 && (
              <button
                type="button"
                aria-pressed={showAll}
                onClick={() => setShowAll(!showAll)}
                className={cn(
                  "rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors",
                  showAll ? "border-accent-border/60 bg-control text-ink" : "border-hairline/60 text-ink-secondary hover:text-ink",
                )}
              >
                {t("modelIndex.showAll")}
              </button>
            )}
          </div>

          <div className="flex items-baseline justify-between gap-3 text-[11.5px] text-ink-secondary">
            <span>{shown === "scatter" ? `↑ ${t(INDEX_KEY[index])}` : index === "cost" ? t("modelIndex.cost.hint") : t(INDEX_KEY[index])}</span>
            {shown === "scatter" && <span>{t("modelIndex.axis.cost")} →</span>}
          </div>

          <div ref={wrapRef} className="relative min-w-0">
            {visible.length === 0 ? (
              <p className="py-10 text-center text-[13px] text-ink-secondary">{t("modelIndex.empty")}</p>
            ) : (
              <div key={shown} className="animate-pop-in motion-reduce:animate-none">
                {shown === "scatter" ? (
                  <Scatter marks={marks} points={visible} width={width} hover={hover?.key ?? null} onHover={onHover} />
                ) : (
                  <Bars marks={marks} points={visible} index={index} onHover={onHover} />
                )}
              </div>
            )}
            {hovered && hover && (
              <div
                role="tooltip"
                className="pointer-events-none absolute z-10 w-[220px] rounded-lg border border-hairline/60 bg-raised px-3 py-2 text-[12px] shadow-lg"
                style={{
                  left: Math.min(Math.max(0, hover.x - 110), width - 220),
                  top: hover.y < 110 ? hover.y + 28 : hover.y - 8,
                  transform: hover.y < 110 ? undefined : "translateY(-100%)",
                }}
              >
                <div className="flex items-center gap-1.5 font-medium text-ink">
                  <Shape provider={hovered.provider} />
                  <span className="truncate">{hovered.label}</span>
                  <span className="shrink-0 font-normal text-ink-secondary">{hovered.effort}</span>
                </div>
                <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
                  <dt className="text-ink-secondary">{t(INDEX_KEY[index])}</dt>
                  <dd className="text-right text-ink">{formatValue(index, hovered.score)}</dd>
                  {index !== "cost" && (
                    <>
                      <dt className="text-ink-secondary">{t("modelIndex.tooltip.cost")}</dt>
                      <dd className="text-right text-ink">{hovered.cost ? formatCost(hovered.cost) : "-"}</dd>
                    </>
                  )}
                  <dt className="text-ink-secondary">{t("modelIndex.tooltip.source")}</dt>
                  <dd className="text-right leading-snug text-ink">{hovered.sourceLabel}</dd>
                  <dt className="text-ink-secondary">{t("modelIndex.tooltip.date")}</dt>
                  <dd className="text-right text-ink">{hovered.date}</dd>
                </dl>
              </div>
            )}
          </div>

          {providers.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-secondary">
              {providers.map((provider) => (
                <span key={provider} className="flex items-center gap-1.5">
                  <Shape provider={provider} />
                  {provider === "other" ? t("modelIndex.provider.other") : PROVIDER_NAME[provider]}
                </span>
              ))}
              {shown === "scatter" && <span className="text-ink-secondary/80">{t("modelIndex.effortLine")}</span>}
              {showAll && <span className="text-ink-secondary/80">{t("modelIndex.faded")}</span>}
            </div>
          )}
          {noCost > 0 && <p className="text-[12px] text-ink-secondary">{t("modelIndex.noCost", { count: noCost })}</p>}
        </div>
      </Card>

      {missing.length > 0 && (
        <Card title={t("modelIndex.noData")} compact>
          <div className="flex flex-wrap gap-1.5">
            {missing.map((model) => (
              <span key={model.model} className="flex items-center gap-1.5 rounded-md bg-inset px-2 py-1 text-[12px] text-ink-secondary">
                <Shape provider={model.provider} />
                {model.label}
              </span>
            ))}
          </div>
        </Card>
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
