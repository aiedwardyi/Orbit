import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { RateLimitWindow } from "../../server/contracts.ts";

import { ChatPlanMeters } from "./ChatPlanMeters";

const now = Date.UTC(2026, 8, 4, 12, 0, 0);

function render(windows: RateLimitWindow[] | undefined) {
  applyLocale("en");
  return renderToStaticMarkup(createElement(ChatPlanMeters, { windows, now }));
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
    expect(html).toContain("Weekly");
    expect(html).toContain(">10%<");
    expect(html).toContain(">49%<");
    expect(html).toContain("1h55m");
    expect(html).toContain("2d5h");
    expect(html).not.toContain(">75%<");
    expect(html).not.toContain(">40%<");
    expect(html).not.toContain(">90%<");
    expect(html).not.toMatch(/>Resets in/);
    expect(html).toContain('title="Resets in');
    expect(html).not.toContain("% used");
    expect(html).not.toContain("$");
    expect(html).not.toContain("Fixed");
    expect(html).not.toContain("on-demand");
    expect(html).toMatch(/\bh-1\b/);
    expect(html).toContain("bg-ink/10");
    expect(html).toContain("bg-accent");
    expect(html).not.toContain("bg-app");
    expect(html).not.toContain("h-1.5");
  });
});
