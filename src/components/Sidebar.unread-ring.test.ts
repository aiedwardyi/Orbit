// @vitest-environment happy-dom
// An unread chat that is not asking wears a steady accent ring instead of a
// dot; a live reply to a closed chat glows once, then rests on the ring.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetArrivalGlow } from "@/lib/arrival-glow";
import { SIDEBAR_COLLAPSED_KEY, SIDEBAR_COLLAPSED_SECTIONS_KEY } from "@/lib/sidebar-preferences";
import { StoreProvider, useStore } from "@/state/store";

import App from "../App";
import { Sidebar } from "./Sidebar";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

const bot = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `${id}-thread`,
  name: id,
  messages: [],
  ...extra,
});
const room = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `${id}-thread`,
  name: id,
  memberIds: ["open"],
  messages: [],
  ...extra,
});
const askCard = (id: string) => ({
  id,
  role: "bot",
  kind: "options",
  at: 10,
  card: { title: "Your bot has a question", subtitle: "Prod or staging?", options: ["Prod", "Staging"], askUser: true },
});

let storeDispatch: ReturnType<typeof useStore>["dispatch"] | null = null;
function SidebarWithDispatch() {
  storeDispatch = useStore().dispatch;
  return createElement(Sidebar, { open: false, onClose: () => {} });
}

afterEach(() => {
  resetArrivalGlow();
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_SECTIONS_KEY);
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
  window.localStorage.removeItem("omb-onboarding-done");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountSidebar(payload: { bots: unknown[]; groups: unknown[] }) {
  storeDispatch = null;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string) =>
    path === "/api/bots?messages=200"
      ? new Response(JSON.stringify(payload))
      : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(StoreProvider, null, createElement(SidebarWithDispatch))),
  );
  await act(async () => FakeEventSource.current!.onmessage?.({
    data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
    lastEventId: "",
  }));
  return {
    host,
    dispatch: () => storeDispatch!,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const rowControl = (host: HTMLElement, id: string) => {
  const row = host.querySelector(`[data-sidebar-row-id="${id}"]`);
  return { row, control: row?.querySelector('[role="button"], button') ?? null };
};

const sendFrame = (frame: unknown, lastEventId = "") =>
  act(async () => FakeEventSource.current!.onmessage?.({ data: JSON.stringify(frame), lastEventId }));

const replyFrame = (threadId: string, message: unknown) => ({ kind: "message", threadId, message });
const botText = (id: string, at: number) => ({ id, role: "bot", kind: "text", text: `reply ${id}`, at });
const endGlow = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new Event("animationend", { bubbles: true }));
  });

// Drives matchMedia width queries: desktop until setPhone(true), then phone.
const stubViewportWidth = () => {
  let phone = false;
  const listeners = new Set<() => void>();
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("max-width") ? phone : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (...args: any[]) => {
      listeners.add(args[1] as () => void);
    },
    removeEventListener: (...args: any[]) => {
      listeners.delete(args[1] as () => void);
    },
    dispatchEvent: () => false,
  }));
  return {
    setPhone: async (value: boolean) => {
      phone = value;
      await act(async () => {
        listeners.forEach((notify) => notify());
      });
    },
  };
};

