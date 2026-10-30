import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { setUsageMode } from "@/lib/usage-preferences";
import { PlanWindowMeter } from "./PlanUsageBar";
import { ChatPlanMeters } from "./ChatPlanMeters";

const now = Date.UTC(2026, 9, 30, 12);
afterEach(() => { applyLocale("en"); setUsageMode("remaining"); });

describe("compact plan window", () => {
  it.each(["en", "ko"] as const)("keeps the Usage countdown out of the composer in %s", (locale) => {
    applyLocale(locale);
    const window = { id: "five_hour", usedPercent: 25, resetsAt: now + 113 * 60_000 };
    const reset = locale === "en" ? "(1h53m)" : "(1시간 53분)";
    for (const mode of ["used", "remaining"] as const) {
      setUsageMode(mode);
      const usage = renderToStaticMarkup(createElement(PlanWindowMeter, { window, now, compact: true, showReset: true }));
      const composer = renderToStaticMarkup(createElement(ChatPlanMeters, { windows: [window], now, onOpenUsage: () => {} }));
      expect(usage).toContain(reset);
      expect(composer).not.toContain(reset);
    }
  });

  it.each(["used", "remaining"] as const)("keeps reset times in the tooltip at every fill in %s mode", (mode) => {
    setUsageMode(mode);
    for (const usedPercent of [0, 25, 75, 80, 100]) {
      const html = renderToStaticMarkup(createElement(PlanWindowMeter, {
        window: { id: "five_hour", usedPercent, resetsAt: now + 113 * 60_000 }, now, compact: true,
      }));
      expect(html).toContain('title="Resets in 2 hours"');
      expect(html).not.toContain("1h53m");
      expect(html).not.toContain("(");
      expect(html).toContain("whitespace-nowrap");
      expect(html).not.toContain("flex-wrap");
    }
  });

  it("keeps the Korean Usage page reset phrase", () => {
    applyLocale("ko");
    const html = renderToStaticMarkup(createElement(PlanWindowMeter, {
      window: { id: "five_hour", usedPercent: 80, resetsAt: now + 113 * 60_000 }, now,
    }));
    expect(html).toContain("2시간 후 초기화");
  });

  it("keeps ten phone bar segments with the same fill as the desktop bar", () => {
    const html = renderToStaticMarkup(createElement(PlanWindowMeter, {
      window: { id: "five_hour", usedPercent: 80, resetsAt: now + 113 * 60_000 }, now, compact: true,
    }));
    expect(html.match(/<polygon /g)).toHaveLength(10);
    expect(html.match(/fill="currentColor"/g)).toHaveLength(2);
    expect(html).toContain("▰▰▱▱▱▱▱▱▱▱");
    expect(html).toContain("text-[12.5px]");
  });
});
