import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-catalog";
import { api } from "@/state/store";
import { dayLabel } from "./TeamSection";

type Provider = "claude" | "gpt" | "gemini" | "perplexity" | "search";
type Bars = "cost" | "visitors";
type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface QuorumDay {
  day: string;
  costCents: number;
  costByProvider: Partial<Record<Provider, number>>;
  visitors: number;
  signups: number;
}

interface QuorumStats {
  days: QuorumDay[];
  budget: { dailyCapCents: number; todayCountedCents: number } | null;
  tracking: { costSince: string | null; visitorsSince: string | null };
}

type View =
  | { kind: "data"; stats: QuorumStats; fetchedAt: number; ageMin: number | null }
  | { kind: "notEnabled" | "denied" | "unreachable" };

interface Reply {
  state?: unknown;
  stats?: QuorumStats;
  fetchedAt?: number;
  now?: number;
}

const REFRESH_MS = 5 * 60_000;
const KEPT_KEY = "omb-quorum-kept";
const PROVIDERS: Provider[] = ["claude", "gpt", "gemini", "perplexity", "search"];
const PROVIDER_NAMES = { claude: "Claude", gpt: "GPT", gemini: "Gemini", perplexity: "Perplexity" };

interface Kept {
  stats: QuorumStats;
  fetchedAt: number;
}

let flight: Promise<Reply | null> | null = null;

function money(cents: number): string {
  if (cents <= 0) return "$0";
  if (cents < 1) return "<$0.01";
  return `$${(cents / 100).toFixed(2)}`;
}

function tracked(since: string | null, day: string): boolean {
  return since !== null && day >= since;
}

function hasStats(reply: Reply): reply is Reply & { stats: QuorumStats; fetchedAt: number } {
  return Array.isArray(reply.stats?.days) && Number.isFinite(reply.fetchedAt);
}

/** A private window throws on access; a cache is never worth a crash. */
function keptStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function parseKept(value: unknown): Kept | null {
  if (typeof value !== "object" || value === null) return null;
  const { stats, fetchedAt } = value as { stats?: QuorumStats; fetchedAt?: unknown };
  if (!stats || !Array.isArray(stats.days) || !Number.isFinite(fetchedAt)) return null;
  const dayOk = (day: unknown): day is QuorumDay =>
    typeof day === "object" && day !== null &&
    typeof (day as QuorumDay).day === "string" &&
    Number.isFinite((day as QuorumDay).costCents) &&
    typeof (day as QuorumDay).costByProvider === "object" && (day as QuorumDay).costByProvider !== null &&
    Number.isFinite((day as QuorumDay).visitors) && Number.isFinite((day as QuorumDay).signups);
  const tracking = stats.tracking;
  const budget = stats.budget;
  if (!stats.days.every(dayOk)) return null;
  if (!tracking || typeof tracking !== "object") return null;
  if (![tracking.costSince, tracking.visitorsSince].every((since) => since === null || typeof since === "string")) return null;
  if (budget !== null && budget !== undefined && (typeof budget !== "object" || !Number.isFinite(budget.dailyCapCents) || !Number.isFinite(budget.todayCountedCents))) return null;
  return { stats, fetchedAt: fetchedAt as number };
}