async function mountApp(bots: unknown[]) {
  window.localStorage.setItem("omb-onboarding-done", "true");
  const engine = {
    instanceId: "muse",
    driverKind: "museAgent",
    displayName: "Meta Muse",
    snapshot: { state: "available" },
    models: { default: "muse-spark", options: [{ id: "muse-spark", label: "Meta Muse" }] },
  };
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path === "/api/bots?messages=200") {
      return new Response(JSON.stringify({ bots, groups: [] }));
    }
    if (path === "/api/instances") return new Response(JSON.stringify({ instances: [engine] }));
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  await act(async () => FakeEventSource.current!.onmessage?.({
    data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
    lastEventId: "",
  }));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("Sidebar unread ring", () => {
  it("rings an unread bot row and drops the dot", async () => {
    const { host, unmount } = await mountSidebar({ bots: [bot("open"), bot("closed", { unread: true })], groups: [] });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      const { row, control } = rowControl(host, "closed");
      expect(row?.hasAttribute("data-sidebar-chat-unread")).toBe(true);
      expect(control?.className).toContain("unread-ring");
      expect(row?.querySelector("span.bg-accent")).toBeNull();
      const open = rowControl(host, "open");
      expect(open.row?.hasAttribute("data-sidebar-chat-unread")).toBe(false);
      expect(open.control?.className).not.toContain("unread-ring");
    } finally {
      await unmount();
    }
  });

  it("rings normal, compact, and icon-only bot rows", async () => {
    const { host, unmount } = await mountSidebar({
      bots: [bot("open"), bot("pinned", { pinned: true, unread: true }), bot("plain", { unread: true })],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="plain"]')).not.toBeNull());
      const normal = rowControl(host, "pinned").control;
      const compact = rowControl(host, "plain").control;
      expect(normal?.className).toContain("pr-12");
      expect(compact?.className).toContain("pr-10");
      expect(normal?.className).toContain("unread-ring");
      expect(compact?.className).toContain("unread-ring");
    } finally {
      await unmount();
    }
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    const icons = await mountSidebar({ bots: [bot("open"), bot("closed", { unread: true })], groups: [] });
    try {
      await vi.waitFor(() => expect(icons.host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      const control = rowControl(icons.host, "closed").control;
      expect(control?.className).toContain("justify-center");
      expect(control?.className).toContain("unread-ring");
      expect(rowControl(icons.host, "closed").row?.querySelector("span.bg-accent")).toBeNull();
    } finally {
      await icons.unmount();
    }
  });

  it("rings unread room rows and drops both dots", async () => {
    const { host, unmount } = await mountSidebar({
      bots: [bot("open")],
      groups: [room("room", { unread: true })],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="room"]')).not.toBeNull());
      const { row, control } = rowControl(host, "room");
      expect(row?.hasAttribute("data-sidebar-chat-unread")).toBe(true);
      expect(control?.className).toContain("unread-ring");
      expect(row?.querySelector("span.bg-accent")).toBeNull();
    } finally {
      await unmount();
    }
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    const icons = await mountSidebar({ bots: [bot("open")], groups: [room("room", { unread: true })] });
    try {
      await vi.waitFor(() => expect(icons.host.querySelector('[data-sidebar-row-id="room"]')).not.toBeNull());
      const { row, control } = rowControl(icons.host, "room");
      expect(control?.className).toContain("unread-ring");
      expect(row?.querySelector("span.bg-accent")).toBeNull();
    } finally {
      await icons.unmount();
    }
  });

  it("shows only needs-you on an asking row, with or without unread", async () => {
    const { host, unmount } = await mountSidebar({
      bots: [
        bot("open"),
        bot("asker", { unread: true, messages: [askCard("ask-1")] }),
        bot("asker-read", { messages: [askCard("ask-2")] }),
      ],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="asker"]')).not.toBeNull());
      for (const id of ["asker", "asker-read"]) {
        const { control } = rowControl(host, id);
        expect(control?.className).toContain("needs-you-glow");
        expect(control?.className).not.toContain("unread-ring");
        expect(control?.className).not.toContain("arrival-glow");
      }
      expect(rowControl(host, "asker").row?.hasAttribute("data-sidebar-chat-unread")).toBe(true);
    } finally {
      await unmount();
    }
  });

  it("is box shadows on a pseudo-element only, with no sizing or filter side effects", () => {
    const ring = css.match(/\.unread-ring::after \{(.*?)\}/s)?.[1] ?? "";
    expect(ring).toContain("box-shadow");
    expect(ring).toContain("1.5px");
    expect(ring).toContain("92%");
    expect(ring).not.toContain("14px");
    expect(ring).not.toContain("animation");
    expect(css.match(/\.unread-ring \{(.*?)\}/s)?.[1] ?? "").not.toContain("box-shadow");
    const rule = css.match(/\.unread-ring \{(.*?)\}/s)?.[1] ?? "";
    expect(rule).not.toContain("filter");
    expect(rule).not.toContain("opacity");
    expect(rule).not.toContain("border");
  });
});

describe("Sidebar arrival glow", () => {
  it("glows once when a reply lands in a closed chat, then rests on the ring", async () => {
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open"), bot("closed", { unread: true })],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
      await sendFrame(replyFrame("closed-thread", botText("live-1", 11)));
      const { control } = rowControl(host, "closed");
      expect(control?.hasAttribute("data-arrival-glow")).toBe(true);
      expect(control?.className).toContain("arrival-glow");
      expect(rowControl(host, "open").control?.hasAttribute("data-arrival-glow")).toBe(false);
      await endGlow(control!);
      expect(control?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(control?.className).not.toContain("arrival-glow");
      expect(control?.className).toContain("unread-ring");
    } finally {
      await unmount();
    }
  });

  it("glows a room row when its reply lands", async () => {
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open")],
      groups: [room("room", { unread: true })],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="room"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      await sendFrame(replyFrame("room-thread", botText("live-r1", 11)));
      const { control } = rowControl(host, "room");
      expect(control?.hasAttribute("data-arrival-glow")).toBe(true);
      await endGlow(control!);
      expect(control?.className).toContain("unread-ring");
    } finally {
      await unmount();
    }
  });

  it("stops a bot row glow at once when its chat opens, without replaying", async () => {
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open"), bot("closed", { unread: true })],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      await sendFrame(replyFrame("closed-thread", botText("live-1", 11)));
      expect(rowControl(host, "closed").control?.hasAttribute("data-arrival-glow")).toBe(true);
      await act(async () => dispatch()({ type: "select", id: "closed" }));
      expect(rowControl(host, "closed").control?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
      await act(async () => dispatch()({ type: "select", id: "open" }));
      expect(rowControl(host, "closed").control?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("stops a room row glow at once when its chat opens, without replaying", async () => {
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open")],
      groups: [room("room", { unread: true })],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="room"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      await sendFrame(replyFrame("room-thread", botText("live-r1", 11)));
      expect(rowControl(host, "room").control?.hasAttribute("data-arrival-glow")).toBe(true);
      await act(async () => dispatch()({ type: "select", id: "room" }));
      expect(rowControl(host, "room").control?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
      await act(async () => dispatch()({ type: "select", id: "open" }));
      expect(rowControl(host, "room").control?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("glows again for a second reply 20 s later", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open"), bot("closed", { unread: true })],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      await sendFrame(replyFrame("closed-thread", botText("live-1", 11)));
      const { control } = rowControl(host, "closed");
      expect(control?.hasAttribute("data-arrival-glow")).toBe(true);
      await endGlow(control!);
      now += 20_000;
      await sendFrame(replyFrame("closed-thread", botText("live-2", 12)));
      expect(rowControl(host, "closed").control?.hasAttribute("data-arrival-glow")).toBe(true);
    } finally {
      await unmount();
    }
  });

  it("glows once for 3 replies inside 10 s", async () => {
    let now = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open"), bot("closed", { unread: true })],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      await sendFrame(replyFrame("closed-thread", botText("live-1", 11)));
      const { control } = rowControl(host, "closed");
      expect(control?.hasAttribute("data-arrival-glow")).toBe(true);
      await endGlow(control!);
      now += 5_000;
      await sendFrame(replyFrame("closed-thread", botText("live-2", 12)));
      now += 4_000;
      await sendFrame(replyFrame("closed-thread", botText("live-3", 13)));
      expect(rowControl(host, "closed").control?.hasAttribute("data-arrival-glow")).toBe(false);
      now += 1_000;
      await sendFrame(replyFrame("closed-thread", botText("live-4", 14)));
      expect(rowControl(host, "closed").control?.hasAttribute("data-arrival-glow")).toBe(true);
    } finally {
      await unmount();
    }
  });

  it("glows two chats that reply together", async () => {
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open"), bot("b", { unread: true }), bot("c", { unread: true })],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="c"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      await sendFrame(replyFrame("b-thread", botText("live-b", 11)));
      await sendFrame(replyFrame("c-thread", botText("live-c", 11)));
      expect(rowControl(host, "b").control?.hasAttribute("data-arrival-glow")).toBe(true);
      expect(rowControl(host, "c").control?.hasAttribute("data-arrival-glow")).toBe(true);
    } finally {
      await unmount();
    }
  });

  it("never glows on hydration, bot switch, own send, open chat, Mark as Unread, or ask card", async () => {
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [
        bot("open", { messages: [{ id: "m1", role: "bot", kind: "text", text: "hi", at: 1 }] }),
        bot("closed", { unread: true, messages: [{ id: "m2", role: "bot", kind: "text", text: "hi", at: 1 }] }),
      ],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
      await act(async () => dispatch()({ type: "select", id: "closed" }));
      await act(async () => dispatch()({ type: "select", id: "open" }));
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
      await sendFrame(replyFrame("closed-thread", { id: "own-1", role: "user", kind: "text", text: "me", at: 21 }));
      await sendFrame(replyFrame("open-thread", botText("live-open", 22)));
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
      await act(async () => dispatch()({ type: "markUnread", botId: "closed" }));
      expect(rowControl(host, "closed").control?.className).toContain("unread-ring");
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
      await sendFrame(replyFrame("closed-thread", askCard("ask-live")));
      const { control } = rowControl(host, "closed");
      expect(control?.className).toContain("needs-you-glow");
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("never glows on replayed frames, tool rows, or synced-in history", async () => {
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [
        bot("open"),
        bot("closed", { unread: true, messages: [{ id: "m2", role: "bot", kind: "text", text: "hi", at: 1 }] }),
      ],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: true, cursor: "s:9" }),
        lastEventId: "",
      }));
      await sendFrame(replyFrame("closed-thread", botText("replay-1", 31)), "s:5");
      await sendFrame(replyFrame("closed-thread", {
        id: "tool-1",
        role: "bot",
        kind: "activity",
        tool: { name: "Bash", ok: true },
        at: 32,
      }));
      await act(async () =>
        dispatch()({
          type: "olderMessages",
          threadId: "closed-thread",
          before: "m2",
          messages: [{ id: "m0", role: "bot", kind: "text", text: "old", at: 0 }],
          hasMore: false,
        }),
      );
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("glows once when a routine card patches to completed, not on hydration", async () => {
    const card = (status: string) => ({
      id: "run-card",
      role: "bot",
      kind: "routine.run",
      text: "Routine",
      at: 5,
      routineRun: { runId: "run-1", routineId: "routine-1", routineName: "Tool to try", status },
    });
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open"), bot("closed", { unread: true, messages: [card("running")] })],
      groups: [room("room", { messages: [{ ...card("completed"), id: "room-card", routineRun: { ...card("completed").routineRun, runId: "run-2" } }] })],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
      await sendFrame({ kind: "message.patch", threadId: "closed-thread", message: card("completed") });
      const { control } = rowControl(host, "closed");
      expect(control?.hasAttribute("data-arrival-glow")).toBe(true);
      await endGlow(control!);
      expect(control?.hasAttribute("data-arrival-glow")).toBe(false);
      await sendFrame({ kind: "message.patch", threadId: "closed-thread", message: { ...card("failed"), at: 40 } });
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
      await sendFrame({ kind: "message.patch", threadId: "room-thread", message: { ...card("completed"), id: "room-card", routineRun: { ...card("completed").routineRun, runId: "run-2" } } });
      expect(host.querySelector("[data-arrival-glow]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("drops the glow for needs-you when an ask card lands mid-glow", async () => {
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open"), bot("closed", { unread: true })],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      await sendFrame(replyFrame("closed-thread", botText("live-1", 11)));
      expect(rowControl(host, "closed").control?.hasAttribute("data-arrival-glow")).toBe(true);
      await sendFrame(replyFrame("closed-thread", askCard("ask-live")));
      const { control } = rowControl(host, "closed");
      expect(control?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(control?.className).toContain("needs-you-glow");
      expect(control?.className).not.toContain("unread-ring");
    } finally {
      await unmount();
    }
  });

  it("glows the collapsed sidebar button once for a section-hidden chat", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    window.localStorage.setItem(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify(["section:Ops"]));
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open", { section: "Calm" }), bot("h1", { section: "Ops", unread: true }), bot("h2", { section: "Ops" })],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector("[data-sidebar-collapsed-unread]")).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      expect(host.querySelector('[data-sidebar-row-id="h1"]')).toBeNull();
      const expand = () => host.querySelector("[data-sidebar-collapsed-unread]")?.closest("button") ?? null;
      expect(expand()?.hasAttribute("data-arrival-glow")).toBe(false);
      await sendFrame(replyFrame("h1-thread", botText("live-1", 11)));
      expect(expand()?.hasAttribute("data-arrival-glow")).toBe(true);
      expect(expand()?.className).toContain("arrival-glow");
      await endGlow(expand()!);
      expect(expand()?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(host.querySelector("[data-sidebar-collapsed-unread]")?.textContent).toBe("1");
    } finally {
      await unmount();
    }
  });

  it("glows the rail icon and not the expand button when the icon is visible", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open"), bot("closed", { unread: true })],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      const expand = () => host.querySelector("[data-sidebar-collapsed-unread]")?.closest("button") ?? null;
      await sendFrame(replyFrame("closed-thread", botText("live-1", 11)));
      expect(rowControl(host, "closed").control?.hasAttribute("data-arrival-glow")).toBe(true);
      expect(expand()?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(expand()?.className).not.toContain("arrival-glow");
    } finally {
      await unmount();
    }
  });

  it("glows a collapsed section header once for a hidden chat", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify(["section:Ops"]));
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open", { section: "Calm" }), bot("h1", { section: "Ops", unread: true }), bot("h2", { section: "Ops" })],
      groups: [],
    });
    try {
      const header = () => host.querySelector('[data-section="Ops"] button');
      await vi.waitFor(() => expect(header()).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      expect(host.querySelector('[data-sidebar-row-id="h1"]')).toBeNull();
      expect(header()?.hasAttribute("data-arrival-glow")).toBe(false);
      await sendFrame(replyFrame("h1-thread", botText("live-1", 11)));
      expect(header()?.hasAttribute("data-arrival-glow")).toBe(true);
      expect(header()?.className).toContain("arrival-glow");
      await endGlow(header()!);
      expect(header()?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(host.querySelector('[data-section="Ops"] [data-sidebar-section-unread]')?.textContent).toBe("1");
    } finally {
      await unmount();
    }
  });

  it("gives ring only under reduced motion", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    const { host, dispatch, unmount } = await mountSidebar({
      bots: [bot("open"), bot("closed", { unread: true })],
      groups: [],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      await act(async () => dispatch()({ type: "select", id: "open" }));
      await sendFrame(replyFrame("closed-thread", botText("live-1", 11)));
      const { control } = rowControl(host, "closed");
      expect(control?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(control?.className).toContain("unread-ring");
    } finally {
      await unmount();
    }
  });

  it("glows the phone menu button once for a hidden chat while the drawer is closed", async () => {
    const width = stubViewportWidth();
    await width.setPhone(true);
    const picked = { modelSelection: { instanceId: "muse", model: "muse-spark" } };
    const { host, unmount } = await mountApp([bot("open", picked), bot("closed", { ...picked, unread: true })]);
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      expect(host.querySelector("[data-menu-unread]")?.textContent).toBe("1");
      const menu = () => host.querySelector("[data-phone-menu]");
      expect(menu()?.hasAttribute("data-arrival-glow")).toBe(false);
      await sendFrame(replyFrame("closed-thread", botText("live-1", 11)));
      expect(menu()?.hasAttribute("data-arrival-glow")).toBe(true);
      expect(menu()?.className).toContain("arrival-glow");
      await endGlow(menu()!);
      expect(menu()?.hasAttribute("data-arrival-glow")).toBe(false);
      expect(host.querySelector("[data-menu-unread]")?.textContent).toBe("1");
    } finally {
      await unmount();
    }
  });

  it("leaves the phone menu unflagged at desktop width and replays nothing on resize", async () => {
    const width = stubViewportWidth();
    const picked = { modelSelection: { instanceId: "muse", model: "muse-spark" } };
    const { host, unmount } = await mountApp([bot("open", picked), bot("closed", { ...picked, unread: true })]);
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="closed"]')).not.toBeNull());
      const menu = () => host.querySelector("[data-phone-menu]");
      expect(menu()?.hasAttribute("data-arrival-glow")).toBe(false);
      await sendFrame(replyFrame("closed-thread", botText("live-1", 11)));
      expect(rowControl(host, "closed").control?.hasAttribute("data-arrival-glow")).toBe(true);
      expect(menu()?.hasAttribute("data-arrival-glow")).toBe(false);
      await width.setPhone(true);
      expect(menu()?.hasAttribute("data-arrival-glow")).toBe(false);
      await width.setPhone(false);
      expect(menu()?.hasAttribute("data-arrival-glow")).toBe(false);
    } finally {
      await unmount();
    }
  });

  it("plays one 2 s ease-in-out cycle of the needs-you glow, silenced under reduced motion", () => {
    const glow = css.match(/\.arrival-glow::before \{(.*?)\}/s)?.[1] ?? "";
    expect(glow).toContain("1.5px");
    expect(glow).toContain("92%");
    expect(glow).toContain("14px");
    expect(glow).toContain("60%");
    expect(glow).toContain("arrival-glow-once 2s ease-in-out 1");
    expect(glow).not.toContain("infinite");
    const ringed = css.match(/\.unread-ring\.arrival-glow::before \{(.*?)\}/s)?.[1] ?? "";
    expect(ringed).toContain("14px");
    expect(ringed).not.toContain("1.5px");
    expect(ringed).not.toContain("92%");
    const cycle = css.slice(css.indexOf("@keyframes arrival-glow-once"));
    expect(cycle).toMatch(/opacity:\s*0\b/);
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".arrival-glow::before");
    expect(reduced).toContain("animation: none");
  });

  it("rests the arrival glow invisible outside the animation", () => {
    const glow = css.match(/\.arrival-glow::before \{(.*?)\}/s)?.[1] ?? "";
    expect(glow).toMatch(/opacity:\s*0\b/);
  });
});
