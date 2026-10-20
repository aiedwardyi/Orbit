// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { StoreProvider, useStore, type Bot, type Group } from "@/state/store";

import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() { FakeEventSource.last = this; }
}

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(room = false, steering = true, coarse = false, locale = "en") {
  localStorage.setItem("omb-locale", locale);
  const bot: Bot = {
    id: "helper", threadId: "thread-helper", name: "Helper", title: "", description: "",
    notifications: false, color: "blue", unread: false, busy: true, activity: "working",
    modelSelection: { instanceId: "inst", model: "m" }, messages: [],
  };
  const group: Group = {
    id: "room", threadId: "thread-room", name: "Room", memberIds: [bot.id],
    defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false,
    createdAt: 1, setupCompletedAt: 1, working: true, busyBotId: bot.id, messages: [],
  };
  const posts: Array<{ path: string; body: Record<string, string> }> = [];
  const deletes: string[] = [];
  let store: ReturnType<typeof useStore>;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: coarse && query === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/bots?messages=200") return Response.json({ bots: [bot], groups: [group], computerControl: {} });
    if (path === "/api/instances") return Response.json({ instances: [{
      instanceId: "inst", displayName: "Fake", driverKind: "fake", capabilities: { queueing: steering },
      snapshot: { state: "available", authenticated: true },
      models: { options: [{ id: "m", label: "Fake" }] },
    }] });
    if (init?.method === "DELETE") {
      deletes.push(path);
      return Response.json({ cancelled: true });
    }
    if (init?.method === "POST" && path.endsWith("/messages")) {
      const body = JSON.parse(String(init.body));
      posts.push({ path, body });
      if (body.deliver === "after") return Response.json({ queued: true, queueId: `queue-${posts.length}`, threadId: bot.threadId });
      return Response.json({ threadId: room ? group.threadId : bot.threadId, message: {
        id: `message-${posts.length}`, at: Date.now(), role: "user", kind: "text", text: body.text,
        sendId: body.sendId, queueId: body.queueId, steered: !room,
      } });
    }
    return Response.json({}, { status: 404 });
  }));
  function View() {
    store = useStore();
    return room
      ? createElement(GroupView, { group: store.state.groups[0] ?? group })
      : createElement(ChatView, { bot: store.state.bots[0] ?? bot });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(View)))));
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "q:1" }), lastEventId: "q:1" }));
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(store!.state.instances).toHaveLength(1);
  });
  const send = async (text: string, after = true) => {
    const box = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, ctrlKey: after, bubbles: true, cancelable: true,
    })));
  };
  const row = (text: string) => room
    ? [...host.querySelectorAll("span")].find((el) => el.textContent?.endsWith(`“${text}”`))!.parentElement!
    : [...host.querySelectorAll("[data-orbit-message='user']")].find((el) => el.textContent?.includes(text))!;
  const open = async (text: string) => {
    const el = row(text);
    expect(el).toBeTruthy();
    if (!coarse) {
      await act(async () => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })));
    } else {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const start = new Event("touchstart", { bubbles: true, cancelable: true });
      Object.defineProperty(start, "touches", { value: [{ clientX: 100, clientY: 100 }] });
      await act(async () => el.dispatchEvent(start));
      await act(async () => vi.advanceTimersByTime(500));
      const end = new Event("touchend", { bubbles: true, cancelable: true });
      Object.defineProperty(end, "touches", { value: [] });
      await act(async () => el.dispatchEvent(end));
      vi.useRealTimers();
    }
    expect(document.querySelector("[data-message-menu]")).not.toBeNull();
  };
  const click = (selector: string) => act(async () => document.querySelector<HTMLButtonElement>(selector)!.click());
  const emit = (frame: object) => act(async () => {
    FakeEventSource.last.onmessage!({ data: JSON.stringify(frame), lastEventId: "q:9" });
  });
  // Reply actually running: dispatch announced the turn, then startTurn claimed it.
  const running = async () => {
    await emit({ kind: "turn.dispatch", threadId: "thread-helper", createdAt: "2026-01-01T00:00:00.000Z" });
    await emit({ kind: "runtime", event: {
      type: "turn.started", threadId: "thread-helper", turnId: "turn1", createdAt: new Date().toISOString(),
    } });
  };
  const idle = () => act(async () => {
    if (room) store!.dispatch({ type: "groupPatched", group: { id: group.id, working: false, busyBotId: undefined } });
    else store!.dispatch({ type: "botPatched", bot: { ...bot, busy: false, activity: "idle" } });
  });
  return { host, posts, deletes, send, open, click, idle, emit, running, store: () => store! };
}

