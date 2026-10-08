// @vitest-environment happy-dom
// A bot or room row whose chat waits on the person glows in the theme
// accent and says so in its accessible name; a collapsed section that hides
// such a row glows instead.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SIDEBAR_COLLAPSED_KEY, SIDEBAR_COLLAPSED_SECTIONS_KEY } from "@/lib/sidebar-preferences";
import { StoreProvider } from "@/state/store";

import { Sidebar } from "./Sidebar";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

const askCard = (id: string) => ({
  id,
  role: "bot",
  kind: "options",
  at: 10,
  card: { title: "Your bot has a question", subtitle: "Prod or staging?", options: ["Prod", "Staging"], askUser: true },
});
const reply = (id: string) => ({ id, role: "user", kind: "text", at: 20, text: "Prod" });
const approval = (id: string) => ({
  id,
  role: "bot",
  kind: "options",
  at: 10,
  card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" },
});
// an undefined section drops out of the JSON the fake server answers with
const bot = (id: string, messages: unknown[], section?: string) => ({ id, threadId: `${id}-thread`, name: id, messages, section });

afterEach(() => {
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_SECTIONS_KEY);
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountSidebar(payload: { bots: unknown[]; groups: unknown[] }) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string) =>
    path === "/api/bots?messages=200"
      ? new Response(JSON.stringify(payload))
      : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 })));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} }))),
  );
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

const rowControl = (host: HTMLElement, id: string) => {
  const row = host.querySelector(`[data-sidebar-row-id="${id}"]`);
  return { row, control: row?.querySelector('[role="button"], button') ?? null };
};

describe("Sidebar needs-you glow", () => {
  it("glows bot and room rows with an open question or approval, and names it", async () => {
    const room = {
      id: "room",
      threadId: "room-thread",
      name: "War room",
      memberIds: ["asker"],
      messages: [{ ...askCard("room-ask"), from: { botId: "asker", name: "asker", color: "blue" } }],
    };
    const { host, unmount } = await mountSidebar({
      bots: [
        bot("asker", [askCard("ask-1")]),
        bot("answered", [askCard("ask-2"), reply("reply-2")]),
        bot("approver", [approval("approval-1")]),
      ],
      groups: [room],
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="room"]')).not.toBeNull());
      for (const id of ["asker", "approver", "room"]) {
        const { row, control } = rowControl(host, id);
        expect(row?.getAttribute("data-sidebar-needs-you")).toBe("true");
        expect(control?.className).toContain("needs-you-glow");
        expect(control?.className).not.toContain("filter");
        expect(control?.querySelector(".sr-only")?.textContent).toBe(", has a question");
      }
      const quiet = rowControl(host, "answered");
      expect(quiet.row?.hasAttribute("data-sidebar-needs-you")).toBe(false);
      expect(quiet.control?.className).not.toContain("needs-you-glow");
      expect(quiet.control?.querySelector(".sr-only")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("glows the collapsed section header that hides an asking row", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify(["section:Ops"]));
    const { host, unmount } = await mountSidebar({
      bots: [bot("calm", [], "Calm"), bot("hidden-asker", [askCard("ask-h")], "Ops"), bot("other", [], "Ops")],
      groups: [],
    });
    try {
      const header = () => host.querySelector('[data-section="Ops"] button');
      await vi.waitFor(() => expect(header()).not.toBeNull());
      expect(host.querySelector('[data-sidebar-row-id="hidden-asker"]')).toBeNull();
      expect(header()?.getAttribute("data-sidebar-needs-you")).toBe("true");
      expect(header()?.className).toContain("needs-you-glow");
      expect(header()?.getAttribute("aria-label")).toContain("a bot here has a question");
      expect(host.querySelector('[data-section="Calm"] button')?.hasAttribute("data-sidebar-needs-you")).toBe(false);
    } finally {
      await unmount();
    }
  });

  it("names the icon-only row and glows the expand control in a collapsed sidebar", async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    const { host, unmount } = await mountSidebar({ bots: [bot("calm", []), bot("asker", [askCard("ask-i")])], groups: [] });
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="asker"]')).not.toBeNull());
      const { control } = rowControl(host, "asker");
      expect(control?.getAttribute("aria-label")).toBe("asker, has a question");
      expect(control?.className).toContain("needs-you-glow");
      expect(rowControl(host, "calm").control?.getAttribute("aria-label")).toBe("calm");
      const expand = host.querySelector('button[aria-label="Expand sidebar, a bot has a question"]');
      expect(expand?.className).toContain("needs-you-glow");
    } finally {
      await unmount();
    }
  });
});
