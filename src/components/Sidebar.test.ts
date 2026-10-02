// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, Profiler, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { persistPreference } from "@/lib/i18n";
import { hapticTick } from "@/lib/phone-swipe";
import {
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_ORDER_KEY,
  SIDEBAR_SECTION_ORDER_KEY,
  SIDEBAR_SIDE_EVENT,
  SIDEBAR_SIDE_KEY,
  SIDEBAR_WIDTH_KEY,
} from "@/lib/sidebar-preferences";
import { LONG_PRESS_MS } from "@/lib/use-touch-drag";
import { usePhoneSwipe } from "@/lib/use-phone-swipe";
import { formatTime, StoreProvider, useStore } from "@/state/store";

import { compactSidebarModelLabel, Sidebar } from "./Sidebar";

vi.mock("@/lib/phone-swipe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/phone-swipe")>()),
  hapticTick: vi.fn(),
  isPhone: () => true,
}));

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

const bot = (id: string) => ({ id, threadId: `${id}-thread`, name: id, messages: [] });

function SeedTerminalAttention() {
  const { state, dispatch } = useStore();
  useEffect(() => {
    if (!state.bots.some((candidate) => candidate.id === "attention")) return;
    dispatch({
      type: "markTerminalAttention",
      botId: "attention",
      sessionId: "session-1",
      reason: "bell",
      receivedAt: 10,
    });
  }, [dispatch, state.bots.length]);
  return createElement(Sidebar, { open: false, onClose: () => {} });
}

/** Selects a bot (clearing its unread), then re-marks it unread the way an
 * incoming message would while it stays open - the badge must still skip it. */
function SelectThenMarkUnread({ id }: { id: string }) {
  const { state, dispatch } = useStore();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !state.bots.some((candidate) => candidate.id === id)) return;
    done.current = true;
    dispatch({ type: "select", id });
    dispatch({ type: "markUnread", botId: id });
  }, [dispatch, id, state.bots]);
  return createElement(Sidebar, { open: false, onClose: () => {} });
}

