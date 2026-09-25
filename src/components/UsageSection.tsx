// App settings → Usage: what every bot has spent, so "which of my bots is
// costing me money" is answerable without a provider dashboard. Figures are
// banked per settled turn on each task (server/store.ts addTaskUsage) and
// summed here; nothing is fetched. Plan usage sits above the table: how full
// each engine's subscription window is, straight from the engine's own
// report from its last turn or refresh, so nobody has to guess from a token count.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { Card } from "./SettingsPrimitives";
import { ProviderMark } from "./ProviderIcons";
import { useI18n } from "@/lib/i18n";
import { showUsagePerBotTable } from "@/lib/friends-chrome";
import { splitFriendsEngines } from "@/lib/engine-rail";
import { setUsageMode, useUsageMode } from "@/lib/usage-preferences";
import {
  botUsage,
  cachedInput,
  costCaption,
  formatTokens,
  formatUsd,
  hasFiniteCost,
  resetCompact,
  sumUsage,
  usageDetail,
  windowExpired,
  windowKind,
} from "@/lib/usage";
import { PLAN_WINDOW_SHORT_LABEL_KEY, PlanWindowMeter, useNow } from "./PlanUsageBar";

// Chat lists the session window before the weekly one; Settings keeps every
// window the engine reported but in that same priority. Array sort is stable,
// so windows of the same kind keep the engine's report order.
function windowRank(id: string, windowMinutes?: number): number {
  const kind = windowKind(id, windowMinutes);
  return kind === "session" ? 0 : kind === "weekly" ? 1 : 2;
}

// Subscription engines with a documented usage surface answer a refresh POST;
// engines that never report stay off the refresh path entirely.
const PLAN_USAGE_DRIVERS = new Set(["claudeAgent", "codex", "grokAgent", "museAgent"]);
const canRefresh = (instance: InstanceInfo) => PLAN_USAGE_DRIVERS.has(instance.driverKind);
const MUSE_POLL_MS = 60_000;
// Stale cutoff stays under the poll interval so a report fetched on open
// is already stale at the first tick; otherwise the refresh slips to ~2min.
const MUSE_STALE_MS = 30_000;
function museReportStale(instance: InstanceInfo, now = Date.now()): boolean {
  if (!instance.rateLimits) return true;
  const at = Date.parse(instance.rateLimits.observedAt);
  return !Number.isFinite(at) || now - at >= MUSE_STALE_MS;
}
type RefreshResult = { error?: string; status?: string };