describe("queued message menu", () => {
  it.each([
    [false, true, false], [false, true, true], [false, false, false],
    [false, false, true], [true, true, false], [true, true, true],
  ])("offers Enter's choices: room=%s steering=%s touch=%s", async (room, steering, touch) => {
    const ui = await mount(room, steering, touch);
    await ui.send("held");
    if (!room) await ui.running();
    await ui.open("held");
    const labels = [...document.querySelectorAll("[data-message-menu] button")].map((el) => el.textContent);
    expect(labels).toEqual(!room && steering ? ["Send now", "Cancel"] : ["Cancel"]);
  });

  it.each([false, true])("translates the queued menu, room=%s", async (room) => {
    const ui = await mount(room, true, false, "ko");
    await ui.send("held");
    if (!room) await ui.running();
    await ui.open("held");
    expect([...document.querySelectorAll("[data-message-menu] button")].map((el) => el.textContent))
      .toEqual(room ? ["취소"] : ["지금 보내기", "취소"]);
  });

  it("hides Send now while the turn still prepares, shows it once the reply runs", async () => {
    const ui = await mount();
    await ui.send("held");
    await ui.open("held");
    expect([...document.querySelectorAll("[data-message-menu] button")].map((el) => el.textContent))
      .toEqual(["Send now", "Cancel"]);
    await ui.emit({ kind: "turn.dispatch", threadId: "thread-helper", createdAt: "2026-01-01T00:00:00.000Z" });
    await ui.open("held");
    expect([...document.querySelectorAll("[data-message-menu] button")].map((el) => el.textContent))
      .toEqual(["Cancel"]);
    await ui.emit({ kind: "runtime", event: {
      type: "turn.started", threadId: "thread-helper", turnId: "turn1", createdAt: new Date().toISOString(),
    } });
    await ui.open("held");
    expect([...document.querySelectorAll("[data-message-menu] button")].map((el) => el.textContent))
      .toEqual(["Send now", "Cancel"]);
  });

  it("promotes through Enter's POST with the original send identity", async () => {
    const ui = await mount();
    await ui.send("Enter path", false);
    await ui.send("held");
    await ui.running();
    const queued = ui.posts[1]!;
    await ui.open("held");
    await ui.click("[data-menu-send-now]");
    expect(ui.posts[2]).toEqual({ path: ui.posts[0]!.path, body: {
      text: "held", threadId: "thread-helper", sendId: queued.body.sendId, queueId: "queue-2",
    } });
    expect(ui.deletes).toEqual([]);
    expect(ui.store().state.pendingQueued["thread-helper"] ?? []).toEqual([]);
  });

  it("keeps one bubble while the promotion POST is pending", async () => {
    const ui = await mount();
    await ui.send("held");
    await ui.running();
    const served = globalThis.fetch;
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).queueId) {
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return served(url, init);
    }));
    await ui.open("held");
    await ui.click("[data-menu-send-now]");
    expect(ui.host.querySelectorAll("[data-orbit-message='user']")).toHaveLength(1);
    await act(async () => finish(Response.json({ queued: true, queueId: "queue-1", threadId: "thread-helper" })));
    expect(ui.host.querySelectorAll("[data-orbit-message='user']")).toHaveLength(1);
  });

  it.each([false, true])("cancels only the selected hold without sending, room=%s", async (room) => {
    const ui = await mount(room);
    await ui.send("first");
    await ui.send("second");
    await ui.send("third");
    await ui.open("second");
    await ui.click("[data-menu-cancel-queued]");
    expect(ui.posts).toHaveLength(room ? 0 : 3);
    expect(ui.host.textContent).not.toContain("second");
    expect(ui.host.textContent!.indexOf("first")).toBeLessThan(ui.host.textContent!.indexOf("third"));
    expect(ui.deletes).toEqual(room ? [] : ["/api/bots/helper/queue/queue-2"]);
    if (room) {
      await act(async () => ui.host.querySelector<HTMLButtonElement>("button[aria-label='Cancel queued message']")!.click());
      expect(ui.host.textContent).not.toContain("first");
      expect(ui.host.textContent).toContain("third");
    }
  });

  it("sends once when the queued line drains while its menu is open", async () => {
    const ui = await mount();
    await ui.send("held");
    await ui.running();
    const sendId = ui.posts[0]!.body.sendId;
    await ui.open("held");
    await act(async () => {
      ui.store().dispatch({ type: "messageAdded", threadId: "thread-helper", message: {
        id: "drained", at: Date.now(), role: "user", kind: "text", text: "held", sendId, queueId: "queue-1",
      } });
      ui.store().dispatch({ type: "consumePendingQueued", threadId: "thread-helper", queueId: "queue-1" });
    });
    await ui.idle();
    await ui.click("[data-menu-send-now]");
    expect(ui.posts).toHaveLength(1);
    expect(ui.host.querySelectorAll("[data-orbit-message='user']")).toHaveLength(1);
  });

  it("does not cancel the next group hold after the open hold flushes", async () => {
    const ui = await mount(true);
    await ui.send("first");
    await ui.send("second");
    await ui.open("first");
    await ui.idle();
    expect(ui.posts).toHaveLength(1);
    await ui.click("[data-menu-cancel-queued]");
    expect(ui.host.textContent).toContain("second");
    expect(ui.posts).toHaveLength(1);
  });
});
