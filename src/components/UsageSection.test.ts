// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

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
        engine("grok", "grokAgent", "Grok", { capabilities: { rateLimits: true } }),
        engine("gemini", "geminiAgent", "Gemini API"),
        engine("antigravity", "antigravityAgent", "Gemini (Antigravity)", { capabilities: { rateLimits: true } }),
        engine("muse", "museAgent", "Meta Muse", {
          capabilities: { rateLimits: true },
          rateLimits: {
            observedAt: new Date().toISOString(),
            windows: [
              { id: "five_hour", usedPercent: 22, resetsAt: Date.now() + 3_600_000 },
              { id: "seven_day", usedPercent: 61, resetsAt: Date.now() + 6 * 86_400_000 },
            ],
          },
        }),
      ],
    },
    mockApi: vi.fn(async (_path: string): Promise<{ report?: { windows: { id: string; usedPercent: number }[]; observedAt: string }; error?: string; status?: string }> => ({
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
  afterEach(() => setUsageMode("remaining"));

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
      const up = [...host.querySelectorAll("button")].find((button) => button.textContent === "Count up (used)");
      expect(down).toBeDefined();
      expect(down?.getAttribute("aria-pressed")).toBe("true");
      await act(async () => up?.click());
      expect(up?.getAttribute("aria-pressed")).toBe("true");
      expect(down?.getAttribute("aria-pressed")).toBe("false");
      await act(async () => down?.click());
      expect(down?.getAttribute("aria-pressed")).toBe("true");
      expect(localStorage.getItem("omb-usage-mode")).toBe("remaining");
      expect(host.querySelector('[aria-label="5h: 10% remaining"]')?.textContent).toContain("▰▱▱▱▱▱▱▱▱▱");
      expect(host.querySelector('[aria-label="5h: 10% remaining"] .text-danger')).not.toBeNull();
      expect(host.querySelector('[aria-label="5h: 90% remaining"]')?.textContent).toContain("▰▰▰▰▰▰▰▰▰▱");
      expect(host.querySelector('[aria-label="5h: 90% remaining"] .text-accent')).not.toBeNull();
      await act(async () => root.unmount());
      root = createRoot(host);
      await act(async () => root.render(createElement(UsageSection)));
      expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe("Count down (remaining)");
    } finally {
      await act(async () => root.unmount());
      await act(async () => setUsageMode("remaining"));
      host.remove();
    }
  });

  it("shows the featured engines in picker order and hides the per-bot table", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
    expect(html).toContain("Plan usage");
    expect(html).toContain("flex flex-col gap-5");
    expect(html).toContain("Grok");
    expect(html).toContain("Claude");
    expect(html).toContain("Codex");
    expect(html).not.toContain("Gemini (Antigravity)");
    expect(html).toContain("Meta Muse");
    expect(html).not.toContain("OpenCode");
    expect(html).not.toContain("Gemini API");
    expect(html).not.toContain("Kimi");
    expect(html).not.toContain("not available at the moment");
    expect(html).toContain("Appears after your next Grok message.");
    expect(html).toContain("Appears after your next Codex message.");
    expect(html).not.toContain("Grok does not report a usage limit.");
    expect(html).not.toContain("Codex reports its limit after the next message.");
    expect(html).not.toContain(">Turns<");
    expect(html).not.toContain(">Tokens<");
    expect(html).not.toContain(">Cost<");
    expect(html).not.toContain("Friend");
    const grok = html.indexOf("Grok");
    const claude = html.indexOf("Claude");
    const codex = html.indexOf("Codex");
    const muse = html.indexOf("Meta Muse");
    expect(claude).toBeGreaterThan(-1);
    expect(codex).toBeGreaterThan(claude);
    expect(grok).toBeGreaterThan(codex);
    expect(muse).toBeGreaterThan(grok);
  });

  it("shows Meta Muse 5-hour and 7-day windows", () => {
    setUsageMode("used");
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
    expect(html).toContain("Meta Muse");
    expect(html).toContain('aria-label="5h: 22% used"');
    expect(html).toContain('aria-label="7d: 61% used"');
  });

  it("labels Meta Muse windows with their cached observation age", () => {
    const muse = mockState.instances.find((instance) => instance.instanceId === "muse");
    if (!muse?.rateLimits) throw new Error("muse fixture missing rateLimits");
    const original = muse.rateLimits.observedAt;
    try {
      persistPreference("en");
      muse.rateLimits.observedAt = new Date(Date.now() - 2.5 * 3_600_000).toISOString();
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(html).toContain("Cached, as of 2h ago.");
    } finally {
      muse.rateLimits.observedAt = original;
      persistPreference("en");
    }
  });

  it("includes the subscription engines in the single refresh-all", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mockApi.mockClear();
    try {
      persistPreference("en");
      await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
      const refreshAll = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Refresh all");
      expect(refreshAll).toBeDefined();
      expect(refreshAll?.getAttribute("aria-keyshortcuts")).toBe("Alt+R");
      await act(async () => {
        refreshAll?.click();
      });
      expect(mockApi).not.toHaveBeenCalledWith("/api/usage/refresh/antigravity", { method: "POST" });
      expect(mockApi).toHaveBeenCalledWith("/api/usage/refresh/muse", { method: "POST" });
    } finally {
      await act(async () => root.unmount());
      host.remove();
      mockApi.mockClear();
      persistPreference("en");
    }
  });

  it("does not call a retained or empty Muse snapshot freshly updated", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mockApi.mockReset();
    mockApi.mockImplementation(async (path: string) =>
      path.endsWith("/muse") ? { status: "no_observation" } : { status: "fresh" },
    );
    try {
      persistPreference("en");
      await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
      const refreshAll = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Refresh all");
      expect(refreshAll).toBeDefined();
      await act(async () => {
        refreshAll?.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(host.querySelector('button[aria-label="Refresh all"]')).not.toBeNull());
      expect(host.querySelector('[role="status"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      mockApi.mockReset();
      mockApi.mockImplementation(async (_path: string) => ({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } }));
      persistPreference("en");
    }
  });

  it("shows exactly one refresh control for the whole section, never per-engine ones", () => {
    try {
      persistPreference("en");
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect((html.match(/aria-label="Refresh all"/g) ?? []).length).toBe(1);
      expect(html).not.toContain(">Refresh<");
      expect(html).toContain("lucide-refresh-cw");
      expect(html).toContain("rounded-full");
    } finally {
      persistPreference("en");
    }
  });

  it("handles Alt+R only for visible Usage and leaves chat, terminal, and picker focus alone", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const composer = document.createElement("textarea");
    composer.setAttribute("data-orbit-composer", "");
    document.body.append(composer);
    mockApi.mockClear();
    const send = (init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", {
      code: "KeyR", altKey: true, bubbles: true, cancelable: true, ...init,
    });
    try {
      persistPreference("en");
      await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
      const first = send();
      await act(async () => window.dispatchEvent(first));
      expect(first.defaultPrevented).toBe(true);
      expect(mockApi).toHaveBeenCalledTimes(4);

      for (const event of [
        send({ repeat: true }),
        send({ isComposing: true }),
        send({ ctrlKey: true }),
        send({ metaKey: true }),
        send({ shiftKey: true }),
      ]) {
        await act(async () => window.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(false);
      }
      expect(mockApi).toHaveBeenCalledTimes(4);

      composer.focus();
      const whileTyping = send();
      await act(async () => window.dispatchEvent(whileTyping));
      expect(whileTyping.defaultPrevented).toBe(false);
      expect(mockApi).toHaveBeenCalledTimes(4);

      const picker = document.createElement("div");
      picker.setAttribute("data-model-picker-content", "");
      document.body.append(picker);
      const overPicker = send();
      await act(async () => window.dispatchEvent(overPicker));
      expect(overPicker.defaultPrevented).toBe(false);
      picker.remove();

      const terminal = document.createElement("div");
      terminal.className = "orbit-terminal-overlay";
      terminal.dataset.open = "true";
      terminal.setAttribute("data-orbit-terminal", "");
      document.body.append(terminal);
      const overTerminal = send();
      await act(async () => window.dispatchEvent(overTerminal));
      expect(overTerminal.defaultPrevented).toBe(false);
      terminal.remove();
      composer.blur();

      const closedTerminal = document.createElement("div");
      closedTerminal.className = "orbit-terminal-overlay";
      closedTerminal.dataset.open = "false";
      closedTerminal.setAttribute("data-orbit-terminal", "");
      document.body.append(closedTerminal);
      const besideClosedTerminal = send();
      await act(async () => window.dispatchEvent(besideClosedTerminal));
      expect(besideClosedTerminal.defaultPrevented).toBe(true);
      expect(mockApi).toHaveBeenCalledTimes(8);
      closedTerminal.remove();

      await act(async () => root.unmount());
      const afterClose = send();
      await act(async () => window.dispatchEvent(afterClose));
      expect(afterClose.defaultPrevented).toBe(false);
      expect(mockApi).toHaveBeenCalledTimes(8);
    } finally {
      host.remove();
      composer.remove();
      mockApi.mockReset();
      mockApi.mockImplementation(async (_path: string) => ({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } }));
      persistPreference("en");
    }
  });

  it("shares one left-aligned column across engine rows instead of centering each grid", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const codex = mockState.instances.find((instance) => instance.instanceId === "codex");
    if (!codex) throw new Error("codex fixture missing");
    const original = codex.rateLimits;
    // settings rows show windows only, so Codex borrows one window here to
    // prove both value columns share one structure and one left alignment —
    // a future engine row inherits it instead of re-centering itself.
    codex.rateLimits = {
      observedAt: new Date().toISOString(),
      windows: [{ id: "five_hour", usedPercent: 20, resetsAt: Date.now() + 3_600_000 }],
    };
    // The Meta Muse fixture row carries windows, which would add its own
    // column to the count; park them so this test measures the shared
    // structure, not the engine roster.
    const muse = mockState.instances.find((instance) => instance.instanceId === "muse");
    if (!muse) throw new Error("muse fixture missing");
    const museOriginal = muse.rateLimits;
    muse.rateLimits = undefined;
    try {
      persistPreference("en");
      setUsageMode("used");
      await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
      const columns = [...host.querySelectorAll("div.mt-2.flex.flex-col.items-start")];
      expect(columns.length).toBe(2);
      for (const column of columns) {
        expect(column.className).toBe(columns[0]?.className);
      }
      expect(host.innerHTML).not.toContain("mx-auto");
      expect(host.innerHTML).not.toContain("w-fit");
    } finally {
      codex.rateLimits = original;
      muse.rateLimits = museOriginal;
      await act(async () => root.unmount());
      host.remove();
      persistPreference("en");
    }
  });

  it("renders every window as the chat's compact meter, with the Opus row labeled and stale windows as text", () => {
    setUsageMode("used");
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
    // five windows stacked in the shared single column, left-aligned
    expect(html).toContain("mt-2 flex flex-col items-start gap-1.5");
    expect(html).toContain('aria-label="5h: 10% used"');
    expect(html).toContain('aria-label="7d: 49% used"');
    expect(html).toContain(">Opus<");
    expect(html).toContain('aria-label="7d: 75% used"');
    expect(html).toContain('aria-label="5h: 90% used"');
    expect(html).toContain("▰▱▱▱▱▱▱▱▱▱");
    expect(html).toContain("▰▰▰▰▰▱▱▱▱▱");
    expect(html).toContain("▰▰▰▰▰▰▰▰▱▱");
    expect(html).toContain("▰▰▰▰▰▰▰▰▰▱");
    expect(html).toContain("text-accent");
    expect(html).toContain("text-warning");
    expect(html).toContain("text-danger");
    expect(html).not.toContain("% used<");
    expect(html).not.toContain(">40%<");
    expect(html).not.toContain("rounded-full bg-ink/10");
    expect(html).not.toContain('style="width:');
    expect(html).toContain('title="Resets in 1 hour"');
    expect(html).toContain('title="Resets in 6 days"');
    expect(html).toContain("Reset since the last check");
  });

  it("omits banked token counts from settings rows while keeping staleness visible", () => {
    try {
      persistPreference("en");
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      // the fixture banks tokens on the Grok bot, but settings rows never show
      // turn input/output counts — only the chat strip does
      expect(html).not.toContain("↑");
      expect(html).not.toContain("↓");
      expect(html).not.toContain("10 in · 4 out");
      // the refresh age remains available from the provider tooltip
      expect(html).toMatch(/title="\d+[mh] old"/);
      expect(html).not.toMatch(/>\d+[mh] old</);
      expect(html).toContain("Appears after your next Codex message.");
    } finally {
      persistPreference("en");
    }
  });

  it("keeps the token readout in the chat strip only", () => {
    persistPreference("en");
    const settings = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
    const tokenSpan = '<span class="shrink-0 tabular-nums text-[12.5px] text-ink-secondary" title="10 in · 4 out">↑10 ↓4</span>';
    expect(settings).not.toContain(tokenSpan);
    expect(settings).not.toContain("↑10 ↓4");
    // the same spend still renders its readout above the composer
    const chat = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(ChatPlanMeters, {
        windows: [{ id: "five_hour", usedPercent: 10, resetsAt: Date.now() + 3_600_000 }],
        usage: { input: 10, output: 4, costUsd: 0.01, turns: 2 },
      })));
    expect(chat).toContain(tokenSpan);
  });

  it("orders windows session-first like the chat strip without dropping any", () => {
    persistPreference("en");
    setUsageMode("used");
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
    // report order is five_hour, seven_day, opus, primary, stale; chat's
    // priority is session then weekly, so the Codex-named session sorts up
    const fiveHour = html.indexOf('aria-label="5h: 10% used"');
    const primary = html.indexOf('aria-label="5h: 90% used"');
    const weekly = html.indexOf('aria-label="7d: 49% used"');
    const opus = html.indexOf('aria-label="7d: 75% used"');
    expect(fiveHour).toBeGreaterThan(-1);
    expect(primary).toBeGreaterThan(fiveHour);
    expect(weekly).toBeGreaterThan(primary);
    expect(opus).toBeGreaterThan(weekly);
    expect(html).toContain("Reset since the last check");
  });

  it("stacks three windows with no spend readout in the shared single column", () => {
    const report = mockState.instances[0].rateLimits;
    if (!report) throw new Error("claude fixture missing rateLimits");
    const originalWindows = report.windows;
    try {
      persistPreference("en");
      setUsageMode("used");
      report.windows = [
        { id: "five_hour", usedPercent: 10, resetsAt: Date.now() + 3_600_000 },
        { id: "seven_day", usedPercent: 49, resetsAt: Date.now() + 6 * 86_400_000 },
        { id: "seven_day_opus", usedPercent: 75, resetsAt: Date.now() + 6 * 86_400_000 },
      ];
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(html).toContain("mt-2 flex flex-col items-start gap-1.5");
      expect(html).not.toContain("grid-cols-");
      expect(html).toContain('aria-label="5h: 10% used"');
      expect(html).toContain('aria-label="7d: 49% used"');
      expect(html).toContain('aria-label="7d: 75% used"');
      // banked spend no longer renders a count in settings rows
      expect(html).not.toContain("↑");
      expect(html).not.toContain("Reset since the last check");
    } finally {
      report.windows = originalWindows;
      persistPreference("en");
    }
  });

  it("names the Opus meter's group in English and Korean", () => {
    setUsageMode("used");
    const opusGroup = (html: string, meter: string) =>
      new DOMParser()
        .parseFromString(html, "text/html")
        .querySelector(`[aria-label="${meter}"]`)
        ?.parentElement?.closest('[role="group"]')
        ?.getAttribute("aria-label");
    try {
      persistPreference("en");
      const english = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(opusGroup(english, "7d: 75% used")).toBe("Opus 7d");
      persistPreference("ko");
      const korean = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(opusGroup(korean, "7일: 75% 사용")).toBe("Opus 7일");
    } finally {
      persistPreference("en");
    }
  });

  it("keeps an unreported reset in English and Korean", () => {
    const report = mockState.instances[0].rateLimits;
    if (!report) throw new Error("claude fixture missing rateLimits");
    const original = report.windows;
    try {
      report.windows = [...original, { id: "secondary", usedPercent: 46, windowMinutes: 10080, resetsAt: null }];
      persistPreference("en");
      expect(renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)))).toContain(">Reset time not reported<");
      persistPreference("ko");
      expect(renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)))).toContain(">초기화 시각이 보고되지 않았습니다<");
    } finally {
      report.windows = original;
      persistPreference("en");
    }
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
      expect(englishMinutes).toContain('title="5m old"');
      expect(englishMinutes).not.toContain(">5m old<");
      persistPreference("ko");
      const koreanMinutes = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(koreanMinutes).toContain('title="5분 전"');
      expect(koreanMinutes).not.toContain(">5분 전<");
      report.observedAt = new Date(Date.now() - 2.5 * 3_600_000).toISOString();
      persistPreference("en");
      const englishHours = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(englishHours).toContain('title="2h old"');
      expect(englishHours).not.toContain(">2h old<");
      persistPreference("ko");
      const koreanHours = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
      expect(koreanHours).toContain('title="2시간 전"');
      expect(koreanHours).not.toContain(">2시간 전<");
    } finally {
      report.observedAt = original;
      persistPreference("en");
    }
  });

  it("keeps the single refresh control busy until every engine request finishes", async () => {
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
      expect([...host.querySelectorAll("button")].filter((button) => button.textContent === "Refresh")).toHaveLength(0);
      const refreshAll = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Refresh all");
      expect(refreshAll).toBeDefined();
      await act(async () => {
        refreshAll?.click();
      });
      // one control refreshes every subscription engine together
      expect(mockApi).toHaveBeenCalledTimes(4);
      const busy = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Refreshing…");
      expect(busy).toBeDefined();
      expect(busy?.hasAttribute("disabled")).toBe(true);
      // a second click while busy issues no new requests
      await act(async () => {
        busy?.click();
      });
      expect(mockApi).toHaveBeenCalledTimes(4);
      await act(async () => {
        deferred.get("claude")?.({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } });
        deferred.get("codex")?.({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } });
        deferred.get("grok")?.({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } });
        deferred.get("muse")?.({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } });
      });
      expect([...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Refresh all")).toBeDefined();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      mockApi.mockReset();
      mockApi.mockImplementation(async (_path: string) => ({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } }));
    }
  });

  it("ignores a second Alt+R while the refresh-all run is busy", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const deferred = new Map<string, (value: { report: { windows: { id: string; usedPercent: number }[]; observedAt: string } }) => void>();
    mockApi.mockReset();
    mockApi.mockImplementation((path: string) => new Promise((resolve) => {
      deferred.set(path.slice(path.lastIndexOf("/") + 1), resolve);
    }));
    try {
      persistPreference("en");
      await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
      const event = new KeyboardEvent("keydown", { code: "KeyR", altKey: true, bubbles: true, cancelable: true });
      await act(async () => window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(mockApi).toHaveBeenCalledTimes(4);
      expect(host.querySelector('button[aria-label="Refreshing…"]')).not.toBeNull();

      const second = new KeyboardEvent("keydown", { code: "KeyR", altKey: true, bubbles: true, cancelable: true });
      await act(async () => window.dispatchEvent(second));
      expect(second.defaultPrevented).toBe(true);
      expect(mockApi).toHaveBeenCalledTimes(4);

      await act(async () => {
        for (const name of ["claude", "codex", "grok", "muse"]) {
          deferred.get(name)?.({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } });
        }
      });
      expect(host.querySelector('button[aria-label="Refresh all"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      mockApi.mockReset();
      mockApi.mockImplementation(async (_path: string) => ({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } }));
    }
  });

  it("confirms a successful refresh explicitly and clears the note on the next run", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const deferred = new Map<string, (value: { report: { windows: { id: string; usedPercent: number }[]; observedAt: string } }) => void>();
    mockApi.mockImplementation((path: string) => new Promise((resolve) => {
      deferred.set(path.slice(path.lastIndexOf("/") + 1), resolve);
    }));
    const finish = () => act(async () => {
      deferred.get("claude")?.({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } });
      deferred.get("codex")?.({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } });
      deferred.get("grok")?.({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } });
      deferred.get("muse")?.({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } });
    });
    try {
      persistPreference("en");
      await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
      expect(host.textContent).not.toContain("Updated just now");
      await act(async () => {
        [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Refresh all")?.click();
      });
      // no confirmation while the run is still busy
      expect(host.textContent).not.toContain("Updated just now");
      await finish();
      expect(host.textContent).toContain("Updated just now");
      // announced politely: the note is a live-region status
      const status = host.querySelector('[role="status"]');
      expect(status?.textContent).toContain("Updated just now");
      // the next run clears the note until it succeeds again
      await act(async () => {
        [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Refresh all")?.click();
      });
      expect(host.textContent).not.toContain("Updated just now");
      await finish();
      expect(host.textContent).toContain("Updated just now");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      mockApi.mockReset();
      mockApi.mockImplementation(async (_path: string) => ({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } }));
    }
  });

  it("shows no confirmation when a refresh reports an error", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mockApi.mockImplementation(async (path: string) => (
      path.endsWith("/grok") ? { error: "stale" } : { report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } }
    ));
    try {
      persistPreference("en");
      await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
      await act(async () => {
        [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Refresh all")?.click();
      });
      expect(host.textContent).not.toContain("Updated just now");
      expect(host.textContent).toContain("stale");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      mockApi.mockReset();
      mockApi.mockImplementation(async (_path: string) => ({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } }));
    }
  });

  it("says no usage data yet when a refresh fails with nothing saved", async () => {
    // claude carries last-good values in the fixture, codex carries
    // none — one refresh-all covers both wordings.
    mockApi.mockImplementation(async (path: string) => {
      if (path.endsWith("/claude")) return { error: "Could not refresh Claude limits" };
      if (path.endsWith("/codex")) return { error: "Could not refresh Codex limits" };
      return { report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } };
    });
    try {
      persistPreference("en");
      const enHost = document.createElement("div");
      document.body.append(enHost);
      const enRoot = createRoot(enHost);
      await act(async () => enRoot.render(createElement(I18nProvider, null, createElement(UsageSection))));
      await act(async () => {
        [...enHost.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Refresh all")?.click();
      });
      expect(enHost.textContent).toContain("Could not refresh Claude limits Showing the last good values.");
      expect(enHost.textContent).toContain("Could not refresh Codex limits No usage data yet.");
      expect(enHost.textContent).not.toMatch(/\d+[mh] old/);
      await act(async () => enRoot.unmount());
      enHost.remove();

      persistPreference("ko");
      const koHost = document.createElement("div");
      document.body.append(koHost);
      const koRoot = createRoot(koHost);
      await act(async () => koRoot.render(createElement(I18nProvider, null, createElement(UsageSection))));
      await act(async () => {
        [...koHost.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "모두 새로 고침")?.click();
      });
      expect(koHost.textContent).toContain("아직 사용량 정보가 없습니다.");
      expect(koHost.textContent).not.toContain("— 전 정보");
      await act(async () => koRoot.unmount());
      koHost.remove();
    } finally {
      persistPreference("en");
      mockApi.mockReset();
      mockApi.mockImplementation(async (_path: string) => ({ report: { windows: [], observedAt: "2026-01-01T00:00:00.000Z" } }));
    }
  });
});
