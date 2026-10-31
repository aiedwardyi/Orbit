// The Terminal skin's two-line status under the composer. It takes the place
// of the 5h/7d strip, so the meters still open Usage.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { shownModelSelection, useStore, visibleMessages, type Bot, type InstanceInfo } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { museReading, planMeterWindows, readingAge, resetCompact } from "@/lib/usage";
import { useUsageMode } from "@/lib/usage-preferences";
import { termMeter, termModelLabel } from "@/lib/terminal-skin";
import { PHONE_QUERY } from "@/lib/phone-swipe";
import { useSkin } from "@/lib/skins";
import { readContextCompaction } from "../../shared/context-compaction";
import { PLAN_WINDOW_SHORT_LABEL_KEY, useNow } from "./PlanUsageBar";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import "./TermStatusLine.css";

const PHONE_STATUS_QUERY = `${PHONE_QUERY} and (pointer: coarse)`;

export function TermStatusLine({ bot, engine, cwd = bot.cwd, turns }: { bot: Bot; engine: InstanceInfo | undefined; cwd?: string | null; turns?: number }) {
  const { t, locale } = useI18n();
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const mode = useUsageMode();
  const skin = useSkin();
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_STATUS_QUERY).matches ?? false);
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_STATUS_QUERY);
    const change = () => setPhone(media?.matches ?? false);
    change();
    media?.addEventListener("change", change);
    return () => media?.removeEventListener("change", change);
  }, []);
  const now = useNow();
  const selection = shownModelSelection(bot);
  const selectedEngine = engine?.instanceId === selection.instanceId ? engine : state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const model = selectedEngine?.models.options.find((option) => option.id === selection.model)?.label ?? selection.model;
  const reading = museReading(selectedEngine?.driverKind, selectedEngine?.rateLimits?.observedAt, now);
  const ageId = useId();
  const meters = planMeterWindows(selectedEngine?.rateLimits?.windows, now).map((window) => ({
    ...termMeter(window, now, mode),
    remaining: termMeter(window, now, "remaining").percent,
    reset: resetCompact(window.resetsAt, now),
  }));
  const meter = meters.reduce<(typeof meters)[number] | undefined>((tightest, window) => {
    return !tightest || (window.remaining ?? Infinity) < (tightest.remaining ?? Infinity) ? window : tightest;
  }, undefined);
  const phoneMeters = skin === "multiplexer" ? meter ? [meter] : [] : meters;
  const meterGap = phoneMeters.length > 1 ? "" : " ";
  const phoneModel = termModelLabel(model);
  const meterReset = meter?.reset && t(meter.reset.key, meter.reset.vars);
  useLayoutEffect(() => {
    const status = statusRef.current;
    if (!phone || skin !== "multiplexer" || !status) return;
    let alive = true;
    const fit = () => {
      if (!alive) return;
      delete status.dataset.termBars;
      if (status.scrollWidth > status.clientWidth) status.dataset.termBars = "off";
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    observer?.observe(status);
    window.addEventListener("resize", fit);
    void document.fonts?.ready.then(fit);
    return () => {
      alive = false;
      observer?.disconnect();
      window.removeEventListener("resize", fit);
      delete status.dataset.termBars;
    };
  }, [phone, skin, phoneModel, bot.name, locale, meter?.kind, meter?.percent, meterReset]);
  const summary = visibleMessages(bot).findLast((message) => message.kind === "compaction" && readContextCompaction({ value: message.compaction }).status === "valid");
  const age = summary && readingAge(new Date(summary.at).toISOString(), now);
  if (phone) return (
    <div ref={statusRef} data-term-status data-term-window={bot.name} data-term-phone={skin} role="group" aria-label={t("term.status.aria")} className="term-status">
      {skin === "multiplexer" && (
        <span data-term-tab title={bot.name}>
          <span>0:</span><span data-term-tab-name>{bot.name}</span><span>*</span>
        </span>
      )}
      <div data-term-model>
        {skin !== "multiplexer" && <><span aria-hidden="true" className="text-accent">◆</span>{" "}</>}
        {phoneModel}
      </div>
      {phoneMeters.length > 0 && (
        <div data-term-meters={phoneMeters.length}>
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
            title={t("usage.limits.openAria")}
            aria-label={t("usage.limits.openAria")}
            aria-describedby={reading ? ageId : undefined}
            className={reading?.stale ? "text-ink-secondary hover:text-accent-text" : "hover:text-accent-text"}
          >
            {reading && <span id={ageId} className="sr-only">{reading.label(t)}</span>}
            {phoneMeters.map((meter, i) => (
              <span key={meter.id}>
                {i > 0 && <span aria-hidden="true" className="text-ink-secondary">│</span>}
                {t(PLAN_WINDOW_SHORT_LABEL_KEY[meter.kind])}{" "}
                <span data-term-bar aria-hidden="true">{meter.bar}{meterGap}</span>
                {meter.percent === null ? "-" : t("usage.limits.percentUsed", { percent: meter.percent })}
                {meter.reset && <span className="text-ink-secondary">{meterGap}({t(meter.reset.key, meter.reset.vars)})</span>}
              </span>
            ))}
          </button>
        </div>
      )}
    </div>
  );
  return (
    <div data-term-status data-term-window={bot.name} role="group" aria-label={t("term.status.aria")} className="term-status">
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
