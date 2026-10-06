import "./ProfileFields.test-dom.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { en, ko } from "@/lib/i18n-catalog";
import type { Bot } from "@/state/store";

const here = dirname(fileURLToPath(import.meta.url));
const sidebar = readFileSync(join(here, "Sidebar.tsx"), "utf8");

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });

type ApiResult = {
  configured?: boolean;
  syncChats?: boolean;
  folder?: string | null;
  bot?: { id: string; hidden: boolean; name: string };
};

type ApiCall = { path: string; method: string; body: string };

const calls: ApiCall[] = [];
let sync = { configured: false, syncChats: false };
let syncAnswer: Promise<void> | null = null;
let bots: Bot[] = [];

function bot(id: string, name: string, hidden: boolean): Bot {
  return {
    id,
    threadId: `t-${id}`,
    name,
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude", mode: "automatic" },
    messages: [],
    hidden,
  };
}

function textBody(body: BodyInit | null | undefined): string {
  if (body == null || body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams) return "";
  return String(body);
}

// oxlint-disable-next-line anti-slop/no-module-mocking -- The sidebar reads the shared store; this harness only varies bots and profile sync.
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: async (path: string, init?: RequestInit): Promise<ApiResult> => {
      calls.push({ path, method: init?.method ?? "GET", body: textBody(init?.body) });
      if (path === "/api/profile-sync") await syncAnswer;
      if (path === "/api/profile-sync") return { configured: sync.configured, syncChats: sync.syncChats, folder: sync.configured ? "D:/Orbit" : null };
      if (path.startsWith("/api/bots/") && init?.method === "PATCH") return { bot: { id: "bo", hidden: false, name: "Bo" } };
      return {};
    },
    useStore: () => ({
      state: {
        bots,
        groups: [],
        selectedId: "ada",
        activeView: "chat",
        instances: [],
        routineRuns: [],
        terminalAttention: {},
        terminalPanes: {},
        config: {
          composio: { configured: false },
          box: { configured: false },
          vps: { configured: false, sshAlias: "" },
          rooms: { turnTimeoutMinutes: 5 },
          localVm: { mode: "shared", maxInstances: 1 },
          profile: { name: "Eddie", email: "" },
        },
        mascotMotion: null,
      },
      dispatch: () => undefined,
      refreshInstances: async () => undefined,
    }),
  };
});