/** The last good stats, so the row paints at once and refreshes quietly. */
function readKept(): Kept | null {
  try {
    const raw = keptStore()?.getItem(KEPT_KEY);
    return raw ? parseKept(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeKept(kept: Kept): void {
  try {
    keptStore()?.setItem(KEPT_KEY, JSON.stringify(kept));
  } catch {
    /* a cache is never worth a crash */
  }
}

function keptView(kept: Kept): View {
  const elapsed = Date.now() - kept.fetchedAt;
  const ageMin = elapsed < 60_000 ? null : Math.max(1, Math.floor(elapsed / 60_000));
  return { kind: "data", stats: kept.stats, fetchedAt: kept.fetchedAt, ageMin };
}

function cacheReply(reply: Reply | null): void {
  if (reply && ["off", "denied", "notEnabled"].includes(String(reply.state))) {
    try {
      keptStore()?.removeItem(KEPT_KEY);
    } catch {
      /* a cache is never worth a crash */
    }
  }
  if (reply && reply.state === "ok" && hasStats(reply)) writeKept({ stats: reply.stats, fetchedAt: reply.fetchedAt });
}

/** One request at a time across the prefetch and the row. */
function fetchQuorum(): Promise<Reply | null> {
  flight ??= api("/api/quorum").then(
    (reply) => {
      flight = null;
      return reply as Reply;
    },
    () => {
      flight = null;
      return null;
    },
  );
  return flight;
}

/** Warms the cache when Settings opens, ahead of the Team tab. */
export function prefetchQuorum(): void {
  void fetchQuorum().then(cacheReply);
}

/** A failed refresh keeps what is on screen; a server error brings its own kept data. */
function nextView(prev: View | null, reply: Reply | null, offset: number): View | null {
  const state = reply?.state;
  if (state === "off") return null;
  if (state === "notEnabled" || state === "denied") return { kind: state };
  if (reply && state === "ok" && hasStats(reply)) return { kind: "data", stats: reply.stats, fetchedAt: reply.fetchedAt, ageMin: null };
  const held = reply && state === "error" && hasStats(reply) ? { stats: reply.stats, fetchedAt: reply.fetchedAt } : prev?.kind === "data" ? prev : null;
  if (held) {
    const ageMin = Math.max(1, Math.floor((Date.now() + offset - held.fetchedAt) / 60_000));
    return { kind: "data", stats: held.stats, fetchedAt: held.fetchedAt, ageMin };
  }
  return state === "error" ? { kind: "unreachable" } : prev;
}

function ageText(minutes: number, t: Translate): string {
  if (minutes < 60) return t("quorum.updatedMin", { n: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t("quorum.updatedHours", { n: hours }) : t("quorum.updatedDays", { n: Math.floor(hours / 24) });
}

function resetTime(locale: string): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

export function QuorumRow() {
  const { t, locale } = useI18n();
  const [view, setView] = useState<View | null>(() => {
    const kept = readKept();
    return kept ? keptView(kept) : null;
  });
  const [tip, setTip] = useState<string | null>(null);
  const offset = useRef(0);

  useEffect(() => {
    let gone = false;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      const reply = await fetchQuorum();
      busy = false;
      if (gone) return;
      if (reply && Number.isFinite(reply.now)) offset.current = Number(reply.now) - Date.now();
      cacheReply(reply);
      setView((prev) => nextView(prev, reply, offset.current));
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, []);

  if (!view) return null;
  const title = (
    <div className="w-full shrink-0 @[34rem]/quorum:w-auto">
      <a href="https://heyquorum.com" target="_blank" rel="noopener noreferrer" className="text-[15px] font-medium text-ink underline-offset-2 hover:underline">
        {t("quorum.title")}
      </a>
      {view.kind === "data" && view.ageMin !== null && <div className="text-[12px] text-ink-secondary">{ageText(view.ageMin, t)}</div>}
    </div>
  );
  if (view.kind !== "data") {
    const key = { notEnabled: "quorum.notEnabled", denied: "quorum.denied", unreachable: "quorum.unreachable" } as const;
    return (
      <section className="@container/quorum">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-card p-4">
          {title}
          <p className="text-[12px] text-ink-secondary">{t(key[view.kind])}</p>
        </div>
      </section>
    );
  }

  const { stats } = view;
  const days = stats.days.slice(-7);
  const series = {
    cost: days.map((day) => (tracked(stats.tracking.costSince, day.day) ? day.costCents : null)),
    visitors: days.map((day) => (tracked(stats.tracking.visitorsSince, day.day) ? day.visitors : null)),
    signups: days.map((day) => day.signups),
  };
  const total = (values: (number | null)[]) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  };
  const cap = stats.budget && stats.budget.dailyCapCents > 0 ? stats.budget.todayCountedCents / stats.budget.dailyCapCents : 0;

  const tipText = (metric: Bars, index: number): string => {
    const day = days[index];
    if (!day) return "";
    const when = dayLabel(day.day, locale).full;
    const value = series[metric][index];
    if (value === null || value === undefined) return t("quorum.tipUntracked", { when });
    if (metric === "visitors") return `${when} · ${t(value === 1 ? "quorum.visitorsOne" : "quorum.visitors", { n: value })}`;
    const split = PROVIDERS.filter((provider) => (day.costByProvider[provider] ?? 0) > 0)
      .map((provider) => `${provider === "search" ? t("quorum.search") : PROVIDER_NAMES[provider]} ${money(day.costByProvider[provider] ?? 0)}`)
      .join(" · ");
    return [`${when} · ${money(value)}`, split, t("quorum.estimated")].filter(Boolean).join("\n");
  };

  const strip = (metric: Bars) => {
    const values = series[metric];
    const peak = Math.max(0, ...values.map((value) => value ?? 0));
    return (
      <div className="flex h-7 w-10 items-end gap-[2px] @[22rem]/quorum:w-16">
        {values.map((value, index) => {
          const text = tipText(metric, index);
          const bar = value !== null && value > 0;
          const height = bar ? `${Math.max(10, Math.round((value / peak) * 100))}%` : "2px";
          return (
            <button
              key={days[index]?.day ?? index}
              type="button"
              className="group relative h-full min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
              aria-label={text.replaceAll("\n", ", ")}
              onMouseEnter={() => setTip(text)}
              onMouseLeave={() => setTip(null)}
              onFocus={() => setTip(text)}
              onBlur={() => setTip(null)}
              onClick={() => setTip(text)}
            >
              <span
                className={bar ? "absolute inset-x-0 bottom-0 rounded-t-[2px] bg-accent group-hover:bg-accent-text group-focus-visible:bg-accent-text" : "absolute inset-x-0 bottom-0 bg-ink-secondary/50 group-hover:bg-ink-secondary"}
                style={{ height }}
              />
            </button>
          );
        })}
      </div>
    );
  };

  const cell = (big: string, label: ReactNode, bars?: Bars) => (
    <div className="min-w-0">
      <div className="flex items-end gap-2">
        <div className="text-[20px] font-semibold leading-tight tracking-tight text-ink tabular-nums @[22rem]/quorum:text-[22px]">{big}</div>
        {bars && strip(bars)}
      </div>
      <div className="text-[12px] text-ink-secondary">{label}</div>
    </div>
  );

  const spent = total(series.cost);
  const visitors = total(series.visitors);
  return (
    <section className="@container/quorum flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-card p-4">
        {title}
        <div className={cn("flex min-w-0 flex-1 flex-wrap items-end justify-between gap-x-2 gap-y-2 @[22rem]/quorum:gap-x-4 @[34rem]/quorum:justify-end @[34rem]/quorum:gap-x-7", view.ageMin !== null && "opacity-60")}>
          {cell(
            spent === null ? "-" : money(spent),
            <>
              {t("quorum.spent")}
              {cap >= 0.75 && (
                <span className={cap >= 1 ? "text-danger" : "text-warning"} title={cap >= 1 ? t("quorum.capReset", { time: resetTime(locale) }) : undefined}>
                  {` · ${cap >= 1 ? t("quorum.capHit") : t("quorum.cap", { n: Math.floor(cap * 100) })}`}
                </span>
              )}
            </>,
            "cost",
          )}
          {cell(visitors === null ? "-" : String(visitors), t("quorum.visitsLabel"), "visitors")}
          {cell(String(total(series.signups)), t("quorum.signupsLabel"))}
        </div>
      </div>
      {tip && <p className="whitespace-pre-line text-[12px] leading-snug text-ink">{tip}</p>}
    </section>
  );
}
