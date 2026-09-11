// App settings → Usage: what every bot has spent, so "which of my bots is
// costing me money" is answerable without a provider dashboard. Figures are
// banked per settled turn on each task (server/store.ts addTaskUsage) and
// summed here; nothing is fetched. Plan usage sits above the table: how full
// each engine's subscription window is, straight from the engine's own
// report on its last turn, so nobody has to guess from a token count.
import { useState } from "react";
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
  sumUsage,
  usageDetail,
} from "@/lib/usage";
import { PlanWindowMeter, useNow } from "./PlanUsageBar";

function PlanUsage() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const now = useNow();
  const mode = useUsageMode();
  const [refreshing, setRefreshing] = useState<Set<string>>(() => new Set());
  const [refreshErrors, setRefreshErrors] = useState<Record<string, string>>({});
  const engines = splitFriendsEngines(state.instances).friends;
  // Claude/Codex/Grok declare rateLimits but only emit a window after a
  // turn or refresh — pending, not an outage. Engines that never report
  // (Antigravity, OpenCode) stay on the unsupported line so a missing
  // observation is not mistaken for downtime.
  const honestCaption = (instance: InstanceInfo) =>
    t(instance.capabilities?.rateLimits ? "usage.limits.pending" : "usage.limits.notReported", {
      name: instance.displayName,
    });
  const canRefresh = (instance: InstanceInfo) =>
    instance.driverKind === "claudeAgent" || instance.driverKind === "codex" || instance.driverKind === "grokAgent";
  const age = (observedAt: string) => {
    const minutes = Math.max(0, Math.floor((now - Date.parse(observedAt)) / 60_000));
    return minutes < 60
      ? t("usage.limits.refreshAgeMinutes", { minutes })
      : t("usage.limits.refreshAgeHours", { hours: Math.floor(minutes / 60) });
  };
  const refresh = async (instance: InstanceInfo) => {
    setRefreshing((current) => new Set(current).add(instance.instanceId));
    try {
      const result = await api(`/api/usage/refresh/${instance.instanceId}`, { method: "POST" });
      if (result.report) dispatch({ type: "rateLimits", instanceId: instance.instanceId, report: result.report });
      setRefreshErrors((current) => result.error ? { ...current, [instance.instanceId]: result.error } : Object.fromEntries(Object.entries(current).filter(([id]) => id !== instance.instanceId)));
    } catch (error) {
      setRefreshErrors((current) => ({ ...current, [instance.instanceId]: error instanceof Error ? error.message : "Refresh failed" }));
    } finally {
      setRefreshing((current) => {
        const next = new Set(current);
        next.delete(instance.instanceId);
        return next;
      });
    }
  };

  return (
    <Card title={t("usage.limits.title")} subtitle={t("usage.limits.subtitle")}>
      <div className="mb-4 flex flex-wrap gap-1" role="group" aria-label={t("usage.limits.direction")}>
        {(["used", "remaining"] as const).map((value) => (
          <button key={value} type="button" aria-pressed={mode === value} onClick={() => setUsageMode(value)}
            className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-ink/5 aria-pressed:bg-ink/10 aria-pressed:text-ink focus-visible:outline-2 focus-visible:outline-accent">
            {t(value === "used" ? "usage.limits.countUp" : "usage.limits.countDown")}
          </button>
        ))}
      </div>
      {engines.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">{t("usage.limits.empty")}</div>
      ) : (
        <div className="flex flex-col gap-4">
          {engines.map((instance) => (
            <div key={instance.instanceId}>
              <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <ProviderMark driverKind={instance.driverKind} size={16} />
                <span className="truncate">{instance.displayName}</span>
              </div>
              {instance.rateLimits ? (
                <div className="mt-2 flex flex-col gap-3">
                  {instance.rateLimits.windows.map((window) => (
                    <PlanWindowMeter key={window.id} window={window} now={now} />
                  ))}
                </div>
              ) : (
                <div className="mt-1 text-[12px] text-ink-secondary">{honestCaption(instance)}</div>
              )}
              {canRefresh(instance) && (
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" onClick={() => void refresh(instance)} disabled={refreshing.has(instance.instanceId)}
                    className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-ink/5 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent">
                    {t(refreshing.has(instance.instanceId) ? "usage.limits.refreshing" : "usage.limits.refresh")}
                  </button>
                  {instance.rateLimits && <span className="text-[11px] text-ink-secondary">{t("usage.limits.refreshAge", { age: age(instance.rateLimits.observedAt) })}</span>}
                </div>
              )}
              {refreshErrors[instance.instanceId] && (
                <div className="mt-1 text-[12px] text-danger">
                  {t("usage.limits.refreshFailed", { message: refreshErrors[instance.instanceId], age: instance.rateLimits ? age(instance.rateLimits.observedAt) : "—" })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function UsageSection() {
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
            {rows.map(({ bot, usage }) => (
              <div key={bot.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px]">
                <span className="flex min-w-0 items-center gap-2 text-ink">
                  <MausAvatar color={bot.color} state="idle" size={22} animated={false} />
                  <span className="truncate">{bot.name}</span>
                </span>
                <span className="text-right tabular-nums text-ink-secondary">{usage.turns}</span>
                <span className="text-right tabular-nums text-ink" title={usageDetail(usage)}>
                  {formatTokens(usage.input + usage.output)}
                </span>
                <span className="text-right tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : <span className="text-ink-secondary">—</span>}</span>
              </div>
            ))}
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 pt-2.5 text-[13px] font-medium text-ink">
              <span>All bots</span>
              <span className="text-right tabular-nums">{total.turns}</span>
              <span className="text-right tabular-nums" title={usageDetail(total)}>{formatTokens(total.input + total.output)}</span>
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
