import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { setUsageMode } from "@/lib/usage-preferences";
import type { RateLimitWindow } from "../../server/contracts.ts";
import type { TaskUsage } from "@/state/store";

import { ChatPlanMeters } from "./ChatPlanMeters";

const now = Date.UTC(2026, 8, 4, 12, 0, 0);
afterEach(() => setUsageMode("used"));

function render(windows: RateLimitWindow[] | undefined, usage?: TaskUsage) {
  applyLocale("en");
  return renderToStaticMarkup(createElement(ChatPlanMeters, { windows, usage, now }));
}

describe("ChatPlanMeters", () => {
  it("hides when the engine has no live plan windows", () => {
    expect(render(undefined)).toBe("");
    expect(render([])).toBe("");
    expect(
      render([{ id: "five_hour", usedPercent: 40, resetsAt: now - 60_000 }]),
    ).toBe("");
  });

  it("shows the live 5-hour and weekly windows with used percent and a compact reset", () => {
    const html = render([
      { id: "five_hour", usedPercent: 10, resetsAt: now + 115 * 60_000 },
      { id: "seven_day", usedPercent: 49, resetsAt: now + 53 * 3_600_000 },
      { id: "seven_day_opus", usedPercent: 75, resetsAt: now + 53 * 3_600_000 },
      { id: "stale", usedPercent: 40, resetsAt: now - 60_000 },
    ]);
    expect(html).toContain("5h");
    expect(html).toContain("7d");
    expect(html).toContain(">10%<");
    expect(html).toContain(">49%<");
    expect(html).toContain("1h55m");
    expect(html).toContain("2d5h");
    expect(html).not.toContain(">75%<");
    expect(html).not.toContain(">40%<");
    expect(html).not.toContain(">90%<");
    expect(html).not.toMatch(/>Resets in/);
    expect(html).toContain('title="Resets in');
    expect(html).not.toContain("% used<");
    expect(html).not.toContain("$");
    expect(html).not.toContain("Fixed");
    expect(html).not.toContain("on-demand");
    expect(html).toContain("▰▱▱▱▱▱▱▱▱▱");
    expect(html).toContain("▰▰▰▰▰▱▱▱▱▱");
    expect(html).toContain("(1h55m)");
    expect(html).toContain("(2d5h)");
    expect(html).toContain('aria-label="5h: 10% used"');
    expect(html).toContain('aria-label="7d: 49% used"');
    expect(html).toContain("text-accent");
    expect(html).not.toContain("bg-app");
    expect(html).not.toContain("h-1.5");
  });

  it("counts down both wire windows without inventing an unknown fill", () => {
    setUsageMode("remaining");
    const html = render([
      { id: "primary", usedPercent: 80, windowMinutes: 300, resetsAt: now + 106 * 60_000 },
      { id: "secondary", usedPercent: 125, windowMinutes: 10080, resetsAt: now + 86_400_000 },
    ]);
    expect(html).toContain('aria-label="5h: 20% remaining"');
    expect(html).toContain('aria-label="7d: 0% remaining"');
    expect(html).toContain("▰▰▱▱▱▱▱▱▱▱");
    expect(html).toContain("(1h46m)");
    const unknown = render([{ id: "five_hour", usedPercent: NaN, resetsAt: now + 60_000 }]);
    expect(unknown).not.toContain("100%");
    expect(unknown).not.toContain("▰");
    expect(render([{ id: "five_hour", usedPercent: 80, resetsAt: now - 1 }])).toBe("");
  });

  it("shows read/written tokens only when the task banked them", () => {
    const live: RateLimitWindow[] = [{ id: "five_hour", usedPercent: 10, resetsAt: now + 115 * 60_000 }];
    const banked = render(live, { input: 52_400, output: 4, cachedInput: 41_000, costUsd: null, turns: 3 });
    expect(banked).toContain("↑52.4k ↓4");
    expect(banked).toContain("52.4k in (41k cached)");
    expect(banked).toContain("grid-cols-[auto_auto]");
    const idle = render(live, { input: 0, output: 0, costUsd: null, turns: 2 });
    expect(idle).not.toContain("↑");
    expect(idle).not.toContain("↓");
    expect(idle).toContain("grid-cols-1");
    expect(render(live)).not.toContain("↑");
  });
});
