// App settings → Usage: what every bot has spent, so "which of my bots is
// costing me money" is answerable without a provider dashboard. Figures are
// banked per settled turn on each task (server/store.ts addTaskUsage) and
// summed here; nothing is fetched. Plan usage sits above the table: how full
// each engine's subscription window is, straight from the engine's own
// report on its last turn, so nobody has to guess from a token count.
import { useEffect, useState } from "react";
import { useStore, type InstanceInfo, type RateLimitReport } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { Card } from "./SettingsPrimitives";
import { ProviderMark } from "./ProviderIcons";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  botUsage,
  cachedInput,
  costCaption,
  formatTokens,
  formatUsd,
  hasFiniteCost,
  percentUsed,
  resetPhrase,
  sumUsage,
  usageDetail,
  windowExpired,
  windowKind,
} from "@/lib/usage";

const WINDOW_LABEL_KEY = {
  session: "usage.limits.session",
  weekly: "usage.limits.weekly",
  other: "usage.limits.window",
} as const;

/** A minute tick so countdowns stay right while Settings is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function WindowRow({ window, now }: { window: RateLimitReport["windows"][number]; now: number }) {
  const { t } = useI18n();
  // a reset that has already passed makes the last fill level history, not
  // a measurement: the bar empties and the caption says why
  const percent = windowExpired(window.resetsAt, now) ? null : percentUsed(window.usedPercent);
  const fill = percent === null ? 0 : Math.min(100, percent);
  const reset = resetPhrase(window.resetsAt, now);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="text-ink-secondary">{t(WINDOW_LABEL_KEY[windowKind(window.id, window.windowMinutes)])}</span>
        {percent !== null && <span className="tabular-nums text-ink">{t("usage.limits.percentUsed", { percent })}</span>}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
        <div
          className={cn("h-full rounded-full", fill >= 90 ? "bg-danger" : fill >= 75 ? "bg-warning" : "bg-accent")}
          style={{ width: `${fill}%` }}
        />
      </div>
      <div className="mt-1 text-[12px] text-ink-secondary">{t(reset.key, reset.vars)}</div>
    </div>
  );
}

function PlanUsage() {
  const { t } = useI18n();
  const { state } = useStore();
  const now = useNow();
  // engines this workspace actually runs on, plus any that already reported;
  // the rest of the installed zoo stays out of it
  const inUse = new Set(state.bots.filter((b) => !b.hidden).map((b) => b.modelSelection.instanceId));
  const engines = state.instances
    .filter((instance) => inUse.has(instance.instanceId) || instance.rateLimits)
    .sort(
      (a, b) =>
        Number(Boolean(b.rateLimits)) - Number(Boolean(a.rateLimits)) || a.displayName.localeCompare(b.displayName),
    );
  const honestCaption = (instance: InstanceInfo) =>
    t(instance.capabilities?.rateLimits ? "usage.limits.pending" : "usage.limits.notReported", { name: instance.displayName });

  return (
    <Card title={t("usage.limits.title")} subtitle={t("usage.limits.subtitle")}>
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
                    <WindowRow key={window.id} window={window} now={now} />
                  ))}
                </div>
              ) : (
                <div className="mt-1 text-[12px] text-ink-secondary">{honestCaption(instance)}</div>
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
    </>
  );
}
