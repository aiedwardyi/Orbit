// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider, persistPreference } from "@/lib/i18n";
import { setUsageMode } from "@/lib/usage-preferences";
import type { InstanceInfo } from "@/state/store";

const { mockState, mockApi } = vi.hoisted(() => {
  const engine = (
    instanceId: string,
    driverKind: string,
    displayName: string,
    extra: Partial<InstanceInfo> = {},
  ): InstanceInfo => ({
    instanceId,
    driverKind,
    displayName,
    snapshot: { state: "available", authenticated: true },
    models: { default: "default", options: [] },
    ...extra,
  });
  return {
    mockState: {
      bots: [
        {
          id: "bot-1",
          hidden: false,
          name: "Friend",
          modelSelection: { instanceId: "grok", model: "grok-4.6" },
          tasks: [{ threadId: "t", title: "", createdAt: 0, usage: { input: 10, output: 4, costUsd: 0.01, turns: 2 } }],
        },
      ],
      instances: [
        engine("claude", "claudeAgent", "Claude", {
          capabilities: { rateLimits: true },
          rateLimits: {
            observedAt: new Date().toISOString(),
            windows: [
              { id: "five_hour", usedPercent: 10, resetsAt: Date.now() + 3_600_000 },
              { id: "seven_day", usedPercent: 49, resetsAt: Date.now() + 6 * 86_400_000 },
              { id: "seven_day_opus", usedPercent: 75, resetsAt: Date.now() + 6 * 86_400_000 },
              { id: "primary", usedPercent: 90, resetsAt: Date.now() + 3_600_000 },
              { id: "stale", usedPercent: 40, resetsAt: Date.now() - 60_000 },
            ],
          },
        }),
        engine("kimi", "kimiAgent", "Kimi"),
        engine("codex", "codex", "Codex", { capabilities: { rateLimits: true } }),
        engine("grok", "grokAgent", "Grok"),
        engine("gemini", "geminiAgent", "Gemini API"),
        engine("antigravity", "antigravityAgent", "Gemini (Antigravity)"),
        engine("opencode", "opencodeGo", "OpenCode"),
      ],
    },
    mockApi: vi.fn(async (_path: string): Promise<{ report: { windows: { id: string; usedPercent: number }[]; observedAt: string } }> => ({
      report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" },
    })),
  };
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: mockApi,
    useStore: () => ({
      state: mockState,
      dispatch: () => undefined,
    }),
  };
});

import { UsageSection } from "./UsageSection";
import { ChatPlanMeters } from "./ChatPlanMeters";
import { planUsageTone } from "./PlanUsageBar";

