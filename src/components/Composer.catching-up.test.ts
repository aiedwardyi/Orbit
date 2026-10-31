// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { CATCHING_UP_POLL_MS } from "@/lib/use-catching-up";
import { StoreProvider, useStore, type Bot } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const subject: Bot = {
  id: "bot-scout", threadId: "thread-scout", name: "Scout", title: "", description: "",
  notifications: false, color: "blue", unread: false, messages: [], busy: false, activity: "idle",
  modelSelection: { instanceId: "steers", model: "m" },
};

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  applyLocale("en");
});

async function mount(answers: Array<boolean | null>) {
  const asked: string[] = [];
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url);
    if (path === "/api/bots?messages=200") return Response.json({ bots: [subject], groups: [], computerControl: {} });
    if (path === "/api/instances") return Response.json({ instances: [{ instanceId: "steers", capabilities: { queueing: true } }] });
    if (path === `/api/catching-up/${subject.threadId}`) {
      asked.push(path);
      return Response.json({ catchingUp: answers.length > 1 ? answers.shift()! : answers[0] });
    }
    return Response.json({ error: "not in this test" }, { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let hydrated = false;
  function Probe() {
    const { state } = useStore();
    hydrated = state.hydrated;
    return createElement(Composer, { bot: subject });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
  });
  await vi.waitFor(() => expect(hydrated).toBe(true));
  const line = () => host.querySelector("[data-catching-up]");
  const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(CATCHING_UP_POLL_MS); });
  return { asked, host, line, poll };
}

describe("composer catching-up line", () => {
  it("shows while the chat is behind, then hides by itself once caught up", async () => {
    const ui = await mount([null, true, true, false]);
    await vi.waitFor(() => expect(ui.asked).toHaveLength(1));
    expect(ui.line()).toBeNull();
    await ui.poll();
    await vi.waitFor(() => expect(ui.line()?.textContent).toBe("Catching up on messages…"));
    expect(ui.line()?.getAttribute("role")).toBe("status");
    expect(ui.host.querySelector("textarea")!.disabled).toBe(false);
    await ui.poll();
    expect(ui.line()).not.toBeNull();
    await ui.poll();
    await vi.waitFor(() => expect(ui.line()).toBeNull());
    const asked = ui.asked.length;
    await ui.poll();
    await ui.poll();
    expect(ui.asked).toHaveLength(asked);
  });

  it("reads in Korean", async () => {
    applyLocale("ko");
    const ui = await mount([true, false]);
    await vi.waitFor(() => expect(ui.line()?.textContent).toBe("메시지를 불러오는 중…"));
  });

  it("never shows when the PC is up to date, in folder mode or signed out", async () => {
    const ui = await mount([false]);
    await vi.waitFor(() => expect(ui.asked).toHaveLength(1));
    await ui.poll();
    await ui.poll();
    expect(ui.line()).toBeNull();
    expect(ui.asked).toHaveLength(1);
  });
});
