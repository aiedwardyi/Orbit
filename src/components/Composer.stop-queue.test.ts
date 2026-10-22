// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pasteAttachment } from "@/lib/composer-attachments";
import { getDraftAttachments, getRoomHolds, setDraftAttachments } from "@/lib/drafts";
import { StoreProvider, useStore, type Bot, type Group } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const bot: Bot = {
  id: "bot-q", threadId: "thread-q", name: "Scout", title: "", description: "",
  notifications: false, color: "blue", unread: false, messages: [], busy: true, activity: "working",
  modelSelection: { instanceId: "waits", model: "m" },
};
const room: Group = {
  id: "room-q", threadId: "room-thread-q", name: "Room", memberIds: [bot.id], bulletin: "",
  defaultResponder: { kind: "everyone" }, unread: false, createdAt: 1, messages: [],
  working: true, busyBotId: bot.id,
};

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(target: { bot?: Bot; group?: Group }) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/bots?messages=200") {
      return Response.json({ bots: [bot], groups: target.group ? [target.group] : [], computerControl: {} });
    }
    if (path === "/api/instances") return Response.json({ instances: [{ instanceId: "waits", capabilities: {} }] });
    if (init?.method !== "POST") return Response.json({ error: "not in this test" }, { status: 404 });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    posts.push({ path, body });
    if (path === `/api/bots/${bot.id}/messages`) {
      return Response.json({ ok: true, queued: true, queueId: `q-${body.text}`, threadId: bot.threadId }, { status: 202 });
    }
    if (path === `/api/bots/${bot.id}/interrupt`) {
      const sent = posts.filter((post) => post.path.endsWith("/messages")).map((post) => post.body);
      return Response.json({
        ok: true,
        returned: sent.map((send) => ({ threadId: bot.threadId, queueId: `q-${send.text}`, sendId: send.sendId, text: send.text })),
      });
    }
    return Response.json({ ok: true });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let store!: ReturnType<typeof useStore>;
  function Probe() {
    store = useStore();
    return createElement(Composer, target.group ? { group: target.group, members: [bot] } : { bot });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
  });
  await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
  await vi.waitFor(() => expect(store.state.instances).toHaveLength(1));
  const box = host.querySelector("textarea")!;
  const send = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })));
  };
  const stop = () => act(async () => host.querySelector<HTMLElement>('button[aria-label="Stop this turn"]')!.click());
  return { box, host, posts, send, stop, store: () => store };
}

describe("stop with queued sends", () => {
  it("hands queued 1:1 sends back to the composer in order, chips included", async () => {
    const pasted = pasteAttachment("long log");
    setDraftAttachments(localStorage, `bot:${bot.id}:${bot.threadId}`, [pasted]);
    const ui = await mount({ bot });
    await ui.send("first");
    await ui.send("second");
    await vi.waitFor(() => expect(ui.store().state.pendingQueued[bot.threadId]).toHaveLength(2), { timeout: 5000 });
    await ui.stop();
    await vi.waitFor(() => expect(ui.box.value).toBe("first\n\nsecond"), { timeout: 5000 });
    expect(ui.store().state.pendingQueued[bot.threadId]).toBeUndefined();
    expect(getDraftAttachments(localStorage, `bot:${bot.id}:${bot.threadId}`)).toEqual([pasted]);
    expect(ui.posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(2);
  });

  it("hands held room lines back instead of flushing them when the room settles", async () => {
    const ui = await mount({ group: room });
    await ui.send("held one");
    await ui.send("held two");
    expect(getRoomHolds(localStorage, `group:${room.id}:${room.threadId}`)).toHaveLength(2);
    await ui.stop();
    expect(ui.box.value).toBe("held one\n\nheld two");
    expect(getRoomHolds(localStorage, `group:${room.id}:${room.threadId}`)).toEqual([]);
    await act(async () => ui.store().dispatch({ type: "groupPatched", group: { ...room, working: false, busyBotId: null } }));
    expect(ui.posts.map((post) => post.path)).toEqual([`/api/groups/${room.id}/interrupt`]);
  });
});