// happy-dom drag events carry no dataTransfer, and the row handlers write to it.
const fire = (target: Element, type: string) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => "", setData: () => {} } });
  target.dispatchEvent(event);
};

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.removeItem(SIDEBAR_ORDER_KEY);
  window.localStorage.removeItem(SIDEBAR_SECTION_ORDER_KEY);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sidebar drag to reorder", () => {
  it("never revives a drag when a dragover lands after its dragend", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (path: string) =>
      path === "/api/bots?messages=200"
        ? new Response(JSON.stringify({ bots: ["a", "b", "c"].map(bot), groups: [] }))
        : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const rows = () => host.querySelectorAll('div[draggable="true"]');
    const dropLine = () => host.querySelector('[class~="h-0.5"]');
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(rows()).toHaveLength(3));
      const [a, b, c] = rows();
      await act(async () => fire(a!, "dragstart"));
      await act(async () => fire(c!, "dragover"));
      expect(dropLine()).not.toBeNull();
      await act(async () => {
        fire(a!, "dragend");
        fire(b!, "dragover");
      });
      expect(dropLine()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar bot section drag", () => {
  it("moves a bot across sections and keeps the saved section order", async () => {
    const scopedBot = (id: string, section: string) => ({ ...bot(id), section });
    const sectionGroup = {
      id: "group-a",
      threadId: "group-a-thread",
      name: "A group",
      memberIds: [],
      messages: [],
      section: "A",
    };
    const patchCalls: Array<{ path: string; body: unknown }> = [];
    window.localStorage.setItem(SIDEBAR_SECTION_ORDER_KEY, JSON.stringify(["section:B", "section:A"]));
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/api/bots?messages=200") {
          return new Response(JSON.stringify({
            bots: [scopedBot("a", "A"), scopedBot("b", "B")],
            groups: [sectionGroup],
          }));
        }
        if (path === "/api/bots/order") {
          const body = JSON.parse(String(init?.body)) as { botIds: string[] };
          patchCalls.push({ path, body });
          return new Response(JSON.stringify(body));
        }
        if (path === "/api/bots/a" && init?.method === "PATCH") {
          patchCalls.push({ path, body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify({ bot: { id: "a", section: "B" } }));
        }
        return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const botRows = () => host.querySelectorAll('[data-sidebar-row-kind="bot"][draggable="true"]');
    const sections = () => [...host.querySelectorAll("[data-sidebar-section-id]")].map((section) => section.getAttribute("data-sidebar-section-id"));
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(botRows()).toHaveLength(2));
      const sectionB = host.querySelector('[data-sidebar-bot-drop-zone="B"]');
      const source = host.querySelector('[data-sidebar-row-kind="bot"][data-sidebar-row-id="a"]');
      expect(sectionB).not.toBeNull();
      expect(source).not.toBeNull();

      await act(async () => fire(source!, "dragstart"));
      await act(async () => fire(sectionB!, "dragover"));
      expect(host.querySelector("[data-sidebar-bot-drop-marker]")).not.toBeNull();
      await act(async () => fire(sectionB!, "drop"));
      await act(async () => fire(source!, "dragend"));

      expect(sections()).toEqual(["section:B", "section:A"]);
      expect(host.querySelector('[data-sidebar-section-id="section:B"]')?.textContent).toContain("a");
      await vi.waitFor(() => expect(patchCalls).toContainEqual({ path: "/api/bots/a", body: { section: "B" } }));
      expect(patchCalls.some(({ path }) => path === "/api/bots/order")).toBe(false);
      expect(JSON.parse(window.localStorage.getItem(SIDEBAR_ORDER_KEY) ?? "{}")).toMatchObject({
        sectionOrder: ["section:B", "unassigned", "section:A"],
        itemOrder: { "section:B": ["bot:b", "bot:a"] },
      });
    } finally {
      window.localStorage.removeItem(SIDEBAR_SECTION_ORDER_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("reveals an empty Unassigned drop target while moving a row out of a section", async () => {
    const scopedBot = { ...bot("a"), section: "A" };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/api/bots?messages=200") return new Response(JSON.stringify({ bots: [scopedBot], groups: [] }));
        if (path === "/api/bots/a" && init?.method === "PATCH") {
          return new Response(JSON.stringify({ bot: { ...scopedBot, section: "" } }));
        }
        return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      const source = await vi.waitFor(() => {
        const row = host.querySelector('[data-sidebar-row-kind="bot"][data-sidebar-row-id="a"]');
        expect(row).not.toBeNull();
        return row!;
      });
      expect(host.querySelector('[data-sidebar-item-drop-zone="unassigned"]')).toBeNull();
      await act(async () => fire(source, "dragstart"));
      const target = await vi.waitFor(() => {
        const section = host.querySelector('[data-sidebar-item-drop-zone="unassigned"]');
        expect(section).not.toBeNull();
        return section!;
      });
      await act(async () => fire(target, "dragover"));
      expect(host.querySelector("[data-sidebar-bot-drop-marker]")).not.toBeNull();
      await act(async () => fire(target, "drop"));
      await act(async () => fire(source, "dragend"));
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-section-id="unassigned"]')?.textContent).toContain("a"));
      await vi.waitFor(() => expect(JSON.parse(window.localStorage.getItem(SIDEBAR_ORDER_KEY) ?? "{}").itemOrder).toMatchObject({
        unassigned: ["bot:a"],
      }));
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar row time", () => {
  it("keeps the active time visible and reveals inactive times on hover or focus", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Sidebar.tsx"), "utf8");
    const botTime = source.slice(source.indexOf("function BotListItem"), source.indexOf("function ArchivedBotsPanel"));
    const groupTime = source.slice(source.indexOf("function GroupListItem"), source.indexOf("function RoomContextMenu"));
    for (const row of [botTime, groupTime]) {
      expect(row).toContain('!selected && "hidden group-hover:inline group-focus-within:inline"');
      expect(row).not.toContain("group-hover:hidden");
      expect(row).not.toContain("group-focus-within:hidden");
      expect(row).toContain("@container/rowtext");
      expect(row).toContain("@max-[10rem]/rowtext:hidden!");
    }
    expect(botTime).toContain("min-w-0 flex-1 truncate");
    expect(botTime).toContain("overflow-hidden");
  });

  it.each(["en", "ko"] as const)("follows the %s UI language like the chat", async (locale) => {
    const at = Date.UTC(2026, 8, 12, 16, 36);
    const a = { ...bot("a"), messages: [{ id: "m", role: "bot", kind: "text", text: "hi", at }], activeLeafId: "m" };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (path: string) =>
      new Response(JSON.stringify(path === "/api/bots?messages=200" ? { bots: [a], groups: [] } : {}), { status: path === "/api/bots?messages=200" ? 200 : 404 })));
    persistPreference(locale);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))));
      await act(async () => FakeEventSource.current!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }), lastEventId: "" }));
      await vi.waitFor(() => expect(host.textContent).toContain(formatTime(at, locale)));
    } finally {
      persistPreference("en");
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar priority ordering", () => {
  it("promotes and demotes Pin and Chief without losing the saved section slot", async () => {
    const initialBots = [
      { ...bot("regular"), section: "Work", modelSelection: { instanceId: "", model: "" } },
      { ...bot("pinned"), section: "Work", pinned: true, modelSelection: { instanceId: "", model: "" } },
      { ...bot("chief"), section: "Personal", chiefOfStaff: true, modelSelection: { instanceId: "", model: "" } },
      { ...bot("both"), section: "Other", chiefOfStaff: true, pinned: true, modelSelection: { instanceId: "", model: "" } },
      { ...bot("other"), section: "Other", modelSelection: { instanceId: "", model: "" } },
    ];
    let serverBots = initialBots;
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
    window.localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify({
      sectionOrder: ["section:Work", "section:Personal", "section:Other", "unassigned"],
      itemOrder: {
        "section:Work": ["bot:regular", "bot:pinned"],
        "section:Personal": ["bot:chief"],
        "section:Other": ["bot:both", "bot:other"],
      },
    }));
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/api/bots?messages=200") return new Response(JSON.stringify({ bots: serverBots, groups: [] }));
        if (path.startsWith("/api/bots/") && init?.method === "PATCH") {
          const id = path.slice("/api/bots/".length);
          const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
          patches.push({ id, patch });
          serverBots = serverBots.map((candidate) => candidate.id === id ? { ...candidate, ...patch } : candidate);
          return new Response(JSON.stringify({ bot: serverBots.find((candidate) => candidate.id === id) }));
        }
        return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const rowIds = () => [...host.querySelectorAll("[data-sidebar-row]")].map((row) => row.getAttribute("data-sidebar-row-id"));
    const menuButton = (label: string) =>
      [...document.body.querySelectorAll("[data-bot-menu] button")].find((button) => button.textContent === label);
    const choose = async (id: string, label: string) => {
      const row = host.querySelector(`[data-sidebar-row-id="${id}"]`)!;
      await act(async () => row.querySelector('[role="button"]')?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }),
      ));
      const button = menuButton(label);
      expect(button).not.toBeUndefined();
      await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    };
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))));
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(rowIds()).toEqual(["chief", "both", "pinned", "regular", "other"]));
      expect(host.querySelectorAll('[data-sidebar-row-id="both"]')).toHaveLength(1);
      expect(host.querySelector('[data-sidebar-section-id="section:Other"]')?.textContent).toContain("other");
      expect(host.querySelector('[data-sidebar-section-id="section:Other"]')?.textContent).not.toContain("both");

      await choose("regular", "Pin");
      expect(rowIds()).toEqual(["chief", "both", "regular", "pinned", "other"]);
      expect(host.querySelector('[data-sidebar-priority-tier="pinned"]')?.textContent).toContain("regular");

      await choose("regular", "Make Chief of Staff");
      expect(rowIds()).toEqual(["regular", "chief", "both", "pinned", "other"]);
      expect(host.querySelector('[data-sidebar-priority-tier="chief"]')?.textContent).toContain("regular");

      await choose("regular", "Remove Chief of Staff");
      expect(rowIds()).toEqual(["chief", "both", "regular", "pinned", "other"]);
      await choose("regular", "Unpin");
      expect(rowIds()).toEqual(["chief", "both", "pinned", "regular", "other"]);
      expect(host.querySelector('[data-sidebar-section-id="section:Work"]')?.textContent).toContain("regular");
      await vi.waitFor(() => expect(serverBots.find((candidate) => candidate.id === "regular")).toMatchObject({
        pinned: false,
        chiefOfStaff: false,
      }));
      expect(patches.some(({ id }) => id === "regular")).toBe(true);
      expect(JSON.parse(window.localStorage.getItem(SIDEBAR_ORDER_KEY) ?? "{}").itemOrder).toMatchObject({
        "section:Work": ["bot:regular", "bot:pinned"],
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("renders pinned rows full size and first, unpinned rows compact", async () => {
    const bots = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({
      ...bot(id),
      pinned: id === "c" || id === "f",
      modelSelection: { instanceId: "", model: "" },
    }));
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (path: string) =>
      path === "/api/bots?messages=200"
        ? new Response(JSON.stringify({ bots, groups: [] }))
        : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 }),
    ));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const rows = () => [...host.querySelectorAll("[data-sidebar-row]")];
    const avatarWidth = (row: Element) =>
      (row.querySelector("span.relative.shrink-0")!.firstElementChild as HTMLElement).style.width;
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))));
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(rows()).toHaveLength(7));
      expect(rows().map((row) => row.getAttribute("data-sidebar-row-id"))).toEqual(["c", "f", "a", "b", "d", "e", "g"]);
      expect(rows().map(avatarWidth)).toEqual(["48px", "48px", "32px", "32px", "32px", "32px", "32px"]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps priority flags above regular rows during valid and invalid drags", async () => {
    const pinnedOne = { ...bot("pinned-one"), section: "Work", pinned: true, modelSelection: { instanceId: "", model: "" } };
    const regular = { ...bot("regular"), section: "Work", modelSelection: { instanceId: "", model: "" } };
    const pinnedTwo = { ...bot("pinned-two"), section: "Work", pinned: true, modelSelection: { instanceId: "", model: "" } };
    window.localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify({
      sectionOrder: ["section:Work", "unassigned"],
      itemOrder: { "section:Work": ["bot:pinned-one", "bot:regular", "bot:pinned-two"] },
    }));
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => path === "/api/bots?messages=200"
        ? new Response(JSON.stringify({ bots: [pinnedOne, regular, pinnedTwo], groups: [] }))
        : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const rows = () => [...host.querySelectorAll("[data-sidebar-row]")];
    const rowIds = () => rows().map((row) => row.getAttribute("data-sidebar-row-id"));
    const dropMarker = () => host.querySelector("[data-sidebar-row-drop-marker]");
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))));
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(rowIds()).toEqual(["pinned-one", "pinned-two", "regular"]));
      await act(async () => fire(rows()[0]!, "dragstart"));
      await act(async () => fire(rows()[2]!, "dragover"));
      expect(dropMarker()).toBeNull();
      await act(async () => fire(rows()[2]!, "drop"));
      await act(async () => fire(rows()[0]!, "dragend"));
      expect(rowIds()).toEqual(["pinned-one", "pinned-two", "regular"]);

      await act(async () => fire(rows()[0]!, "dragstart"));
      await act(async () => fire(rows()[1]!, "dragover"));
      expect(dropMarker()).not.toBeNull();
      await act(async () => fire(rows()[1]!, "drop"));
      await act(async () => fire(rows()[0]!, "dragend"));
      expect(rowIds()).toEqual(["pinned-two", "pinned-one", "regular"]);
      expect(JSON.parse(window.localStorage.getItem(SIDEBAR_ORDER_KEY) ?? "{}").itemOrder).toMatchObject({
        "section:Work": ["bot:pinned-two", "bot:regular", "bot:pinned-one"],
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar layout controls", () => {
  it("toggles the persisted icon rail while restoring the saved labeled width", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "0");
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "360");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/bots?messages=200"
          ? new Response(JSON.stringify({ bots: [bot("a")], groups: [] }))
          : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const animate = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(() => new Animation());
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const motion = { duration: 300, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
    const calls = () => animate.mock.calls.map(([keyframes, options], i) => ({ el: animate.mock.contexts[i], keyframes, options }));
    try {
      await act(async () =>
        root.render(createElement(
          StoreProvider,
          null,
          createElement(Sidebar, { open: false, onClose: () => {} }),
          createElement("main"),
        )),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));

      const toggle = () => host.querySelector('button[aria-label="Collapse sidebar to avatars"], button[aria-label="Expand sidebar"]');
      const view = host.querySelector("main")!;
      expect(toggle()).not.toBeNull();
      await act(async () => toggle()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("1");
      const aside = host.querySelector("aside")!;
      expect(aside.getAttribute("style")).toContain("width: 64px");
      expect(aside.className).not.toContain("transition-[width]");
      expect(calls().map(({ el }) => el)).not.toContain(aside);
      expect(calls()).toEqual([
        { el: expect.anything(), keyframes: [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], options: { ...motion, fill: "forwards" } },
        { el: view, keyframes: [{ marginLeft: "296px" }, { marginLeft: "0px" }], options: motion },
      ]);

      animate.mockClear();
      await act(async () => toggle()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("0");
      expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("360");
      expect(aside.getAttribute("style")).toContain("width: 360px");
      // No fill: a clip left on the aside would clip its fixed overlays.
      expect(calls()).toEqual([
        { el: aside, keyframes: [{ clipPath: "inset(0 296px 0 0)" }, { clipPath: "inset(0)" }], options: motion },
        { el: view, keyframes: [{ marginLeft: "-296px" }, { marginLeft: "0px" }], options: motion },
      ]);
    } finally {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
      window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("reverses an interrupted toggle from the current edge and slides rigid views", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "0");
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "360");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/bots?messages=200"
          ? new Response(JSON.stringify({ bots: [bot("a")], groups: [] }))
          : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancel = vi.fn();
    const halfway = () => ({ cancel, effect: { getComputedTiming: () => ({ progress: 0.5 }) } }) as unknown as Animation;
    const animate = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(halfway);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(
          StoreProvider,
          null,
          createElement(Sidebar, { open: false, onClose: () => {}, rigidView: true }),
          createElement("main"),
          createElement("div", { style: { position: "fixed" } }),
        )),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));

      const toggle = () => host.querySelector('button[aria-label="Collapse sidebar to avatars"], button[aria-label="Expand sidebar"]');
      const view = host.querySelector("main")!;
      const aside = host.querySelector("aside")!;
      await act(async () => toggle()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(animate.mock.contexts.slice(1)).toEqual([view]);
      expect(animate.mock.calls[1]?.[0]).toEqual([{ transform: "translateX(296px)" }, { transform: "none" }]);

      animate.mockClear();
      await act(async () => toggle()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(animate.mock.contexts).toEqual([aside, view]);
      expect(animate.mock.calls.map(([keyframes]) => keyframes)).toEqual([
        [{ clipPath: "inset(0 148px 0 0)" }, { clipPath: "inset(0)" }],
        [{ transform: "translateX(-148px)" }, { transform: "none" }],
      ]);
    } finally {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
      window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("slides both mobile arrows without animating layout or the chat", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "0");
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "360");
    vi.spyOn(window, "matchMedia").mockImplementation(() => ({ matches: false } as MediaQueryList));
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancel = vi.fn();
    const animate = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(() => ({
      cancel,
      effect: { getComputedTiming: () => ({ progress: 0.5 }) },
    }) as unknown as Animation);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const motion = { duration: 300, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
    try {
      await act(async () => root.render(createElement(
        StoreProvider,
        null,
        createElement(Sidebar, { open: true, onClose: () => {} }),
        createElement("main"),
      )));
      const aside = host.querySelector("aside")!;
      const toggle = () => host.querySelector('button[aria-label="Collapse sidebar to avatars"], button[aria-label="Expand sidebar"]')!;
      await act(async () => toggle().dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(animate.mock.contexts).toEqual([aside]);
      expect(animate.mock.calls).toEqual([[
        [{ transform: "translateX(296px)" }, { transform: "translateX(0)" }], motion,
      ]]);
      const ghost = aside.querySelector<HTMLElement>('[aria-hidden][class*="left-full"]')!;
      expect(ghost.style.left).toBe("-296px");
      expect(ghost.style.width).toBe("296px");

      animate.mockClear();
      await act(async () => toggle().dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(cancel).toHaveBeenCalledOnce();
      expect(animate.mock.contexts).toEqual([aside]);
      expect(animate.mock.calls).toEqual([[
        [{ transform: "translateX(-148px)" }, { transform: "translateX(0)" }], motion,
      ]]);
      expect(ghost.style.left).toBe("");
      expect(ghost.style.width).toBe("");

      animate.mockClear();
      vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
      }) as MediaQueryList);
      await act(async () => toggle().dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(animate).not.toHaveBeenCalled();
    } finally {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
      window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("mirrors the mobile arrows on the right, leaving the ghost past the drawer's right edge", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "0");
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "360");
    window.localStorage.setItem(SIDEBAR_SIDE_KEY, "right");
    vi.spyOn(window, "matchMedia").mockImplementation(() => ({ matches: false } as MediaQueryList));
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancel = vi.fn();
    const animate = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(() => ({
      cancel,
      effect: { getComputedTiming: () => ({ progress: 0.5 }) },
    }) as unknown as Animation);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const motion = { duration: 300, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
    try {
      await act(async () => root.render(createElement(
        StoreProvider,
        null,
        createElement(Sidebar, { open: true, onClose: () => {} }),
        createElement("main"),
      )));
      const aside = host.querySelector("aside")!;
      const toggle = () => host.querySelector('button[aria-label="Collapse sidebar to avatars"], button[aria-label="Expand sidebar"]')!;
      await act(async () => toggle().dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(animate.mock.contexts).toEqual([aside]);
      expect(animate.mock.calls).toEqual([[
        [{ transform: "translateX(-296px)" }, { transform: "translateX(0)" }], motion,
      ]]);
      const ghost = aside.querySelector<HTMLElement>('[aria-hidden][class*="left-full"]')!;
      expect(ghost.style.left).toBe("");
      expect(ghost.style.width).toBe("296px");

      animate.mockClear();
      await act(async () => toggle().dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(cancel).toHaveBeenCalledOnce();
      expect(animate.mock.calls).toEqual([[
        [{ transform: "translateX(148px)" }, { transform: "translateX(0)" }], motion,
      ]]);
    } finally {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
      window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
      window.localStorage.removeItem(SIDEBAR_SIDE_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("never animates a drag resize or reduced motion", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "0");
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "360");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const animate = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(() => new Animation());
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const aside = () => host.querySelector("aside")!;
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }), createElement("main"))),
      );
      const handle = host.querySelector<HTMLElement>("[data-sidebar-resize]")!;
      handle.setPointerCapture = () => {};
      handle.releasePointerCapture = () => {};
      const pointer = (type: string, clientX: number) =>
        act(async () => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, pointerId: 1 })));
      await pointer("pointerdown", 360);
      await pointer("pointermove", 300);
      await pointer("pointerup", 300);
      expect(aside().getAttribute("style")).toContain("width: 300px");
      expect(animate).not.toHaveBeenCalled();

      const matchMedia = window.matchMedia.bind(window);
      vi.spyOn(window, "matchMedia").mockImplementation((query) =>
        query === "(prefers-reduced-motion: reduce)" ? ({ matches: true } as MediaQueryList) : matchMedia(query));
      const toggle = host.querySelector('button[aria-label="Collapse sidebar to avatars"]')!;
      await act(async () => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(aside().getAttribute("style")).toContain("width: 64px");
      expect(animate).not.toHaveBeenCalled();
    } finally {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
      window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps the update control in the footer rail and uses the tighter labeled row geometry", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Sidebar.tsx"), "utf8");
    const footer = source.slice(source.indexOf("{/* Footer */}"), source.indexOf("{menu &&"));
    expect(footer).toContain("data-sidebar-update");
    expect(footer).toContain("<UpdateButton />");
    const profileRow = footer.indexOf("data-sidebar-profile-row");
    const expandedUpdate = footer.lastIndexOf("data-sidebar-update");
    const profileButton = footer.indexOf('onClick={() => dispatch({ type: "toggleAppSettings" })}', profileRow);
    expect(profileButton).toBeLessThan(expandedUpdate);
    expect(footer).toContain("overflow-x-hidden");
    expect(footer).not.toContain("border-t");
    expect(footer).not.toContain('t("chrome.teamMap")');
    expect(source).toContain("density === \"compact\" ? 32 : 48");
    expect(source).toContain("gap-2 px-3 py-1.5 pr-12");
    expect(source).toContain("min-w-0 flex-1 overflow-x-hidden overflow-y-auto");
  });

  it("reorders named sections with a keyboard fallback and persists the order", async () => {
    window.localStorage.removeItem(SIDEBAR_SECTION_ORDER_KEY);
    const work = { ...bot("work"), section: "Work" };
    const personal = { ...bot("personal"), section: "Personal" };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/bots?messages=200"
          ? new Response(JSON.stringify({ bots: [work, personal], groups: [] }))
          : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const sectionOrder = () =>
      [...host.querySelectorAll("[data-sidebar-section-id]")].map((section) => section.getAttribute("data-sidebar-section-id"));
    const sectionTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => "section:Work"),
    };
    const fireWithTransfer = (target: Element, type: string, clientY = 0) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: sectionTransfer });
      Object.defineProperty(event, "clientY", { value: clientY });
      target.dispatchEvent(event);
    };
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(sectionOrder()).toEqual(["section:Work", "section:Personal"]));

      const workHandle = host.querySelector('[data-sidebar-section-id="section:Work"] [data-sidebar-section-handle]');
      expect(workHandle?.getAttribute("aria-keyshortcuts")).toContain("Alt+ArrowDown");
      expect(host.querySelector('[data-sidebar-section-grip]')).toBeNull();
      await act(async () => workHandle?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true })));
      expect(sectionOrder()).toEqual(["section:Personal", "section:Work"]);
      expect(window.localStorage.getItem(SIDEBAR_SECTION_ORDER_KEY)).toBe(
        JSON.stringify(["section:Personal", "section:Work"]),
      );

      const personalHeader = host.querySelector('[data-sidebar-section-id="section:Personal"] [data-sidebar-section-header]');
      const workHeader = host.querySelector('[data-sidebar-section-id="section:Work"] [data-sidebar-section-handle]');
      await act(async () => fireWithTransfer(workHeader!, "dragstart"));
      await act(async () => fireWithTransfer(personalHeader!, "dragover", -1));
      await act(async () => fireWithTransfer(personalHeader!, "drop", -1));
      expect(sectionOrder()).toEqual(["section:Work", "section:Personal"]);
    } finally {
      window.localStorage.removeItem(SIDEBAR_SECTION_ORDER_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("mirrors the aside border, resize handle, and toggle icon to the right and reacts live to a settings change", async () => {
    window.localStorage.setItem(SIDEBAR_SIDE_KEY, "right");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      const aside = host.querySelector("aside")!;
      const handle = host.querySelector<HTMLElement>("[data-sidebar-resize]")!;
      expect(aside.className).toContain("md:order-last");
      expect(aside.className).toContain("md:border-l");
      expect(handle.className).toContain("left-0");
      expect(handle.className).not.toContain("right-0");
      expect(host.querySelector('svg[class*="panel-right-close"]')).not.toBeNull();

      window.localStorage.setItem(SIDEBAR_SIDE_KEY, "left");
      await act(async () => window.dispatchEvent(new Event(SIDEBAR_SIDE_EVENT)));
      expect(aside.className).not.toContain("md:order-last");
      expect(handle.className).toContain("right-0");
      expect(host.querySelector('svg[class*="panel-left-close"]')).not.toBeNull();
    } finally {
      window.localStorage.removeItem(SIDEBAR_SIDE_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("anchors the phone drawer to the right and slides it in from the right when the side is right", async () => {
    window.localStorage.setItem(SIDEBAR_SIDE_KEY, "right");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      const aside = host.querySelector("aside")!;
      expect(aside.className).toContain("max-md:right-0");
      expect(aside.className).not.toContain("max-md:left-0");
      expect(aside.className).toContain("max-md:translate-x-full");
      expect(aside.className).not.toContain("max-md:-translate-x-full");
      expect(aside.className).toContain("max-md:border-l");
      expect(aside.className).toContain("max-md:border-r-0");
    } finally {
      window.localStorage.removeItem(SIDEBAR_SIDE_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("leaves the phone drawer on the left, sliding from the left, when the side is left", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      const aside = host.querySelector("aside")!;
      expect(aside.className).toContain("max-md:left-0");
      expect(aside.className).not.toContain("max-md:right-0");
      expect(aside.className).toContain("max-md:-translate-x-full");
      expect(aside.className).not.toContain("max-md:border-l");
      expect(aside.className).not.toContain("max-md:border-r-0");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("badges the collapsed reopen button, excluding the open chat, hidden bots, and terminals", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    const bots = [
      { ...bot("a"), unread: true },
      { ...bot("b"), unread: true },
      { ...bot("hidden"), unread: true, hidden: true },
    ];
    const groups = [{ id: "g1", threadId: "g1-thread", name: "Room", memberIds: ["a", "b"], messages: [], unread: true }];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/bots?messages=200"
          ? new Response(JSON.stringify({ bots, groups }))
          : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(SelectThenMarkUnread, { id: "a" }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      // "a" is the open chat (re-marked unread) and "hidden" is archived - only "b" and "g1" count.
      const badge = await vi.waitFor(() => {
        const el = host.querySelector("[data-sidebar-collapsed-unread]");
        expect(el).not.toBeNull();
        return el!;
      });
      expect(badge.textContent).toBe("2");
    } finally {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("hides the collapsed badge at zero unread and expanded", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "0");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/bots?messages=200"
          ? new Response(JSON.stringify({ bots: [{ ...bot("a"), unread: true }], groups: [] }))
          : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      expect(host.querySelector("[data-sidebar-collapsed-unread]")).toBeNull();
    } finally {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("caps the collapsed badge at 9+", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    const bots = Array.from({ length: 12 }, (_, i) => ({ ...bot(`b${i}`), unread: true }));
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/bots?messages=200"
          ? new Response(JSON.stringify({ bots, groups: [] }))
          : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      const badge = await vi.waitFor(() => {
        const el = host.querySelector("[data-sidebar-collapsed-unread]");
        expect(el).not.toBeNull();
        return el!;
      });
      expect(badge.textContent).toBe("9+");
    } finally {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar group drag to reorder", () => {
  it("mounts group rows on draggable divs and reorders within a section in either direction, persisting each order", async () => {
    const room = (id: string, name: string, section: string) => ({
      id,
      threadId: `${id}-thread`,
      name,
      memberIds: [],
      messages: [],
      section,
    });
    const orderPuts: string[][] = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/api/bots?messages=200")
          return new Response(
            JSON.stringify({
              bots: [],
              groups: [
                room("g-a", "Worker & Co.", "RANDOM CHATTER"),
                room("g-b", "Chit Chat", "RANDOM CHATTER"),
              ],
            }),
          );
        if (path === "/api/groups/order") {
          // SAFETY: the stub only serves this test's reorder PUT, whose body is always { groupIds }.
          const body = JSON.parse(String(init?.body)) as { groupIds: string[] };
          orderPuts.push(body.groupIds);
          return new Response(JSON.stringify({ groupIds: body.groupIds }));
        }
        return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const rows = () => host.querySelectorAll('div[draggable="true"]');
    const names = () => [...rows()].map((row) => row.textContent ?? "");
    const dropLine = () => host.querySelector('[class~="h-0.5"]');
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(rows()).toHaveLength(2));
      // Native drag lives on a plain div wrapper like bot rows — never on the
      // button itself — so press-then-move from anywhere initiates the row drag.
      for (const row of rows()) {
        expect(row.tagName).toBe("DIV");
        expect(row.querySelector("button")).not.toBeNull();
      }
      expect(host.querySelector('button[draggable="true"]')).toBeNull();
      expect(host.querySelector('[data-sidebar-row-grip]')).toBeNull();
      expect(names()[0]).toContain("Worker");
      expect(names()[1]).toContain("Chit Chat");

      // Drag the first group down onto the second: the rows swap.
      const [first, second] = rows();
      await act(async () => fire(first!, "dragstart"));
      await act(async () => fire(second!, "dragover"));
      expect(dropLine()).not.toBeNull();
      await act(async () => fire(second!, "drop"));
      await act(async () => fire(first!, "dragend"));
      expect(names()[0]).toContain("Chit Chat");
      expect(names()[1]).toContain("Worker");
      expect(orderPuts).toEqual([]);
      expect(JSON.parse(window.localStorage.getItem(SIDEBAR_ORDER_KEY) ?? "{}").itemOrder).toMatchObject({
        "section:RANDOM CHATTER": ["group:g-b", "group:g-a"],
      });

      // Drag back up: the rows swap again, mirroring the QA opposite-drag pair.
      const [top, bottom] = rows();
      await act(async () => fire(bottom!, "dragstart"));
      await act(async () => fire(top!, "dragover"));
      expect(dropLine()).not.toBeNull();
      await act(async () => fire(top!, "drop"));
      await act(async () => fire(bottom!, "dragend"));
      expect(names()[0]).toContain("Worker");
      expect(names()[1]).toContain("Chit Chat");
      expect(orderPuts).toEqual([]);
      expect(JSON.parse(window.localStorage.getItem(SIDEBAR_ORDER_KEY) ?? "{}").itemOrder).toMatchObject({
        "section:RANDOM CHATTER": ["group:g-a", "group:g-b"],
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar group avatar overflow", () => {
  it("reserves the overflow badge width before the group name", async () => {
    const members = ["one", "two", "three", "four", "five"].map((id) => ({
      ...bot(id),
      color: "green" as const,
    }));
    const group = {
      id: "group-overflow",
      threadId: "group-overflow-thread",
      name: "Large group",
      memberIds: members.map((member) => member.id),
      messages: [],
    };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/bots?messages=200"
          ? new Response(JSON.stringify({ bots: members, groups: [group] }))
          : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      const slot = await vi.waitFor(() => {
        const element = host.querySelector("[data-sidebar-group-avatar-slot]");
        expect(element).not.toBeNull();
        return element!;
      });
      expect(slot.className).toContain("min-w-[84px]");
      expect(slot.querySelector("[data-sidebar-group-overflow]")?.textContent).toBe("+2");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar bot delete confirm", () => {
  it("asks before deleting: cancel keeps the bot, confirm deletes it", async () => {
    const deletes: string[] = [];
    const deletable = (id: string) => ({
      ...bot(id),
      modelSelection: { instanceId: "", model: "", mode: "automatic" as const },
    });
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/api/bots?messages=200")
          return new Response(JSON.stringify({ bots: ["a", "b"].map(deletable), groups: [] }));
        if (path.startsWith("/api/bots/") && init?.method === "DELETE") {
          deletes.push(path);
          return new Response(JSON.stringify({}));
        }
        return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const rows = () => host.querySelectorAll('div[draggable="true"]');
    const menuDelete = () =>
      [...document.body.querySelectorAll("[data-bot-menu] button")].find(
        (item) => item.textContent === "Delete",
      );
    const dialog = () => document.body.querySelector('[role="dialog"]');
    const dialogButton = (label: string) =>
      [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === label);
    const contextmenu = (row: Element) =>
      // The menu listener sits on the inner clickable, so press there and let
      // the event bubble — dispatching on the wrapper would skip it.
      row
        .querySelector('[role="button"]')!
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }),
        );
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(rows()).toHaveLength(2));

      // Menu Delete opens a confirm instead of deleting immediately.
      await act(async () => contextmenu(rows()[0]!));
      expect(menuDelete()).not.toBeUndefined();
      await act(async () => fire(menuDelete()!, "click"));
      expect(dialog()?.textContent).toContain("Delete this bot?");
      expect(rows()).toHaveLength(2);
      expect(deletes).toHaveLength(0);

      // Cancel keeps the bot.
      await act(async () => fire(dialogButton("Cancel")!, "click"));
      expect(dialog()).toBeNull();
      expect(rows()).toHaveLength(2);
      expect(deletes).toHaveLength(0);

      // Confirm deletes the bot and persists the delete.
      await act(async () => contextmenu(rows()[0]!));
      await act(async () => fire(menuDelete()!, "click"));
      await act(async () => fire(dialogButton("Delete")!, "click"));
      expect(rows()).toHaveLength(1);
      expect(deletes).toEqual(["/api/bots/a"]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar bot model line", () => {
  it("shows the bot's pinned model label from the matching instance catalog", async () => {
    const pinned = {
      ...bot("m"),
      modelSelection: { instanceId: "muse", model: "muse-spark-1.3" },
    };
    const muse = {
      instanceId: "muse",
      driverKind: "museAgent",
      displayName: "Meta Muse",
      snapshot: { state: "available" },
      models: {
        default: "muse-spark-1.3",
        options: [{ id: "muse-spark-1.3", label: "Meta Muse 1.3" }],
      },
    };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/bots?messages=200")
          return new Response(JSON.stringify({ bots: [pinned], groups: [] }));
        if (path === "/api/instances")
          return new Response(JSON.stringify({ instances: [muse] }));
        return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(host.textContent).toContain("Meta Muse 1.3"), { timeout: 5000 });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar bot second line", () => {
  const muse = {
    instanceId: "muse",
    driverKind: "museAgent",
    displayName: "Meta Muse",
    snapshot: { state: "available" },
    models: {
      default: "muse-spark-1.3",
      options: [
        { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
        { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
      ],
    },
  };

  async function renderSidebar(payload: { bots: unknown[]; groups: unknown[] }) {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/bots?messages=200") return new Response(JSON.stringify(payload));
        if (path === "/api/instances") return new Response(JSON.stringify({ instances: [muse] }));
        return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
    );
    await act(async () => FakeEventSource.current!.onmessage?.({
      data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
      lastEventId: "",
    }));
    return { host, root };
  }

  it("shows dot + model on bot rows with no message preview", async () => {
    const chatter = {
      ...bot("chatter"),
      modelSelection: { instanceId: "muse", model: "muse-spark-1.3" },
      messages: [{ id: "m1", role: "bot", kind: "text", text: "Zebra preview sentence", at: 7 }],
      activeLeafId: "m1",
    };
    const { host, root } = await renderSidebar({ bots: [chatter], groups: [] });
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("Meta Muse 1.3"), { timeout: 5000 });
      expect(host.textContent).not.toContain("Zebra preview sentence");
      const modelDot = host.querySelector("[data-sidebar-model-dot]");
      expect(modelDot?.className).toContain("bottom-0.5");
      expect(modelDot?.className).toContain("left-0.5");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("shows Working without preview text while the bot is busy", async () => {
    const worker = {
      ...bot("worker"),
      busy: true,
      modelSelection: { instanceId: "muse", model: "muse-spark-1.3" },
      messages: [{ id: "m1", role: "bot", kind: "text", text: "Giraffe preview sentence", at: 7 }],
      activeLeafId: "m1",
    };
    const { host, root } = await renderSidebar({ bots: [worker], groups: [] });
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("Meta Muse 1.3"), { timeout: 5000 });
      expect(host.textContent).toContain("Working");
      expect(host.textContent).not.toContain("Giraffe preview sentence");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("puts Chief of Staff above a readable compact model label", async () => {
    const chief = {
      ...bot("chief"),
      chiefOfStaff: true,
      modelSelection: { instanceId: "muse", model: "muse-spark-1.3-contributor" },
    };
    const { host, root } = await renderSidebar({ bots: [chief], groups: [] });
    try {
      await vi.waitFor(() => expect(host.querySelector("[data-sidebar-model-label]")).not.toBeNull(), { timeout: 5000 });
      const title = host.querySelector("[data-sidebar-chief-title]");
      const model = host.querySelector("[data-sidebar-model-label]");
      expect(title?.textContent).toContain("Chief of Staff");
      expect(title?.parentElement?.querySelector("[data-sidebar-model-row]")).toBe(model?.parentElement);
      expect(model?.textContent).toBe("Meta Muse 1.3 Cont.");
      expect(host.textContent).not.toContain("Contributor");
      expect(host.querySelector("[data-sidebar-model-dot]")?.className).toContain("left-0.5");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("disables quick archive for Chief of Staff rows", async () => {
    const chief = { ...bot("chief"), chiefOfStaff: true };
    const teammate = bot("teammate");
    const { host, root } = await renderSidebar({ bots: [chief, teammate], groups: [] });
    try {
      const row = await vi.waitFor(() => {
        const element = host.querySelector('[data-sidebar-row-kind="bot"][data-sidebar-row-id="chief"]');
        expect(element).not.toBeNull();
        return element!;
      });
      const archive = row.querySelector<HTMLButtonElement>('button[aria-label*="Archive"]');
      expect(archive?.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps model and chat dots in fixed corners while exposing terminal attention", async () => {
    const attentionBot = {
      ...bot("attention"),
      unread: true,
      modelSelection: { instanceId: "muse", model: "muse-spark-1.3" },
    };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => path === "/api/bots?messages=200"
        ? new Response(JSON.stringify({ bots: [attentionBot], groups: [] }))
        : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(SeedTerminalAttention))));
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      const badge = await vi.waitFor(() => {
        const element = host.querySelector("[data-sidebar-terminal-attention]");
        expect(element).not.toBeNull();
        return element!;
      });
      expect(badge.textContent).toBe(">_");
      expect(badge.getAttribute("data-terminal-session-id")).toBe("session-1");
      expect(badge.getAttribute("data-terminal-reason")).toBe("bell");
      expect(badge.getAttribute("title")).toBe("The terminal is waiting for input.");
      expect(host.querySelector("[data-sidebar-model-dot]")?.className).toContain("bottom-0.5");
      expect(host.querySelector("[data-sidebar-model-dot]")?.className).toContain("left-0.5");
      expect(host.querySelector("[data-sidebar-chat-unread]")?.className).toContain("bottom-0.5");
      expect(host.querySelector("[data-sidebar-chat-unread]")?.className).toContain("right-0.5");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps terminal attention keyboard events inside the badge", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Sidebar.tsx"), "utf8");
    const badge = source.slice(source.indexOf("data-sidebar-terminal-attention"), source.indexOf("className=", source.indexOf("data-sidebar-terminal-attention")));
    expect(badge).toContain("onKeyDown={(event) => event.stopPropagation()}");
  });

  it("keeps the message preview on group rows", async () => {
    const room = {
      id: "g1",
      threadId: "g1-thread",
      name: "Crew",
      memberIds: [],
      messages: [{ id: "m1", role: "bot", kind: "text", text: "Walrus group preview", at: 9 }],
      section: "RANDOM CHATTER",
    };
    const { host, root } = await renderSidebar({ bots: [], groups: [room] });
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("Walrus group preview"), { timeout: 5000 });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar bot rename", () => {
  it("shows the input on double-click and restores the row after Escape", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (path: string) =>
      path === "/api/bots?messages=200"
        ? new Response(JSON.stringify({ bots: [bot("a")], groups: [] }))
        : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const input = () => host.querySelector<HTMLInputElement>(`input[aria-label="Rename"]`);
    try {
      await act(async () =>
        root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
      );
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Rename a"]')).not.toBeNull());
      await act(async () =>
        host.querySelector('[aria-label="Rename a"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
      expect(input()).not.toBeNull();
      expect(input()!.value).toBe("a");
      await act(async () =>
        input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(input()).toBeNull();
      expect(host.querySelector('[aria-label="Rename a"]')).not.toBeNull();
      expect(host.querySelector('[data-sidebar-row-id="a"] [role="button"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Sidebar model labels", () => {
  it("shortens the Contributor suffix without changing other labels", () => {
    expect(compactSidebarModelLabel("Meta Muse 1.3 Contributor")).toBe("Meta Muse 1.3 Cont.");
    expect(compactSidebarModelLabel("Meta Muse 1.3")).toBe("Meta Muse 1.3");
  });
});

function SelectedProbe() {
  const { state } = useStore();
  return createElement("output", { "data-selected": state.selectedId ?? "" });
}

function SwipeStage({ onSelect }: { onSelect: (id: string) => void }) {
  const stage = usePhoneSwipe("a", true, onSelect);
  return createElement("div", { ref: stage }, createElement(Sidebar, { open: false, onClose: () => {} }));
}

const touch = (target: Element, type: string, x = 100, y = 100) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }] });
  target.dispatchEvent(event);
  return event;
};

describe("Sidebar touch drag", () => {
  let under: Element | null = null;

  async function mount(
    bots: Array<ReturnType<typeof bot> & { section?: string }>,
    view: ReturnType<typeof createElement> = createElement(Sidebar, { open: false, onClose: () => {} }),
  ) {
    const patches: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/bots?messages=200") return new Response(JSON.stringify({ bots, groups: [] }));
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push({ path, body });
        return new Response(JSON.stringify({ bot: { id: path.split("/").at(-1), ...body } }));
      }
      return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(hapticTick).mockClear();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => under });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const commits = { count: 0 };
    await act(async () => root.render(createElement(
      StoreProvider,
      null,
      createElement(Profiler, { id: "sidebar", onRender: () => void commits.count++ }, view),
      createElement(SelectedProbe),
    )));
    await act(async () => FakeEventSource.current!.onmessage?.({
      data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
      lastEventId: "",
    }));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-sidebar-row]")).toHaveLength(bots.length));
    // jsdom has no layout: rows 50px and section headers 40px, stacked in DOM order in a 1000px list
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const own = this.closest("[data-sidebar-row], [data-sidebar-section-header]") ?? this;
      let y = 0;
      let top: number | null = null;
      let bottom = 0;
      for (const box of host.querySelectorAll("[data-sidebar-row], [data-sidebar-section-header]")) {
        const next = y + (box.matches("[data-sidebar-row]") ? 50 : 40);
        if (own.contains(box)) {
          top ??= y;
          bottom = next;
        }
        y = next;
      }
      if (own === this && top !== null && !this.matches("[data-sidebar-row], [data-sidebar-section-header], [data-sidebar-item-drop-zone]")) [top, bottom] = [0, 1000];
      return { left: 0, right: 300, top: top ?? 0, bottom, x: 0, y: top ?? 0, width: 300, height: bottom - (top ?? 0) } as DOMRect;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const row = (id: string) => host.querySelector(`[data-sidebar-row-id="${id}"] [role="button"]`)!;
    const order = () => [...host.querySelectorAll("[data-sidebar-row]")].map((el) => el.getAttribute("data-sidebar-row-id"));
    const lifted = () => host.querySelector("[data-touch-lifted]")?.getAttribute("data-sidebar-row-id") ?? null;
    const hold = async (id: string) => {
      await act(async () => void touch(row(id), "touchstart"));
      await act(async () => void vi.advanceTimersByTime(LONG_PRESS_MS));
    };
    const middle = (target: Element | null) => {
      const rect = target?.getBoundingClientRect();
      return rect ? (rect.top + rect.bottom) / 2 : 160;
    };
    const moveOver = async (target: Element | null, source: Element, y = middle(target)) => {
      under = target;
      await act(async () => {
        touch(source, "touchmove", 100, y);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    };
    const marked = () => {
      const el = host.querySelector("[data-touch-drop]");
      return el && `${el.getAttribute("data-sidebar-row-id") ?? el.getAttribute("data-sidebar-item-drop-zone")}:${el.getAttribute("data-touch-drop")}`;
    };
    const unmount = async () => {
      under = null;
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, patches, commits, row, order, lifted, marked, hold, moveOver, unmount };
  }

  it("lifts a row after a long press and buzzes once", async () => {
    const view = await mount(["a", "b", "c"].map(bot));
    try {
      await act(async () => void touch(view.row("b"), "touchstart"));
      await act(async () => void vi.advanceTimersByTime(LONG_PRESS_MS - 50));
      expect(view.lifted()).toBeNull();
      await act(async () => void vi.advanceTimersByTime(50));
      expect(view.lifted()).toBe("b");
      expect(hapticTick).toHaveBeenCalledTimes(1);
      expect(view.host.querySelector<HTMLElement>("[data-touch-lifted]")?.style.getPropertyValue("pointer-events")).toBe("none");
    } finally {
      await view.unmount();
    }
  });

  it("moves and drops through the desktop reorder path, within and across sections", async () => {
    const view = await mount([bot("a"), bot("b"), bot("c"), { ...bot("d"), section: "Work" }]);
    try {
      await view.hold("a");
      await view.moveOver(view.row("c"), view.row("a"));
      expect(view.marked()).toBe("c:bottom");
      const end = touch(view.row("a"), "touchend");
      await act(async () => {});
      expect(end.defaultPrevented).toBe(true);
      expect(view.lifted()).toBeNull();
      expect(view.order().slice(0, 3)).toEqual(["b", "c", "a"]);
      expect(JSON.parse(window.localStorage.getItem(SIDEBAR_ORDER_KEY) ?? "{}").itemOrder).toMatchObject({
        unassigned: ["bot:b", "bot:c", "bot:a"],
      });

      await view.hold("b");
      const work = view.host.querySelector('[data-sidebar-item-drop-zone="section:Work"] [data-sidebar-section-header]')!;
      await view.moveOver(work, view.row("b"));
      expect(view.marked()).toBe("section:Work:into");
      await act(async () => void touch(view.row("b"), "touchend"));
      await vi.waitFor(() => expect(view.patches).toContainEqual({ path: "/api/bots/b", body: { section: "Work" } }));
    } finally {
      await view.unmount();
    }
  });

  it("moves the drop target without re-rendering the list", async () => {
    const view = await mount(["a", "b", "c", "d"].map(bot));
    try {
      await view.hold("d");
      const before = view.commits.count;
      for (const id of ["c", "c", "b", "a", "a", "b"]) {
        await view.moveOver(view.row(id), view.row("d"));
        expect(view.commits.count).toBe(before);
        expect(view.marked()).toBe(`${id}:top`);
      }
      await view.moveOver(view.host.querySelector('[data-sidebar-item-drop-zone="unassigned"] [data-sidebar-section-header]'), view.row("d"));
      expect(view.marked()).toBeNull();
      await view.moveOver(view.row("c"), view.row("d"));
      expect(view.commits.count).toBe(before);
      await act(async () => void touch(view.row("d"), "touchend"));
      expect(view.order()).toEqual(["a", "b", "d", "c"]);
    } finally {
      await view.unmount();
    }
  });

  it("draws the drop target with one moving marker, never restyling the target", async () => {
    const view = await mount(["a", "b", "c", "d"].map(bot));
    try {
      await view.hold("d");
      const marker = () => view.host.querySelector<HTMLElement>("[data-touch-drop-marker]");
      await view.moveOver(view.row("c"), view.row("d"));
      expect(marker()?.style.getPropertyValue("translate")).toBe("8px 140px");
      expect(marker()?.style.getPropertyValue("opacity")).toBe("1");
      const first = marker();
      await view.moveOver(view.row("b"), view.row("d"));
      expect(marker()).toBe(first);
      expect(marker()?.style.getPropertyValue("translate")).toBe("8px 90px");
      expect(view.host.querySelector('[data-sidebar-row-id="b"]')!.getAttribute("style")).toBeNull();
      await view.moveOver(view.host.querySelector('[data-sidebar-item-drop-zone="unassigned"] [data-sidebar-section-header]'), view.row("d"));
      expect(marker()?.style.getPropertyValue("opacity")).toBe("0");
      await act(async () => void touch(view.row("d"), "touchcancel"));
      expect(marker()).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("aims moves and the drop without a browser hit test", async () => {
    const view = await mount(["a", "b", "c", "d"].map(bot));
    try {
      await view.hold("d");
      const hitTest = vi.spyOn(document, "elementFromPoint");
      await view.moveOver(view.row("a"), view.row("d"));
      await view.moveOver(view.row("b"), view.row("d"));
      expect(view.marked()).toBe("b:top");
      await act(async () => void touch(view.row("d"), "touchend"));
      expect(hitTest).not.toHaveBeenCalled();
      expect(view.order()).toEqual(["a", "d", "b", "c"]);
    } finally {
      await view.unmount();
    }
  });

  it("re-measures drop targets when a row leaves mid-drag", async () => {
    const view = await mount(["a", "b", "c", "d"].map(bot));
    try {
      await view.hold("a");
      await view.moveOver(view.row("c"), view.row("a"));
      expect(view.marked()).toBe("c:bottom");
      const cOld = view.row("c").getBoundingClientRect();
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "bot.deleted", botId: "b" }),
        lastEventId: "c1",
      }));
      await vi.waitFor(() => expect(view.order()).toEqual(["a", "c", "d"]));
      // d now sits where c was
      await view.moveOver(view.row("d"), view.row("a"), (cOld.top + cOld.bottom) / 2);
      expect(view.marked()).toBe("d:bottom");
    } finally {
      await view.unmount();
    }
  });

  it("lets a short tap open the chat and never clicks after a drop", async () => {
    const view = await mount(["a", "b", "c"].map(bot));
    const selected = () => view.host.querySelector("output")?.getAttribute("data-selected");
    try {
      await act(async () => void touch(view.row("c"), "touchstart"));
      await act(async () => void vi.advanceTimersByTime(120));
      const tapEnd = touch(view.row("c"), "touchend");
      expect(tapEnd.defaultPrevented).toBe(false);
      await act(async () => (view.row("c") as HTMLElement).click());
      expect(selected()).toBe("c");
      expect(view.lifted()).toBeNull();

      await view.hold("a");
      expect(view.lifted()).toBe("a");
      await view.moveOver(view.row("b"), view.row("a"));
      const dropEnd = touch(view.row("a"), "touchend");
      await act(async () => {});
      expect(dropEnd.defaultPrevented).toBe(true);
      expect(selected()).toBe("c");
    } finally {
      await view.unmount();
    }
  });

  it("treats a move before the hold as a scroll, not a drag", async () => {
    const view = await mount(["a", "b", "c"].map(bot));
    try {
      await act(async () => void touch(view.row("a"), "touchstart", 100, 100));
      const scroll = touch(view.row("a"), "touchmove", 100, 120);
      await act(async () => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));
      expect(scroll.defaultPrevented).toBe(false);
      expect(view.lifted()).toBeNull();
      expect(hapticTick).not.toHaveBeenCalled();
      await act(async () => void touch(view.row("a"), "touchend"));

      await view.hold("a");
      expect(view.lifted()).toBe("a");
    } finally {
      await view.unmount();
    }
  });

  it("puts the row back on touchcancel or a drop outside the list", async () => {
    const view = await mount(["a", "b", "c"].map(bot));
    try {
      await view.hold("a");
      await view.moveOver(view.row("c"), view.row("a"));
      expect(view.marked()).toBe("c:bottom");
      await act(async () => void touch(view.row("a"), "touchcancel"));
      expect(view.lifted()).toBeNull();
      expect(view.marked()).toBeNull();
      expect(view.order()).toEqual(["a", "b", "c"]);

      await view.hold("a");
      expect(view.lifted()).toBe("a");
      await view.moveOver(view.row("c"), view.row("a"));
      await view.moveOver(document.body, view.row("a"), 900);
      expect(view.marked()).toBeNull();
      await act(async () => void touch(view.row("a"), "touchend"));
      expect(view.lifted()).toBeNull();
      expect(view.order()).toEqual(["a", "b", "c"]);
      expect(window.localStorage.getItem(SIDEBAR_ORDER_KEY)).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("ends the press when the pressed child leaves the DOM", async () => {
    const view = await mount(["a", "b", "c"].map(bot));
    try {
      const child = view.row("a").firstElementChild!;
      await act(async () => void touch(child, "touchstart"));
      child.remove();
      await act(async () => void vi.advanceTimersByTime(LONG_PRESS_MS));
      expect(view.lifted()).toBe("a");
      await act(async () => void touch(child, "touchend"));
      expect(view.lifted()).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("keeps the phone swipe from switching bots while a row is lifted", async () => {
    const onSelect = vi.fn();
    const view = await mount(["a", "b", "c"].map(bot), createElement(SwipeStage, { onSelect }));
    try {
      await view.hold("a");
      expect(view.lifted()).toBe("a");
      for (const x of [80, 40, 0]) {
        under = view.row("b");
        expect(touch(view.row("a"), "touchmove", x, 100).defaultPrevented).toBe(true);
      }
      await act(async () => void touch(view.row("a"), "touchend", 0, 100));
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });
});
