import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { PHONE_QUERY } from "@/lib/phone-swipe";
import { setUsageMode } from "@/lib/usage-preferences";
import { StoreProvider, useStore, type Bot, type InstanceInfo, type Message } from "@/state/store";

import { TermStatusLine } from "./TermStatusLine";

const now = Date.UTC(2026, 9, 11, 8, 30);
const bot: Bot = {
  id: "a", threadId: "thread-a", name: "A", cwd: "/default",
  title: "", description: "", color: "blue", notifications: false, unread: false,
  modelSelection: { instanceId: "current", model: "old-model", effort: "low" },
  messages: [],
};
const engine: InstanceInfo = {
  instanceId: "current", driverKind: "claudeAgent", displayName: "Current",
  snapshot: { state: "available" },
  models: { default: "old-model", options: [{ id: "old-model", label: "Old model" }] },
  rateLimits: {
    observedAt: new Date(now - 60_000).toISOString(),
    windows: [{ id: "five_hour", usedPercent: 71, resetsAt: now + 60_000 }],
  },
};
const summary = (id: string, at: number, parentId?: string): Message => ({
  id, at, parentId, role: "bot", kind: "compaction",
  compaction: {
    v: 1, summary: "Fixture summary.", coveredThroughId: "prompt", firstKeptId: null,
    contextWindow: 200000, estimatedTokensBefore: 150000, sourceMessageCount: 40,
  },
});

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.skin;
  applyLocale("en");
  setUsageMode("remaining");
});

async function render(current = bot, instance = engine, cwd?: string | null, instances = [instance], locale: "en" | "ko" = "en", turns?: number) {
  applyLocale(locale);
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class {
    close() {}
  });
  let store: ReturnType<typeof useStore>;
  function Harness() {
    store = useStore();
    return createElement(TermStatusLine, { bot: current, engine: instance, cwd, turns });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Harness))));
  await act(async () => store.dispatch({ type: "instances", instances }));
  return Object.assign(host, { store: () => store });
}

function phoneMedia(matches = true) {
  const media = window.matchMedia(`${PHONE_QUERY} and (pointer: coarse)`);
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  vi.spyOn(media, "matches", "get").mockReturnValue(matches);
  return media;
}

