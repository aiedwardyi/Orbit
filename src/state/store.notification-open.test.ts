// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startColdOpenTiming } from "../lib/cold-open-timing";
import { webPushTarget } from "../lib/web-push";
import { SNAPSHOT_CACHE_KEY } from "./snapshot-cache";
import { openNotificationTarget, StoreProvider, useStore, type Action, type AppState } from "./store";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.current = this;
  }
}

const bot = (threadId: string) => ({
  id: "b1",
  name: "b1",
  threadId,
  messages: [],
  tasks: [{ threadId: "t-new" }, { threadId: "t-old" }],
});
const group = (threadId: string) => ({
  id: "g1",
  name: "g1",
  threadId,
  memberIds: ["b1"],
  messages: [],
  tasks: [{ threadId: "g-new" }, { threadId: "g-old" }],
});

const other = { ...bot("t-other"), id: "b2", name: "b2" };

type Snapshot = { bots: Array<ReturnType<typeof bot>>; groups: Array<ReturnType<typeof group>> };
type Reply = Snapshot | { bot?: ReturnType<typeof bot> } | { group?: ReturnType<typeof group> } | { error: string };

const respond = (body: Reply, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function mount(cached: Snapshot, fresh: Snapshot, selectedId = "") {
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ ...cached, selectedId }));
  const switches: string[] = [];
  let hydrate: (() => void) | null = null;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
    if (path === "/api/bots?messages=200") return new Promise<Response>((resolve) => (hydrate = () => resolve(respond(fresh))));
    if (init.method === "POST" && /\/tasks\//.test(path)) {
      switches.push(path);
      return respond(path.startsWith("/api/groups/") ? { group: fresh.groups[0] } : { bot: fresh.bots[0] });
    }
    return respond({ error: "not in this test" }, 404);
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let store: { state: AppState; dispatch: (action: Action) => void } | null = null;
  const Probe = () => {
    store = useStore();
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  return {
    state: () => store!.state,
    open: (target: { botId: string; threadId: string }) =>
      act(async () => openNotificationTarget(store!.dispatch, target, store!.state)),
    select: (id: string) => act(async () => store!.dispatch({ type: "select", id })),
    hydrate: async () => {
      await act(async () => FakeEventSource.current!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }), lastEventId: "" }));
      await vi.waitFor(() => expect(hydrate).not.toBeNull());
      await act(async () => hydrate!());
      await vi.waitFor(() => expect(store!.state.hydrated).toBe(true));
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    },
    switches,
    unmount: () => act(async () => root.unmount()),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  FakeEventSource.current = null;
});

describe("opening a notification on a cold page", () => {
  const current = { bots: [bot("t-new")], groups: [group("g-new")] };
  const stale = { bots: [bot("t-old")], groups: [group("g-old")] };

  it.each([
    { name: "bot", target: { botId: "b1", threadId: "t-new" }, selected: "b1" },
    { name: "room", target: { botId: "b1", threadId: "g-new" }, selected: "g1" },
  ])("skips the transcript switch when fresh state shows the $name's thread is active", async ({ target, selected }) => {
    const store = await mount(stale, current);
    await store.open(target);
    expect(store.state().selectedId).toBe(selected);
    await store.hydrate();
    expect(store.switches).toEqual([]);
    await store.unmount();
  });

  it.each([
    { name: "bot", target: { botId: "b1", threadId: "t-new" }, selected: "b1", fresh: { bots: [bot("t-old")], groups: [group("g-new")] }, path: "/api/bots/b1/tasks/t-new" },
    { name: "room", target: { botId: "b1", threadId: "g-new" }, selected: "g1", fresh: { bots: [bot("t-new")], groups: [group("g-old")] }, path: "/api/groups/g1/tasks/g-new" },
  ])("switches after hydrate when the $name's active thread moved while closed", async ({ target, selected, fresh, path }) => {
    const store = await mount(current, fresh);
    await store.open(target);
    expect(store.state().selectedId).toBe(selected);
    expect(store.switches).toEqual([]);
    await store.hydrate();
    expect(store.switches).toEqual([path]);
    await store.unmount();
  });

  it("selects and switches to a bot the cached snapshot lacks", async () => {
    const store = await mount({ bots: [other], groups: [] }, { bots: [bot("t-old"), other], groups: [] }, "b2");
    await store.open({ botId: "b1", threadId: "t-new" });
    expect(store.state().selectedId).toBe("b2");
    await store.hydrate();
    expect(store.state().selectedId).toBe("b1");
    expect(store.switches).toEqual(["/api/bots/b1/tasks/t-new"]);
    await store.unmount();
  });

  it("selects the room after hydrate when the cache only knows the asker bot", async () => {
    const store = await mount({ bots: [bot("t-new")], groups: [] }, { bots: [bot("t-new")], groups: [group("g-old")] });
    await store.open({ botId: "b1", threadId: "g-new" });
    expect(store.state().selectedId).toBe("b1");
    await store.hydrate();
    expect(store.state().selectedId).toBe("g1");
    expect(store.switches).toEqual(["/api/groups/g1/tasks/g-new"]);
    await store.unmount();
  });

  it("strips the tap time from the address and still opens the notification's thread", async () => {
    window.history.replaceState(null, "", "/?bot=b1&thread=t-new&t0=1800000000000");
    startColdOpenTiming();
    expect(window.location.pathname + window.location.search).toBe("/?bot=b1&thread=t-new");
    const target = webPushTarget(window.location.search);
    expect(target).toEqual({ botId: "b1", threadId: "t-new" });
    const store = await mount(current, { bots: [bot("t-old")], groups: [group("g-new")] });
    await store.open(target!);
    expect(store.state().selectedId).toBe("b1");
    await store.hydrate();
    expect(store.switches).toEqual(["/api/bots/b1/tasks/t-new"]);
    await store.unmount();
    window.history.replaceState(null, "", "/");
  });

  it("drops the target when another chat is picked before hydrate", async () => {
    const store = await mount({ bots: [bot("t-new"), other], groups: [] }, { bots: [bot("t-new"), other], groups: [] });
    await store.open({ botId: "b1", threadId: "t-old" });
    await store.select("b2");
    await store.hydrate();
    expect(store.state().selectedId).toBe("b2");
    expect(store.switches).toEqual([]);
    await store.unmount();
  });
});
