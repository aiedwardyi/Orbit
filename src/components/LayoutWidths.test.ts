// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, translate } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const { mockState } = vi.hoisted(() => {
  const sampleBot: Bot = {
    id: "bot-1",
    threadId: "t1",
    name: "Scout",
    title: "Chief Coordinator",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
    messages: [],
    cwd: null,
    hidden: true,
  };
  return {
    mockState: {
      appSettingsOpen: false,
      appSettingsSection: "connections",
      bots: [sampleBot],
      groups: [],
      selectedId: "bot-1",
      activeChannelId: null,
      pluginsOpen: true,
      instances: [],
      config: {
        composio: { configured: true, mode: "local" },
        gemini: { configured: false },
        box: { configured: false },
        vps: { configured: false, sshAlias: "" },
        rooms: { turnTimeoutMinutes: 5 },
        localVm: { mode: "shared", maxInstances: 1 },
        opencodeGo: { configured: false },
        profile: { name: "", email: "" },
        features: { skillRecorder: false, showToolCalls: false },
      },
      mascotMotion: null,
    },
  };
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (path === "/api/connectors/catalog") {
        return {
          cards: [
            { slug: "slack", label: "Slack", blurb: "Post updates and read channels", logo: null, domain: "slack.com" },
            { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", logo: null, domain: "github.com" },
          ],
          source: "curated",
          configured: true,
          mode: "managed",
        };
      }
      if (path === "/api/connectors/connected") {
        return { services: {}, authoritative: true };
      }
      if (path === "/api/team-map") {
        return { collaborations: [], queued: [], running: [] };
      }
      return {};
    }),
    useStore: () => ({
      state: mockState,
      dispatch: () => undefined,
      refreshInstances: async () => undefined,
    }),
  };
});

vi.mock("@/lib/updater", () => ({
  useUpdaterState: () => null,
  useManualCheck: () => ({ acknowledged: true, check: () => {} }),
}));

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "win32", homeDir: "/home/user" },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

import { Sidebar } from "./Sidebar";
import { PluginsPanel } from "./PluginsPanel";
import { TeamMapPage } from "./TeamMapPage";

describe("Layout Widths", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    const portal = document.body.querySelector('[role="dialog"]');
    portal?.parentElement?.remove();
  });

  it("archived bots panel uses two columns only when there are two or more archived bots", async () => {
    mockState.bots = [
      {
        id: "bot-1",
        threadId: "t1",
        name: "Scout",
        title: "Chief Coordinator",
        description: "",
        notifications: false,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
        messages: [],
        cwd: null,
        hidden: true,
      },
    ];

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(Sidebar, { open: true, onClose: () => {} })));
    });

    const plusButton = host.querySelector('button[aria-label="' + translate("en", "chrome.newOrShare") + '"]');
    expect(plusButton).toBeTruthy();
    await act(async () => {
      if (plusButton instanceof HTMLElement) plusButton.click();
    });

    const archivedItem = [...host.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes(translate("en", "chrome.archivedBots")),
    );
    expect(archivedItem).toBeTruthy();
    await act(async () => {
      archivedItem?.click();
    });

    const dialog = document.body.querySelector('[role="dialog"][aria-labelledby="archived-bots-title"]');
    expect(dialog).toBeTruthy();

    const countLabel = [...(dialog?.querySelectorAll("div") ?? [])].find(
      (el) => el.textContent?.trim() === translate("en", "chrome.archivedCount", { count: 1 }),
    );
    expect(countLabel).toBeTruthy();

    const listWrapper = countLabel?.nextElementSibling;
    expect(listWrapper).toBeTruthy();
    expect(listWrapper?.className).not.toContain("md:grid-cols-2");
    expect(listWrapper?.className).toBe("grid grid-cols-1 gap-x-8");

    // With two archived bots, two columns should be used
    mockState.bots = [
      mockState.bots[0]!,
      {
        id: "bot-2",
        threadId: "t2",
        name: "Sunny",
        title: "Research Analyst",
        description: "",
        notifications: false,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
        messages: [],
        cwd: null,
        hidden: true,
      },
    ];

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(Sidebar, { open: true, onClose: () => {} })));
    });

    const plusButton2 = host.querySelector('button[aria-label="' + translate("en", "chrome.newOrShare") + '"]');
    expect(plusButton2).toBeTruthy();
    await act(async () => {
      if (plusButton2 instanceof HTMLElement) plusButton2.click();
    });

    const archivedItem2 = [...host.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes(translate("en", "chrome.archivedBots")),
    );
    expect(archivedItem2).toBeTruthy();
    await act(async () => {
      archivedItem2?.click();
    });

    const dialog2 = document.body.querySelector('[role="dialog"][aria-labelledby="archived-bots-title"]');
    expect(dialog2).toBeTruthy();

    const countLabel2 = [...(dialog2?.querySelectorAll("div") ?? [])].find(
      (el) => el.textContent?.trim() === translate("en", "chrome.archivedCount", { count: 2 }),
    );
    expect(countLabel2).toBeTruthy();

    const listWrapper2 = countLabel2?.nextElementSibling;
    expect(listWrapper2).toBeTruthy();
    expect(listWrapper2?.className).toContain("md:grid-cols-2");
  });

  it("connected apps moves second column to lg breakpoint so 800px window gets one column", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(PluginsPanel)));
    });

    const dialog = document.body.querySelector('[role="dialog"][aria-labelledby="connected-apps-title"]');
    expect(dialog).toBeTruthy();

    const sectionLabel = [...(dialog?.querySelectorAll("div") ?? [])].find(
      (el) => el.textContent?.trim() === "Available apps",
    );
    expect(sectionLabel).toBeTruthy();

    const listWrapper = sectionLabel?.nextElementSibling;
    expect(listWrapper).toBeTruthy();
    expect(listWrapper?.className).toContain("lg:grid-cols-2");
    expect(listWrapper?.className).not.toContain("md:grid-cols-2");
  });

  it("team map handoffs section drops max-w-[900px] so right edges line up", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(TeamMapPage)));
    });

    const handoffsTitle = [...host.querySelectorAll("h2")].find(
      (el) => el.textContent?.trim() === translate("en", "teamMap.handoffs"),
    );
    expect(handoffsTitle).toBeTruthy();

    const handoffsSection = handoffsTitle?.closest("section");
    expect(handoffsSection).toBeTruthy();
    expect(handoffsSection?.className).not.toContain("max-w-[900px]");
  });
});
