// @vitest-environment happy-dom
// A bot or room row whose chat waits on the person glows in the theme
// accent and says so in its accessible name; a collapsed section that hides
// such a row glows instead.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SIDEBAR_COLLAPSED_KEY, SIDEBAR_COLLAPSED_SECTIONS_KEY } from "@/lib/sidebar-preferences";
import { StoreProvider } from "@/state/store";

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
const run = (id: string, sourceThreadId: string, patch: { status?: string; runOn?: string; threadId?: string; seenAt?: number } = {}) => ({
  id,
  routineId: `routine-${id}`,
  routineName: id,
  botId: id,
  runOn: "maus",
  scheduledFor: 1,
  status: "completed",
  manual: false,
  sourceThreadId,
  createdAt: 1,
  ...patch,
});

afterEach(() => {
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_SECTIONS_KEY);
  window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountSidebar(payload: { bots: unknown[]; groups: unknown[] }, runs: unknown[] = []) {
  vi.stubGlobal("EventSource", FakeEventSource);
  const fetchMock = vi.fn(async (path: string, _init?: RequestInit) =>
    path === "/api/bots?messages=200"
      ? new Response(JSON.stringify(payload))
      : path === "/api/routines"
        ? new Response(JSON.stringify({ routines: [], runs }))
        : new Response(JSON.stringify({ error: "not in this test" }), { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
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
    fetchMock,
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

  it("fades the whole ring and glow fully out and back in", () => {
    const rule = css.match(/\.needs-you-glow \{(.*?)\}/s)?.[1] ?? "";
    expect(rule).not.toContain("box-shadow");
    expect(css).toContain("@keyframes needs-you-pulse");
    const pulse = css.slice(css.indexOf("@keyframes needs-you-pulse"));
    expect(pulse).toMatch(/opacity:\s*0\b/);
  });

  it("pulses while a fired routine is unseen, on rows, rail, collapsed and hidden sections, and settles on open", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    window.localStorage.setItem(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify(["section:Ops"]));
    const runs = [
      run("ringer", "ringer-thread"),
      run("room", "room-thread", { status: "waiting" }),
      run("hidden", "hidden-ringer-thread", { status: "running" }),
      run("seen", "seen-thread", { seenAt: 5 }),
      run("missed", "missed-thread", { status: "missed" }),
      run("queued", "queued-thread", { status: "queued" }),
      run("old", "old-thread", { threadId: "old-thread" }),
      run("cloud", "cloud-thread", { runOn: "cloud" }),
    ];
    const payload = {
      bots: [
        { ...bot("calm", []), pinned: true },
        bot("ringer", []),
        bot("seen", []),
        bot("missed", []),
        bot("queued", []),
        bot("old", []),
        bot("cloud", []),
        bot("hidden-ringer", [], "Ops"),
        bot("other", [], "Ops"),
      ],
      groups: [{ id: "room", threadId: "room-thread", name: "War room", memberIds: ["ringer"], messages: [] }],
    };
    const { host, fetchMock, unmount } = await mountSidebar(payload, runs);
    try {
      await vi.waitFor(() => expect(rowControl(host, "ringer").row?.getAttribute("data-sidebar-needs-you")).toBe("true"));
      for (const id of ["ringer", "room"]) {
        const { control } = rowControl(host, id);
        expect(control?.className).toContain("needs-you-glow");
        expect(control?.querySelector(".sr-only")?.textContent).toBe(": routine rang");
      }
      for (const id of ["calm", "seen", "missed", "queued", "old", "cloud"]) {
        expect(rowControl(host, id).row?.hasAttribute("data-sidebar-needs-you"), id).toBe(false);
      }
      const header = host.querySelector('[data-section="Ops"] button');
      expect(header?.getAttribute("data-sidebar-needs-you")).toBe("true");
      expect(header?.className).toContain("needs-you-glow");

      await act(async () => host.querySelector<HTMLElement>('[data-sidebar-row-id="ringer"] [role="button"]')!.click());
      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/routine-runs/ringer/seen", expect.objectContaining({ method: "POST" })),
      );
      expect(fetchMock).not.toHaveBeenCalledWith("/api/routine-runs/room/seen", expect.anything());
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "routine.run", run: { ...runs[0], seenAt: 9 } }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(rowControl(host, "ringer").row?.hasAttribute("data-sidebar-needs-you")).toBe(false));
      expect(rowControl(host, "room").row?.getAttribute("data-sidebar-needs-you")).toBe("true");
    } finally {
      await unmount();
    }

    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    const rail = await mountSidebar(payload, runs);
    try {
      await vi.waitFor(() => expect(rowControl(rail.host, "ringer").control?.getAttribute("aria-label")).toBe("ringer: routine rang"));
      expect(rowControl(rail.host, "ringer").control?.className).toContain("needs-you-glow");
      const expand = rail.host.querySelector('button[aria-label="Expand sidebar, a bot has a question"]');
      expect(expand?.className).toContain("needs-you-glow");
    } finally {
      await rail.unmount();
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