// oxlint-disable-next-line anti-slop/no-module-mocking -- The update banner needs a desktop bridge this test does not open.
vi.mock("@/lib/updater", () => ({
  useUpdaterState: () => null,
  useManualCheck: () => ({ acknowledged: true, check: () => undefined }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Desktop capability probes need a packaged host.
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "win32", homeDir: "C:/Users/eddie" },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

import { Sidebar } from "./Sidebar";

function buttonByText(label: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((node) => {
    const text = node.textContent?.trim() ?? "";
    return text === label || text.startsWith(label) || node.getAttribute("aria-label") === label;
  });
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button "${label}" missing`);
  return found;
}

async function renderSidebar() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(Sidebar, { open: true, onClose: () => undefined })));
  });
  return { host, root };
}

async function openMenu(name: string) {
  const row = [...document.querySelectorAll("[role='button']")].find((node) => node.textContent?.includes(name));
  if (!(row instanceof HTMLElement)) throw new Error(`row ${name} missing`);
  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
  });
}

afterEach(() => {
  document.body.replaceChildren();
  calls.length = 0;
  sync = { configured: false, syncChats: false };
  syncAnswer = null;
  bots = [];
  localStorage.setItem("omb-locale", "en");
});

describe("bot archive is not a user action", () => {
  it("drops the row and menu archive actions and keeps restore behind the archived entry", () => {
    expect(en["chrome.deleteBotBody"]).toBe("This permanently deletes {name} and its conversation. This cannot be undone.");
    expect(en["chrome.deleteBotBodyAllPcs"]).toBe(
      "This permanently deletes {name} and its conversation on all your PCs. This cannot be undone.",
    );
    expect(ko["chrome.deleteBotBodyAllPcs"]).toBe("{name} 및 대화를 모든 PC에서 완전히 삭제합니다. 되돌릴 수 없습니다.");
    expect(sidebar).not.toContain('t("chrome.archive")');
    expect(sidebar).not.toContain("chrome.archiveBot");
    expect(sidebar).toContain("archivedBots.length > 0");
    expect(sidebar).toContain("JSON.stringify({ hidden: false })");
    expect(sidebar).toContain('deleteReach === "every-pc" ? "chrome.deleteBotBodyAllPcs" : "chrome.deleteBotBody"');
  });

  it("hides Archived bots at zero, shows it at one, and restore unhides that bot", async () => {
    bots = [bot("ada", "Ada", false), bot("bo", "Bo", true)];
    const { root } = await renderSidebar();
    try {
      expect(document.querySelector('[aria-label="Archive Ada"]')).toBeNull();
      await openMenu("Ada");
      const menu = document.querySelector("[data-bot-menu]");
      if (!(menu instanceof HTMLElement)) throw new Error("menu missing");
      expect([...menu.querySelectorAll("button")].some((node) => node.textContent?.trim() === "Archive")).toBe(false);
      expect(buttonByText("Delete", menu)).toBeTruthy();

      await act(async () => {
        buttonByText("New or share").click();
      });
      await act(async () => {
        buttonByText("Archived bots").click();
      });
      await act(async () => {
        buttonByText("Restore").click();
      });
      expect(calls.some((call) => call.path === "/api/bots/bo" && call.method === "PATCH" && call.body.includes('"hidden":false'))).toBe(true);

      bots = [bot("ada", "Ada", false)];
      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(Sidebar, { open: true, onClose: () => undefined })));
      });
      await act(async () => {
        buttonByText("New or share").click();
      });
      expect([...document.querySelectorAll("button")].some((node) => node.textContent?.includes("Archived bots"))).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("says a delete reaches every PC only when profile sync is on", async () => {
    bots = [bot("ada", "Ada", false)];
    sync = { configured: true, syncChats: true };
    const first = await renderSidebar();
    try {
      await openMenu("Ada");
      await act(async () => {
        buttonByText("Delete", document.querySelector("[data-bot-menu]") ?? document).click();
      });
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("on all your PCs");
      });
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

      sync = { configured: true, syncChats: false };
      await openMenu("Ada");
      await act(async () => {
        buttonByText("Delete", document.querySelector("[data-bot-menu]") ?? document).click();
      });
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("This permanently deletes Ada and its conversation. This cannot be undone.");
      });
      expect(document.body.textContent).not.toContain("on all your PCs");
    } finally {
      await act(async () => first.root.unmount());
    }

    localStorage.setItem("omb-locale", "ko");
    sync = { configured: true, syncChats: true };
    const second = await renderSidebar();
    try {
      await openMenu("Ada");
      await act(async () => {
        buttonByText("삭제", document.querySelector("[data-bot-menu]") ?? document).click();
      });
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Ada 및 대화를 모든 PC에서 완전히 삭제합니다.");
      });
    } finally {
      await act(async () => second.root.unmount());
    }
  });

  it("opens the delete confirm before the sync check answers", async () => {
    bots = [bot("ada", "Ada", false)];
    sync = { configured: true, syncChats: true };
    let answer: (() => void) | undefined;
    syncAnswer = new Promise((resolve) => {
      answer = resolve;
    });
    const view = await renderSidebar();
    try {
      await openMenu("Ada");
      await act(async () => {
        buttonByText("Delete", document.querySelector("[data-bot-menu]") ?? document).click();
      });
      expect(document.body.textContent).toContain("This permanently deletes Ada and its conversation. This cannot be undone.");
      await act(async () => answer?.());
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("on all your PCs");
      });
    } finally {
      await act(async () => view.root.unmount());
    }
  });
});