describe("TermStatusLine", () => {
  it.each(["terminal", "terminal-dracula", "terminal-ice", "paper-tape", "logfile", "multiplexer", "modal"])("fits the phone cut for %s in both locales", async (skin) => {
    phoneMedia();
    document.documentElement.dataset.skin = skin;
    for (const locale of ["en", "ko"] as const) {
      const current = { ...bot, name: "Pokkey Film Production Assistant", messages: [summary("saved", now - 3600_000)] };
      const instance = {
        ...engine,
        models: { default: "old-model", options: [{ id: "old-model", label: "Claude Sonnet 4.6 (Thinking)" }] },
        rateLimits: { observedAt: new Date(now - 60_000).toISOString(), windows: [
          { id: "five_hour", usedPercent: 10, resetsAt: now + 60_000 },
          { id: "seven_day", usedPercent: 71, resetsAt: now + (5 * 24 + 6) * 3600_000 },
        ] },
      };
      const host = await render(current, instance, undefined, [instance], locale, 9999);
      const status = host.querySelector("[data-term-status]")!;
      expect(status.getAttribute("data-term-phone")).toBe(skin);
      expect(status.querySelector("[data-term-model]")?.textContent).toBe(skin === "multiplexer" ? "Sonnet 4.6" : "◆ Sonnet 4.6");
      expect(status.textContent).not.toMatch(/Claude|Thinking|\/default|low|9999|summary|요약/);
      const button = status.querySelector("button")!;
      expect(button.textContent).toContain(locale === "en" ? "7d" : "7일");
      expect(button.textContent).toContain("29%");
      expect(button.textContent).toContain(locale === "en" ? "(5d6h)" : "(5일 6시간)");
      if (skin === "multiplexer") expect(button.textContent).not.toContain(locale === "en" ? "5h" : "5시간");
      else {
        expect(button.textContent).toContain(locale === "en" ? "5h" : "5시간");
        expect(button.textContent).toContain("90%");
        expect(button.textContent).toContain(locale === "en" ? "(1m)" : "(1분)");
      }
      const tab = status.querySelector("[data-term-tab]");
      expect(tab?.textContent ?? null).toBe(skin === "multiplexer" ? `0:${current.name}*` : null);
      await act(async () => button.click());
      expect(host.store().state.appSettingsOpen).toBe(true);
      expect(host.store().state.appSettingsSection).toBe("usage");
      await unmount?.();
      unmount = null;
    }
  });

  it.each([
    ["remaining", 80, 20, "5h", "(1h)", 20],
    ["remaining", 20, 80, "7d", "(5d6h)", 20],
    ["remaining", 80, 80, "5h", "(1h)", 20],
    ["remaining", 100, 120, "5h", "(1h)", 0],
    ["used", 80, 20, "5h", "(1h)", 80],
    ["used", 20, 80, "7d", "(5d6h)", 80],
    ["used", 80, 80, "5h", "(1h)", 80],
    ["used", 100, 120, "5h", "(1h)", 100],
  ] as const)("selects the tighter window in %s mode (%i session / %i weekly used -> %s)", async (mode, session, weekly, label, reset, percent) => {
    phoneMedia();
    document.documentElement.dataset.skin = "multiplexer";
    setUsageMode(mode);
    const host = await render(bot, {
      ...engine,
      rateLimits: { ...engine.rateLimits!, windows: [
        { id: "seven_day", usedPercent: weekly, resetsAt: now + (5 * 24 + 6) * 3600_000 },
        { id: "five_hour", usedPercent: session, resetsAt: now + 3600_000 },
      ] },
    });
    const button = host.querySelector("button")!;
    expect(button.textContent).toContain(label);
    expect(button.textContent).toContain(reset);
    expect(button.textContent).toContain(`${percent}%`);
    expect(button.textContent).not.toContain(label === "5h" ? "7d" : "5h");
  });

  it.each(["multiplexer", "modal"])("keeps a weekly-only report in %s", async (skin) => {
    phoneMedia();
    document.documentElement.dataset.skin = skin;
    const host = await render(bot, {
      ...engine,
      rateLimits: { ...engine.rateLimits!, windows: [{ id: "seven_day", usedPercent: 71, resetsAt: now + (5 * 24 + 6) * 3600_000 }] },
    });
    const button = host.querySelector("button")!;
    expect(button.textContent).toContain("7d");
    expect(button.textContent).toContain("29% (5d6h)");
    expect(button.textContent).not.toContain("5h");
  });

  it("falls back to the session meter when there is no weekly window", async () => {
    phoneMedia();
    const host = await render();
    expect(host.querySelector("[data-term-phone] button")?.textContent).toContain("5h");
    expect(host.querySelector("button")?.textContent).toContain("29%");
    expect(host.querySelector("button")?.textContent).toContain("(1m)");
  });

  it("drops the graphic before the meter text and restores it when space returns", async () => {
    const media = phoneMedia();
    document.documentElement.dataset.skin = "multiplexer";
    const natural = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
    const host = await render();
    const status = host.querySelector("[data-term-status]")!;
    expect(status.getAttribute("data-term-bars")).toBe("off");
    expect(status.querySelector("button")?.textContent).toContain("29% (1m)");
    natural.mockReturnValue(320);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(status.hasAttribute("data-term-bars")).toBe(false);
    natural.mockReturnValue(400);
    await act(async () => window.dispatchEvent(new Event("resize")));
    vi.spyOn(media, "matches", "get").mockReturnValue(false);
    await act(async () => media.dispatchEvent(new Event("change")));
    expect(status.hasAttribute("data-term-bars")).toBe(false);
    expect(status.hasAttribute("data-term-phone")).toBe(false);
  });

  it("keeps a stale phone reading accessible when the visual age is omitted", async () => {
    phoneMedia();
    const host = await render(bot, { ...engine, driverKind: "museAgent", rateLimits: { ...engine.rateLimits!, observedAt: new Date(now - 4 * 86400_000).toISOString() } });
    const button = host.querySelector("button")!;
    const age = host.querySelector(`[id="${button.getAttribute("aria-describedby")}"]`)!;
    expect(age.textContent).toBe("Last seen 4d ago");
    expect(age.className).toBe("sr-only");
    expect(button.className).toContain("text-ink-secondary");
  });

  it.each([false, true])("keeps desktop markup when the phone query is %s and restores it on resize", async (matches) => {
    const media = phoneMedia(matches);
    const host = await render();
    if (matches) {
      expect(host.querySelector("[data-term-phone]")).not.toBeNull();
      vi.spyOn(media, "matches", "get").mockReturnValue(false);
      await act(async () => media.dispatchEvent(new Event("change")));
    }
    expect(host.querySelector("[data-term-phone]")).toBeNull();
    expect(host.textContent).toContain("Old model");
    expect(host.textContent).toContain("/default");
    expect(host.textContent).toContain("no summary yet");
  });

  it("mutes and describes a stale Muse reading with its age", async () => {
    const host = await render(bot, { ...engine, driverKind: "museAgent", rateLimits: { ...engine.rateLimits!, observedAt: new Date(now - 4 * 86400_000).toISOString() } });
    const button = host.querySelector("button")!;
    expect(button.textContent).toContain("Last seen 4d ago");
    expect(button.textContent).toMatch(/^Last seen 4d ago · 5h/);
    expect(button.className).toContain("text-ink-secondary");
    const age = button.getAttribute("aria-describedby");
    expect(age).toBeTruthy();
    expect(host.querySelector('[id="' + age + '"]')?.textContent).toBe("Last seen 4d ago");
    expect(button.getAttribute("aria-label")).toBe("Open usage settings");
  });

  it("discloses a fresh Muse reading without muting it", async () => {
    const host = await render(bot, { ...engine, driverKind: "museAgent" });
    expect(host.textContent).toContain("As of 1m ago");
    expect(host.querySelector("button")?.className).not.toContain("text-ink-secondary");
  });

  it("labels the pending model with its matching instance and effort", async () => {
    const next = { ...engine, instanceId: "next", models: { default: "next-model", options: [{ id: "next-model", label: "Next model" }] } };
    const host = await render({ ...bot, pendingModelSelection: { instanceId: "next", model: "next-model", effort: "high" } }, engine, undefined, [engine, next]);
    expect(host.textContent).toContain("Next model");
    expect(host.textContent).toContain("high");
    expect(host.textContent).not.toContain("Old model");
    expect(host.textContent).not.toContain("low");
  });

  it("hides bars when a busy bot's pending pick reports no windows", async () => {
    const gemini: InstanceInfo = {
      ...engine,
      instanceId: "gemini",
      driverKind: "geminiAgent",
      rateLimits: undefined,
      models: { default: "gemini-flash", options: [{ id: "gemini-flash", label: "Gemini 3.8 Flash" }] },
    };
    const host = await render(
      { ...bot, busy: true, pendingModelSelection: { instanceId: "gemini", model: "gemini-flash", effort: "high" } },
      engine,
      undefined,
      [engine, gemini],
    );
    expect(host.querySelector("[data-term-status] button")).toBeNull();
    expect(host.textContent).not.toContain("5h");
    expect(host.textContent).not.toContain("29%");
  });

  it("shows the pending instance's windows and reading", async () => {
    const muse: InstanceInfo = {
      ...engine,
      instanceId: "muse",
      driverKind: "museAgent",
      models: { default: "muse-model", options: [{ id: "muse-model", label: "Muse model" }] },
      rateLimits: {
        observedAt: new Date(now - 4 * 86400_000).toISOString(),
        windows: [
          { id: "five_hour", usedPercent: 10, resetsAt: now + 3_600_000 },
          { id: "seven_day", usedPercent: 40, resetsAt: now + 86_400_000 },
        ],
      },
    };
    const host = await render(
      { ...bot, busy: true, pendingModelSelection: { instanceId: "muse", model: "muse-model", effort: "high" } },
      engine,
      undefined,
      [engine, muse],
    );
    const status = host.querySelector("[data-term-status]")!;
    expect(status.textContent).toContain("Last seen 4d ago");
    expect(status.textContent).toContain("90%");
    expect(status.textContent).toContain("60%");
    expect(status.textContent).not.toContain("29%");
  });

  it("shows the running engine's bars when nothing is pending", async () => {
    const host = await render({ ...bot, busy: true });
    const status = host.querySelector("[data-term-status]")!;
    expect(status.textContent).toContain("5h");
    expect(status.textContent).toContain("29%");
    expect(status.textContent).not.toContain("Last seen");
  });

  it.each(["/pinned", null])("uses the task's %s folder instead of the bot default", async (cwd) => {
    const host = await render(bot, engine, cwd);
    expect(host.textContent).not.toContain("/default");
    if (cwd) expect(host.textContent).toContain(cwd);
  });

  it("reports only the active branch's latest valid summary", async () => {
    const messages: Message[] = [
      { id: "prompt", at: now - 4 * 3600_000, role: "user", kind: "text", text: "Fixture prompt." },
      summary("active", now - 2 * 3600_000, "prompt"),
      summary("inactive", now - 60_000, "prompt"),
      { ...summary("invalid", now - 30_000, "active"), compaction: { v: 1 } },
      { ...summary("unsupported", now - 20_000, "invalid"), compaction: { v: 2 } },
    ];
    const host = await render({ ...bot, messages, activeLeafId: "unsupported" });
    expect(host.textContent).toContain("summary 2h ago");
    expect(host.textContent).not.toContain("summary 0m ago");
  });

  it.each([{ v: 1 }, { v: 2 }])("does not count %j as a usable summary", async (compaction) => {
    const host = await render({ ...bot, messages: [{ ...summary("bad", now - 60_000), compaction }] });
    expect(host.textContent).toContain("no summary yet");
  });

  it("does not clone a flat transcript to find its last summary", async () => {
    const messages = [summary("saved", now - 2 * 3600_000)];
    const copies = vi.spyOn(messages, Symbol.iterator);
    const host = await render({ ...bot, messages });
    expect(host.textContent).toContain("summary 2h ago");
    expect(copies).not.toHaveBeenCalled();
  });
});
