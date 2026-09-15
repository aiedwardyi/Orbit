// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { persistPreference } from "@/lib/i18n";
import { formatTime, StoreProvider } from "@/state/store";

import { Sidebar } from "./Sidebar";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

const bot = (id: string) => ({ id, threadId: `${id}-thread`, name: id, messages: [] });

// happy-dom drag events carry no dataTransfer, and the row handlers write to it.
const fire = (target: Element, type: string) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData: () => {} } });
  target.dispatchEvent(event);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sidebar drag to reorder", () => {
  it("never revives a drag when a dragover lands after its dragend", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (path: string) =>
      path === "/api/bots"
        ? new Response(JSON.stringify({ bots: ["a", "b", "c"].map(bot), groups: [] }))
        : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const rows = () => host.querySelectorAll('[draggable="true"]');
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

describe("Sidebar row time", () => {
  it.each(["en", "ko"] as const)("follows the %s UI language like the chat", async (locale) => {
    const at = Date.UTC(2026, 8, 12, 16, 36);
    const a = { ...bot("a"), messages: [{ id: "m", role: "bot", kind: "text", text: "hi", at }], activeLeafId: "m" };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (path: string) =>
      new Response(JSON.stringify(path === "/api/bots" ? { bots: [a], groups: [] } : {}), { status: path === "/api/bots" ? 200 : 404 })));
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
        if (path === "/api/bots")
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
    const rows = () => host.querySelectorAll('[draggable="true"]');
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
      await vi.waitFor(() => expect(orderPuts).toEqual([["g-b", "g-a"]]));

      // Drag back up: the rows swap again, mirroring the QA opposite-drag pair.
      const [top, bottom] = rows();
      await act(async () => fire(bottom!, "dragstart"));
      await act(async () => fire(top!, "dragover"));
      expect(dropLine()).not.toBeNull();
      await act(async () => fire(top!, "drop"));
      await act(async () => fire(bottom!, "dragend"));
      expect(names()[0]).toContain("Worker");
      expect(names()[1]).toContain("Chit Chat");
      await vi.waitFor(() =>
        expect(orderPuts).toEqual([
          ["g-b", "g-a"],
          ["g-a", "g-b"],
        ]),
      );
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
        if (path === "/api/bots")
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
    const rows = () => host.querySelectorAll('[draggable="true"]');
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
        if (path === "/api/bots")
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
      options: [{ id: "muse-spark-1.3", label: "Meta Muse 1.3" }],
    },
  };

  async function renderSidebar(payload: { bots: unknown[]; groups: unknown[] }) {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/bots") return new Response(JSON.stringify(payload));
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
      // SAFETY: the unread dot is size-2, so any size-1.5 round span with
      // an explicit accent color is the engine dot.
      const dots = [...host.querySelectorAll(".size-1\\.5")];
      expect(dots.some((d) => d.getAttribute("style")?.includes("background-color"))).toBe(true);
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