// One shared row for every engine in the plan card: the label sits left and
// the values stack in a single left-aligned column underneath. Every engine
// maps through this component — no per-engine markup — so a future engine
// row inherits the alignment instead of re-centering itself.
function EnginePlanRow({
  instance,
  now,
  error,
}: {
  instance: InstanceInfo;
  now: number;
  error?: string;
}) {
  const { t } = useI18n();
  // Settings rows never show turn input/output counts - those live only in
  // the chat strip. Freshness stays in the provider tooltip.
  const windows = [...(instance.rateLimits?.windows ?? [])].sort(
    (a, b) => windowRank(a.id, a.windowMinutes) - windowRank(b.id, b.windowMinutes),
  );
  // Engines with rateLimits emit a window after a turn or refresh. Engines
  // that never report stay on the unsupported line so a missing observation
  // is not mistaken for downtime.
  const honestCaption = t(instance.capabilities?.rateLimits ? "usage.limits.pending" : "usage.limits.notReported", {
    name: instance.displayName,
  });
  const age = (observedAt: string) => {
    const minutes = Math.max(0, Math.floor((now - Date.parse(observedAt)) / 60_000));
    return minutes < 60
      ? t("usage.limits.refreshAgeMinutes", { minutes })
      : t("usage.limits.refreshAgeHours", { hours: Math.floor(minutes / 60) });
  };
  return (
    <div>
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <ProviderMark driverKind={instance.driverKind} size={16} />
        <span className="truncate" title={canRefresh(instance) && instance.rateLimits
          ? t(instance.driverKind === "museAgent" ? "usage.limits.cachedAsOf" : "usage.limits.refreshAge", { age: age(instance.rateLimits.observedAt) })
          : undefined}>{instance.displayName}</span>
      </div>
      {windows.length > 0 && (
        <div className="mt-2 flex flex-col items-start gap-1.5">
          {windows.map((window) => {
            const opus = window.id === "seven_day_opus";
            const shortLabel = t(PLAN_WINDOW_SHORT_LABEL_KEY[windowKind(window.id, window.windowMinutes)]);
            return (
              <div key={window.id} role={opus ? "group" : undefined} aria-label={opus ? `${t("usage.limits.opusShort")} ${shortLabel}` : undefined}
                className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px] text-ink">
                {opus && <span aria-hidden="true">{t("usage.limits.opusShort")}</span>}
                {windowExpired(window.resetsAt, now) ? (
                  <span>
                    {shortLabel}{" "}
                    <span className="text-ink-secondary">{t("usage.limits.resetPassed")}</span>
                  </span>
                ) : (
                  <>
                    <PlanWindowMeter window={window} now={now} compact />
                    {!resetCompact(window.resetsAt, now) && <span className="text-ink-secondary">{t("usage.limits.resetUnknown")}</span>}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!instance.rateLimits && (
        <div className="mt-1 text-[12px] text-ink-secondary">{honestCaption}</div>
      )}
      {error && (
        <div className="mt-1 text-[12px] text-danger">
          {instance.rateLimits
            ? t("usage.limits.refreshFailed", { message: error })
            : t("usage.limits.refreshFailedNoData", { message: error })}
        </div>
      )}
    </div>
  );
}

function PlanUsage() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const now = useNow();
  const mode = useUsageMode();
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [confirmed, setConfirmed] = useState(false);
  const [refreshErrors, setRefreshErrors] = useState<Record<string, string>>({});
  const engines = useMemo(
    () => splitFriendsEngines(state.instances).friends.filter((instance) => PLAN_USAGE_DRIVERS.has(instance.driverKind)),
    [state.instances],
  );
  const refreshable = useMemo(() => engines.filter(canRefresh), [engines]);
  const refresh = useCallback(async (instance: InstanceInfo): Promise<RefreshResult> => {
    try {
      const result = await api(`/api/usage/refresh/${instance.instanceId}`, { method: "POST" });
      if (result.report) dispatch({ type: "rateLimits", instanceId: instance.instanceId, report: result.report });
      setRefreshErrors((current) => result.error ? { ...current, [instance.instanceId]: result.error } : Object.fromEntries(Object.entries(current).filter(([id]) => id !== instance.instanceId)));
      return { error: result.error, status: result.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Refresh failed";
      setRefreshErrors((current) => ({ ...current, [instance.instanceId]: message }));
      return { error: message, status: "transport_error" };
    }
  }, [dispatch]);
  // The section's only refresh control: one tap refreshes every engine that
  // answers a refresh POST (Claude, Codex, Grok, Muse),
  // never just one of them. A clean run leaves an explicit confirmation
  // behind; the next run clears it.
  const refreshAll = useCallback(async () => {
    if (refreshingRef.current || refreshable.length === 0) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setConfirmed(false);
    try {
      const results = await Promise.all(refreshable.map(refresh));
      setConfirmed(results.every(({ error, status }) => !error && (status === undefined || status === "fresh")));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [refresh, refreshable]);

  const museInstances = useMemo(
    () => refreshable.filter((instance) => instance.driverKind === "museAgent"),
    [refreshable],
  );
  const museInstancesRef = useRef(museInstances);
  museInstancesRef.current = museInstances;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const initialMuseRefreshes = useRef(new Set<string>());
  // Muse quota lives server-side, so terminal CLI use only appears when
  // something re-reads the cached snapshot: missing or stale (>30s) reports
  // refresh once when Usage opens, then every 60s while it stays open. An
  // empty response remains pending, so this never fabricates a report.
  useEffect(() => {
    for (const instance of museInstances) {
      if (!museReportStale(instance) || initialMuseRefreshes.current.has(instance.instanceId)) continue;
      initialMuseRefreshes.current.add(instance.instanceId);
      void refresh(instance);
    }
  }, [museInstances, refresh]);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden || refreshingRef.current) return;
      for (const instance of museInstancesRef.current) {
        if (museReportStale(instance)) void refreshRef.current(instance);
      }
    }, MUSE_POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const refreshKey = event.code === "KeyR" || event.key.toLowerCase() === "r";
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !refreshKey) return;
      const active = event.target instanceof Element ? event.target : document.activeElement;
      if (document.querySelector('[data-model-picker-content], .orbit-terminal-overlay[data-open="true"]') || active?.closest('[data-orbit-composer], .orbit-terminal-overlay, [data-terminal], [data-orbit-terminal], input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (refreshable.length === 0) return;
      event.preventDefault();
      void refreshAll();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [refreshAll, refreshable.length]);

  return (
    <Card title={t("usage.limits.title")} subtitle={t("usage.limits.subtitle")}>
      <div className="mb-4 flex flex-nowrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("usage.limits.direction")}>
          {(["used", "remaining"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setUsageMode(value)}
              className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-ink/5 aria-pressed:bg-ink/10 aria-pressed:text-ink focus-visible:outline-2 focus-visible:outline-accent">
              {t(value === "used" ? "usage.limits.countUp" : "usage.limits.countDown")}
            </button>
          ))}
        </div>
        {refreshable.length > 0 && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {confirmed && !refreshing && (
              <span role="status" className="flex items-center gap-1 text-[12px] text-ink-secondary">
                <Check size={12} className="text-success" />
                {t("usage.limits.refreshDone")}
              </span>
            )}
            <button
              type="button"
              onClick={() => void refreshAll()}
              disabled={refreshing}
              aria-label={t(refreshing ? "usage.limits.refreshing" : "usage.limits.refreshAll")}
              title={t(refreshing ? "usage.limits.refreshing" : "usage.limits.refreshAll")}
              aria-keyshortcuts="Alt+R"
              aria-busy={refreshing}
              className="flex size-8 shrink-0 items-center justify-center rounded-full border border-hairline/40 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <RefreshCw size={15} aria-hidden="true" className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined} />
            </button>
          </div>
        )}
      </div>
      {engines.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">{t("usage.limits.empty")}</div>
      ) : (
        <div className="flex flex-col gap-5">
          {engines.map((instance) => (
            <EnginePlanRow key={instance.instanceId} instance={instance} now={now} error={refreshErrors[instance.instanceId]} />
          ))}
        </div>
      )}
    </Card>
  );
}

export function UsageSection() {
  const { t } = useI18n();
  const { state } = useStore();
  const rows = state.bots
    .filter((b) => !b.hidden)
    .map((bot) => {
      const usage = botUsage(bot);
      const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
      return { bot, usage, billing: instance?.snapshot.billing };
    })
    .filter((r) => r.usage.turns > 0)
    // money first, then volume. Non-finite/missing costs sort last.
    .sort((a, b) => {
      const costOf = (value: number | null | undefined) =>
        hasFiniteCost(value) ? value : Number.NEGATIVE_INFINITY;
      return costOf(b.usage.costUsd) - costOf(a.usage.costUsd) || b.usage.input + b.usage.output - (a.usage.input + a.usage.output);
    });
  const total = sumUsage(rows.map((r) => r.usage));
  const totalDetail = usageDetail(total);
  const billings = new Set(rows.map((r) => r.billing));

  return (
    <>
      <PlanUsage />
      {showUsagePerBotTable() && (
      <Card title="Usage" subtitle="Tokens and cost per bot, added up from every settled turn. Only engines that report a price show one.">
        {rows.length === 0 ? (
          <div className="text-[13px] text-ink-secondary">Nothing spent yet — figures appear after a bot's first turn.</div>
        ) : (
          <div className="flex flex-col">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
              <span>Bot</span>
              <span className="text-right">Turns</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Cost</span>
            </div>
            {rows.map(({ bot, usage }) => {
              const detail = usageDetail(usage);
              return (
                <div key={bot.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px]">
                  <span className="flex min-w-0 items-center gap-2 text-ink">
                    <MausAvatar color={bot.color} state="idle" size={22} animated={false} />
                    <span className="truncate">{bot.name}</span>
                  </span>
                  <span className="text-right tabular-nums text-ink-secondary">{usage.turns}</span>
                  <span className="text-right tabular-nums text-ink" title={t(detail.key, detail.vars)}>
                    {formatTokens(usage.input + usage.output)}
                  </span>
                  <span className="text-right tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : <span className="text-ink-secondary">—</span>}</span>
                </div>
              );
            })}
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 pt-2.5 text-[13px] font-medium text-ink">
              <span>All bots</span>
              <span className="text-right tabular-nums">{total.turns}</span>
              <span className="text-right tabular-nums" title={t(totalDetail.key, totalDetail.vars)}>{formatTokens(total.input + total.output)}</span>
              <span className="text-right tabular-nums">{hasFiniteCost(total.costUsd) ? formatUsd(total.costUsd) : "—"}</span>
            </div>
            {cachedInput(total) > 0 && (
              <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                Tokens count everything the model read and wrote. Each turn resends the whole conversation with the system prompt and tool
                schemas, so {formatTokens(cachedInput(total))} of the input was context re-read from the provider's cache rather than new text —
                hover a figure for the split.
              </div>
            )}
            {hasFiniteCost(total.costUsd) && (
              <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                Cost is {billings.size === 1 ? costCaption([...billings][0]) : "as each engine reports it — on a subscription it's an equivalent, not a charge"}.
              </div>
            )}
          </div>
        )}
      </Card>
      )}
    </>
  );
}
