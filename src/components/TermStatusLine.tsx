// The Terminal skin's two-line status under the composer. It takes the place
// of the 5h/7d strip, so the meters still open Usage.
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { planMeterWindows, readingAge, resetCompact } from "@/lib/usage";
import { useUsageMode } from "@/lib/usage-preferences";
import { termMeter } from "@/lib/terminal-skin";
import { PLAN_WINDOW_SHORT_LABEL_KEY, useNow } from "./PlanUsageBar";
import { useDesktopCapabilities } from "./DesktopCapabilities";

export function TermStatusLine({ bot, engine, turns }: { bot: Bot; engine: InstanceInfo | undefined; turns?: number }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const mode = useUsageMode();
  const now = useNow();
  const model = engine?.models.options.find((option) => option.id === bot.modelSelection.model)?.label ?? bot.modelSelection.model;
  const meters = planMeterWindows(engine?.rateLimits?.windows, now).map((window) => ({
    ...termMeter(window, now, mode),
    reset: resetCompact(window.resetsAt, now),
  }));
  const summary = [...bot.messages].reverse().find((message) => message.kind === "compaction");
  const age = summary && readingAge(new Date(summary.at).toISOString(), now);
  return (
    <div data-term-status role="group" aria-label={t("term.status.aria")} className="term-status">
      <div>
        <span aria-hidden="true" className="text-accent">◆</span> {model}
        {bot.cwd && (
          <>
            <span aria-hidden="true" className="text-ink-secondary"> │ </span>
            {shortPath(bot.cwd, capabilities.host.homeDir)}
          </>
        )}
        {bot.modelSelection.effort && <span className="text-ink-secondary"> · {bot.modelSelection.effort}</span>}
      </div>
      <div>
        {meters.length > 0 && (
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
            title={t("usage.limits.openAria")}
            className="hover:text-accent-text"
          >
            {meters.map((meter, i) => (
              <span key={meter.id}>
                {i > 0 && <span aria-hidden="true" className="text-ink-secondary"> │ </span>}
                {t(PLAN_WINDOW_SHORT_LABEL_KEY[meter.kind])} <span aria-hidden="true">{meter.bar}</span>{" "}
                {meter.percent === null ? "-" : t("usage.limits.percentUsed", { percent: meter.percent })}
                {meter.reset && <span className="text-ink-secondary"> ({t(meter.reset.key, meter.reset.vars)})</span>}
              </span>
            ))}
          </button>
        )}
        {meters.length > 0 && <span aria-hidden="true" className="text-ink-secondary"> │ </span>}
        <span className="text-ink-secondary">
          {age ? t("term.status.summary", { age: t(age.key, age.vars) }) : t("term.status.noSummary")}
          {turns ? ` · ${t("term.status.turns", { turns })}` : ""}
        </span>
      </div>
    </div>
  );
}
