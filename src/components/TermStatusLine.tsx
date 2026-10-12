// The Terminal skin's two-line status under the composer. It takes the place
// of the 5h/7d strip, so the meters still open Usage.
import { useId } from "react";
import { shownModelSelection, useStore, visibleMessages, type Bot, type InstanceInfo } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { museReading, planMeterWindows, readingAge, resetCompact } from "@/lib/usage";
import { useUsageMode } from "@/lib/usage-preferences";
import { termMeter } from "@/lib/terminal-skin";
import { readContextCompaction } from "../../shared/context-compaction";
import { PLAN_WINDOW_SHORT_LABEL_KEY, useNow } from "./PlanUsageBar";
import { useDesktopCapabilities } from "./DesktopCapabilities";

export function TermStatusLine({ bot, engine, cwd = bot.cwd, turns }: { bot: Bot; engine: InstanceInfo | undefined; cwd?: string | null; turns?: number }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const mode = useUsageMode();
  const now = useNow();
  const selection = shownModelSelection(bot);
  const selectedEngine = engine?.instanceId === selection.instanceId ? engine : state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const model = selectedEngine?.models.options.find((option) => option.id === selection.model)?.label ?? selection.model;
  const reading = museReading(selectedEngine?.driverKind, selectedEngine?.rateLimits?.observedAt, now);
  const ageId = useId();
  const meters = planMeterWindows(selectedEngine?.rateLimits?.windows, now).map((window) => ({
    ...termMeter(window, now, mode),
    reset: resetCompact(window.resetsAt, now),
  }));
  const summary = visibleMessages(bot).findLast((message) => message.kind === "compaction" && readContextCompaction({ value: message.compaction }).status === "valid");
  const age = summary && readingAge(new Date(summary.at).toISOString(), now);
  return (
    <div data-term-status role="group" aria-label={t("term.status.aria")} className="term-status">
      <div>
        <span aria-hidden="true" className="text-accent">◆</span> {model}
        {cwd && (
          <>
            <span aria-hidden="true" className="text-ink-secondary"> │ </span>
            {shortPath(cwd, capabilities.host.homeDir)}
          </>
        )}
        {selection.effort && <span className="text-ink-secondary"> · {selection.effort}</span>}
      </div>
      <div>
        {meters.length > 0 && (
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
            title={t("usage.limits.openAria")}
            aria-label={t("usage.limits.openAria")}
            aria-describedby={reading ? ageId : undefined}
            className={reading?.stale ? "text-ink-secondary hover:text-accent-text" : "hover:text-accent-text"}
          >
            {reading && (
              <>
                <span id={ageId} className="text-ink-secondary">{reading.label(t)}</span>
                <span aria-hidden="true" className="text-ink-secondary"> · </span>
              </>
            )}
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