describe("UsageSection friends plan card", () => {
  it("shares the 75/90 thresholds between text and fill colors", () => {
    expect(planUsageTone(74)).toEqual({ textClass: "text-accent", fillClass: "bg-accent" });
    expect(planUsageTone(75)).toEqual({ textClass: "text-warning", fillClass: "bg-warning" });
    expect(planUsageTone(90)).toEqual({ textClass: "text-danger", fillClass: "bg-danger" });
  });
  it("changes both surfaces, persists the mode, and keeps warnings tied to used percent", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    let root = createRoot(host);
    const windows = [{ id: "five_hour", usedPercent: 90, resetsAt: Date.now() + 3_600_000 }];
    try {
      await act(async () => root.render(createElement(I18nProvider, null,
        createElement(UsageSection), createElement(ChatPlanMeters, { windows }))));
      const down = [...host.querySelectorAll("button")].find((button) => button.textContent === "Count down (remaining)");
      expect(down).toBeDefined();
      expect(down?.getAttribute("aria-pressed")).toBe("false");
      await act(async () => down?.click());
      expect(down?.getAttribute("aria-pressed")).toBe("true");
      expect(localStorage.getItem("omb-usage-mode")).toBe("remaining");
      expect(host.querySelector('[aria-label="5h: 10% remaining"]')?.textContent).toContain("▰▱▱▱▱▱▱▱▱▱");
      expect(host.querySelector('[aria-label="5h: 10% remaining"] .text-danger')).not.toBeNull();
      expect(host.querySelector('[aria-label="5-hour window: 90% remaining"] [style="width: 90%;"]')).not.toBeNull();
      await act(async () => root.unmount());
      root = createRoot(host);
      await act(async () => root.render(createElement(UsageSection)));
      expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe("Count down (remaining)");
    } finally {
      await act(async () => root.unmount());
      await act(async () => setUsageMode("used"));
      host.remove();
    }
  });

  it("shows the featured engines in picker order and hides the per-bot table", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
    expect(html).toContain("Plan usage");
    expect(html).toContain("Grok");
    expect(html).toContain("Claude");
    expect(html).toContain("Codex");
    expect(html).toContain("Gemini (Antigravity)");
    expect(html).toContain("OpenCode");
    expect(html).not.toContain("Gemini API");
    expect(html).not.toContain("Kimi");
    expect(html).not.toContain("not available at the moment");
    expect(html).toContain("Grok does not report a usage limit.");
    expect(html).toContain("Appears after your next Codex message.");
    expect(html).not.toContain("Appears after your next Grok message.");
    expect(html).not.toContain("Codex reports its limit after the next message.");
    expect(html).not.toContain(">Turns<");
    expect(html).not.toContain(">Tokens<");
    expect(html).not.toContain(">Cost<");
    expect(html).not.toContain("Friend");
    const grok = html.indexOf("Grok");
    const claude = html.indexOf("Claude");
    const codex = html.indexOf("Codex");
    const antigravity = html.indexOf("Gemini (Antigravity)");
    const opencode = html.indexOf("OpenCode");
    expect(grok).toBeGreaterThan(-1);
    expect(claude).toBeGreaterThan(grok);
    expect(codex).toBeGreaterThan(claude);
    expect(antigravity).toBeGreaterThan(codex);
    expect(opencode).toBeGreaterThan(antigravity);
  });

  it("shows refresh controls for the three supported engines", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
    expect((html.match(/>Refresh</g) ?? []).length).toBe(3);
  });

  it("renders a tight Grok-style header and a thin warn/danger progress bar", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
    expect(html).toContain("5-hour window");
    expect(html).toContain("Weekly");
    expect(html).toContain(">10%<");
    expect(html).toContain(">49%<");
    expect(html).toContain(">75%<");
    expect(html).toContain(">90%<");
    expect(html).not.toContain("% used<");
    expect(html).not.toContain(">40%<");
    expect(html).toMatch(/\bh-1\b/);
    expect(html).not.toContain("h-1.5");
    expect(html).toContain("bg-ink/10");
    const fillAt = (pct: number) => {
      const needle = `style="width:${pct}%"`;
      const at = html.indexOf(needle);
      expect(at).toBeGreaterThan(-1);
      return html.slice(Math.max(0, at - 80), at);
    };
    expect(fillAt(10)).toContain("bg-accent");
    expect(fillAt(49)).toContain("bg-accent");
    expect(fillAt(75)).toContain("bg-warning");
    expect(fillAt(90)).toContain("bg-danger");
    expect(fillAt(0)).toContain("bg-accent");
    expect(html).toContain("Resets in 1 hour");
    expect(html).toContain("Resets in 6 days");
    expect(html).toContain("Reset since the last check");
  });

  it("localizes refresh age units in English and Korean", () => {
    const claude = mockState.instances[0];
    const report = claude.rateLimits;
    if (!report) throw new Error("claude fixture missing rateLimits");
    const original = report.observedAt;
    try {
      report.observedAt = new Date(Date.now() - 5.5 * 60_000).toISOString();
      persistPreference("en");
      const englishMinutes = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(englishMinutes).toContain(">5m old<");
      persistPreference("ko");
      const koreanMinutes = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(koreanMinutes).toContain(">5분 전<");
      report.observedAt = new Date(Date.now() - 2.5 * 3_600_000).toISOString();
      persistPreference("en");
      const englishHours = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(englishHours).toContain(">2h old<");
      persistPreference("ko");
      const koreanHours = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(koreanHours).toContain(">2시간 전<");
    } finally {
      report.observedAt = original;
      persistPreference("en");
    }
  });

  it("keeps each engine's refresh busy until that request finishes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const deferred = new Map<string, (value: { report: { windows: { id: string; usedPercent: number }[]; observedAt: string } }) => void>();
    mockApi.mockImplementation((path: string) => new Promise((resolve) => {
      deferred.set(path.slice(path.lastIndexOf("/") + 1), resolve);
    }));
    try {
      persistPreference("en");
      await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
      const buttons = [...host.querySelectorAll("button")].filter((button) => button.textContent === "Refresh");
      expect(buttons).toHaveLength(3);
      await act(async () => {
        buttons[0]?.click();
        buttons[1]?.click();
      });
      expect([...host.querySelectorAll("button")].filter((button) => button.textContent === "Refreshing…")).toHaveLength(2);
      await act(async () => {
        deferred.get("grok")?.({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } });
      });
      const labels = [...host.querySelectorAll("button")].map((button) => button.textContent);
      expect(labels.filter((label) => label === "Refreshing…")).toHaveLength(1);
      expect(labels.filter((label) => label === "Refresh")).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      mockApi.mockReset();
      mockApi.mockImplementation(async (_path: string) => ({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } }));
    }
  });
});
