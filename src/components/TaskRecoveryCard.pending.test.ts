// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { StoreProvider, useStore, type Bot, type TaskResumePacket } from "@/state/store";

import { TaskRecoveryCard } from "./TaskRecoveryCard";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const bot = {
  id: "b1", threadId: "t1", name: "Bot", busy: false, unread: false, messages: [],
  modelSelection: { instanceId: "inst", model: "m" },
} as unknown as Bot;
const packet: TaskResumePacket = {
  v: 1, botId: bot.id, threadId: bot.threadId, goal: "Finish the brief", nextAction: "Check citations",
  plan: [], completed: [], evidence: [], artifacts: [], blockers: [],
  flushReason: "stop", updatedAt: 1, updatedBy: "harness", turnsAtWrite: 0,
};
let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  applyLocale("en");
});

async function frame(value: Record<string, unknown>) {
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify(value), lastEventId: "" });
  });
}

async function mount(post: () => Promise<Response> = async () => Response.json({ ok: true, pending: true }, { status: 202 })) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetch = vi.fn(async (url: string) => {
    if (String(url).endsWith("/resume")) return post();
    if (String(url) === "/api/bots?messages=200") return Response.json({ bots: [bot], groups: [], computerControl: {} });
    if (String(url) === "/api/instances") return Response.json({ instances: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  function Probe() {
    const { state } = useStore();
    return createElement(TaskRecoveryCard, { bot: state.bots[0] ?? bot, packet, turns: 0 });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await frame({ kind: "hello", resumed: false, cursor: "c1" });
  return {
    host,
    click: () => act(async () => host.querySelector("button")!.click()),
    resumeCalls: () => fetch.mock.calls.filter(([url]) => String(url).endsWith("/resume")).length,
  };
}

describe("held task resume card", () => {
  it.each(["en", "ko"] as const)("keeps %s pending copy until the resumed turn starts", async (locale) => {
    applyLocale(locale);
    const f = await mount();
    await f.click();
    expect(f.host.textContent).toContain(locale === "en" ? "Resuming" : "재개 중");
    expect(f.host.querySelector("button")!.disabled).toBe(true);
    expect(f.host.querySelector(".text-danger")).toBeNull();
    await f.click();
    expect(f.resumeCalls()).toBe(1);
    await frame({ kind: "bot", bot: { ...bot, busy: true, activity: "working" } });
    expect(f.host.querySelector('[role="status"]')).toBeNull();
  });

  it("shows a deferred real failure beside Resume and permits retry", async () => {
    const post = vi.fn(async () => Response.json({ ok: true, pending: true }, { status: 202 }));
    const f = await mount(post);
    await f.click();
    expect(f.host.querySelector("button")!.disabled).toBe(true);
    await frame({ kind: "task.resume", botId: bot.id, threadId: bot.threadId, error: "model unavailable" });
    expect(f.host.querySelector(".text-danger")!.textContent).toBe("model unavailable");
    expect(f.host.querySelector("button")!.disabled).toBe(false);
    post.mockImplementation(async () => Response.json({ error: "task no longer exists" }, { status: 404 }));
    await f.click();
    expect(f.host.querySelector(".text-danger")!.textContent).toBe("task no longer exists");
    expect(f.host.querySelector("button")!.disabled).toBe(false);
  });

  it("frees a held state when a snapshot replaces the event stream", async () => {
    const f = await mount();
    await f.click();
    expect(f.host.querySelector("button")!.disabled).toBe(true);
    await frame({ kind: "hello", resumed: false, cursor: "c2" });
    expect(f.host.querySelector("button")!.disabled).toBe(false);
    expect(f.host.querySelector(".text-danger")).toBeNull();
  });

  it("clears a held state on Stop and ignores a late pending receipt after failure", async () => {
    let receipt!: (response: Response) => void;
    const post = vi.fn(async () => Response.json({ ok: true, pending: true }, { status: 202 }));
    const f = await mount(post);
    await f.click();
    expect(f.host.querySelector("button")!.disabled).toBe(true);
    await frame({ kind: "task.resume", botId: bot.id, threadId: bot.threadId, error: null });
    expect(f.host.querySelector("button")!.disabled).toBe(false);
    post.mockImplementation(() => new Promise((resolve) => { receipt = resolve; }));
    await f.click();
    await frame({ kind: "task.resume", botId: bot.id, threadId: bot.threadId, error: "model unavailable" });
    await act(async () => receipt(Response.json({ ok: true, pending: true }, { status: 202 })));
    expect(f.host.querySelector("button")!.disabled).toBe(false);
    expect(f.host.querySelector(".text-danger")!.textContent).toBe("model unavailable");
  });
});
