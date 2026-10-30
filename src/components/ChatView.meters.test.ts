// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { applySkin } from "@/lib/skins";
import { setUsageMode } from "@/lib/usage-preferences";
import { StoreProvider, useStore, type Bot, type InstanceInfo } from "@/state/store";

import { ChatView } from "./ChatView";

// SAFETY: React reads this flag off globalThis at act() time; the DOM lib does not declare it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.UTC(2026, 9, 11, 8, 30);

const claude: InstanceInfo = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  displayName: "Claude",
  snapshot: { state: "available" },
  models: { default: "claude-opus", options: [{ id: "claude-opus", label: "Claude Opus" }] },
  rateLimits: {
    observedAt: new Date(now - 60_000).toISOString(),
    windows: [{ id: "five_hour", usedPercent: 71, resetsAt: now + 3_600_000 }],
  },
};

const gemini: InstanceInfo = {
  instanceId: "gemini",
  driverKind: "geminiAgent",
  displayName: "Gemini",
  snapshot: { state: "available" },
  models: { default: "gemini-flash", options: [{ id: "gemini-flash", label: "Gemini 3.8 Flash" }] },
};

const muse: InstanceInfo = {
  instanceId: "muse",
  driverKind: "museAgent",
  displayName: "Muse",
  snapshot: { state: "available" },
  models: { default: "muse-model", options: [{ id: "muse-model", label: "Muse model" }] },
  rateLimits: {
    observedAt: new Date(now - 4 * 86400_000).toISOString(),
    windows: [
      { id: "five_hour", usedPercent: 10, resetsAt: now + 3_600_000 },
      { id: "seven_day", usedPercent: 40, resetsAt: now + 86_400_000 },
    ],
  },
};

const busy: Bot = {
  id: "a",
  threadId: "thread-a",
  name: "A",
  title: "",
  description: "",
  color: "blue",
  notifications: false,
  unread: false,
  busy: true,
  activity: "working",
  cwd: "/repo",
  modelSelection: { instanceId: "claude", model: "claude-opus", effort: "high" },
  messages: [{ id: "q", at: now - 60_000, role: "user", kind: "text", text: "Still going" }],
};

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  setUsageMode("remaining");
  applySkin("precision");
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(bot: Bot, instances: InstanceInfo[]) {
  applyLocale("en");
  applySkin("precision");
  setUsageMode("remaining");
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class {
    close() {}
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let store: ReturnType<typeof useStore>;
  function Harness() {
    store = useStore();
    return createElement(ChatView, { bot });
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
  return host;
}

const meter = (host: HTMLElement, label: string) => host.querySelector(`[aria-label="${label}"]`);

describe("ChatView plan meters follow the shown pick", () => {
  it("hides ChatPlanMeters when a busy bot's pending pick reports no windows", async () => {
    const host = await render(
      { ...busy, pendingModelSelection: { instanceId: "gemini", model: "gemini-flash", effort: "high" } },
      [claude, gemini],
    );
    expect(meter(host, "5h: 29% remaining")).toBeNull();
    expect(host.querySelector('button[aria-label="Open Usage Settings"]')).toBeNull();
  });

  it("shows the pending instance's windows in ChatPlanMeters", async () => {
    const host = await render(
      { ...busy, pendingModelSelection: { instanceId: "muse", model: "muse-model", effort: "high" } },
      [claude, muse],
    );
    expect(meter(host, "5h: 90% remaining")).not.toBeNull();
    expect(meter(host, "7d: 60% remaining")).not.toBeNull();
    expect(meter(host, "5h: 29% remaining")).toBeNull();
    expect(host.textContent).toContain("Last seen 4d ago");
  });

  it("shows the running engine's bars in ChatPlanMeters when nothing is pending", async () => {
    const host = await render(busy, [claude, gemini]);
    expect(meter(host, "5h: 29% remaining")).not.toBeNull();
    expect(host.textContent).not.toContain("Last seen");
  });
});
