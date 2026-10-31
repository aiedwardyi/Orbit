import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
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
});

async function render(current = bot, instance = engine, cwd?: string | null, instances = [instance]) {
  applyLocale("en");
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class {
    close() {}
  });
  let store: ReturnType<typeof useStore>;
  function Harness() {
    store = useStore();
    return createElement(TermStatusLine, { bot: current, engine: instance, cwd });
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

describe("TermStatusLine", () => {
  it("mutes and describes a stale Muse reading with its age", async () => {
    const host = await render(bot, { ...engine, driverKind: "museAgent", rateLimits: { ...engine.rateLimits!, observedAt: new Date(now - 4 * 86400_000).toISOString() } });
    const button = host.querySelector("button")!;
    expect(button.textContent).toContain("Last seen 4d ago");
    expect(button.textContent).toMatch(/^Last seen 4d ago · 5h/);
    expect(button.className).toContain("text-ink-secondary");
    const age = button.getAttribute("aria-describedby");
    expect(age).toBeTruthy();
    expect(host.querySelector('[id="' + age + '"]')?.textContent).toBe("Last seen 4d ago");
    expect(button.getAttribute("aria-label")).toBe("Open Usage Settings");
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
