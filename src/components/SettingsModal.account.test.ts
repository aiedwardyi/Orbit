// @vitest-environment happy-dom
import { act, createElement, Fragment, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { StoreProvider, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

const config: ConfigStatus = {
  composio: { configured: false },
  gemini: { configured: false },
  box: { configured: false },
  vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 5 },
  localVm: { mode: "shared", maxInstances: 1 },
  profile: { name: "Edward", email: "" },
  features: { skillRecorder: false, showToolCalls: false },
};

class FakeEventSource {
  onmessage = null;
  close() {}
}

function SettingsView({ section }: { section: AppSettingsSection }) {
  const { state, dispatch } = useStore();
  useEffect(() => {
    dispatch({ type: "configStatus", config });
    dispatch({ type: "toggleAppSettings", open: true, section });
  }, [dispatch, section]);
  return createElement(Fragment, null,
    state.appSettingsOpen && createElement(SettingsModal),
    createElement("output", null, state.appSettingsSection),
  );
}

describe("Account settings", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let phoneAvailable: boolean;
  let url: string;
  const request = vi.fn();

  beforeEach(() => {
    phoneAvailable = true;
    url = "https://desktop.wink.test/remote?key=fixture";
    request.mockReset();
    request.mockImplementation(async (path: string) => {
      if (path === "/api/google-sync") return Response.json({ state: "signed-out" });
      if (path === "/api/phone-relay/status") return Response.json({ configured: false, available: phoneAvailable });
      if (path === "/api/remote-link") return Response.json({ url: url || null });
      if (path === "/api/key-uses") return Response.json({ uses: {} });
      return Response.json({ error: `no route ${path}` }, { status: 404 });
    });
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("ogb", undefined);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem("omb-locale", "en");
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function render(section: AppSettingsSection = "account") {
    await act(async () => root.render(createElement(I18nProvider, null,
      createElement(StoreProvider, null, createElement(SettingsView, { section })),
    )));
    return host.querySelector(".overflow-y-auto")!;
  }

  it("orders Phone after Connections with the matching icons", async () => {
    await render();
    const buttons = [...host.querySelectorAll("nav button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Account", "General", "Connections", "Phone", "Themes", "Usage", "Model Index", "Shortcuts",
    ]);
    expect(buttons.map((button) => button.querySelector("svg")?.classList.item(1))).toEqual([
      "lucide-user", "lucide-settings", "lucide-key-round", "lucide-smartphone", "lucide-palette", "lucide-coins", "lucide-chart-scatter", "lucide-keyboard",
    ]);
  });

  it("keeps Profile and Sync without phone sections or their requests", async () => {
    const pane = await render();
    const cards = [...pane.children];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector("#settings-profile-name")).not.toBeNull();
    expect(cards[0].textContent).toContain("Profile");
    expect(cards[1].firstElementChild?.textContent).toBe("Sync");
    expect(cards[1].textContent).toContain("Syncing across your PCs is off.");
    expect(pane.querySelector("[data-phone-settings]")).toBeNull();
    expect(pane.querySelector("[data-phone-access-setup]")).toBeNull();
    expect(request.mock.calls.some(([path]) => path === "/api/remote-link" || path === "/api/phone-relay/status")).toBe(false);
  });

  it("renders Sync as one card, not a card inside a card", async () => {
    const pane = await render();
    const sync = pane.children[1];
    expect(sync.querySelector(".bg-card")).toBeNull();
    expect(sync.children[1]?.textContent).toBe("Syncing across your PCs is off.");
  });

  it("labels Account in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    await render();
    expect(host.querySelector('nav [aria-current="page"]')?.getAttribute("aria-label")).toBe("계정");
  });

  it("leaves General without Profile", async () => {
    const pane = await render("general");
    expect(pane.querySelector("#settings-profile-name")).toBeNull();
    expect(pane.textContent).not.toContain("Profile");
    expect(pane.textContent).toContain("Language");
    expect(pane.textContent).not.toContain("Work Steps");
    expect(pane.textContent).toContain("Advanced");
  });

  it("leaves General without the Memory card", async () => {
    const pane = await render("general");
    expect([...pane.children].map((card) => card.firstElementChild?.textContent)).not.toContain("Memory");
    expect(pane.textContent).not.toContain("Auto Notes");
    expect(pane.querySelector('[aria-label="Auto Notes"]')).toBeNull();
  });

  it("leaves Connections without phone components or their requests", async () => {
    const pane = await render("connections");
    expect(pane.textContent).not.toContain("Phone Link");
    expect(pane.textContent).not.toContain("Phone Access");
    expect(request.mock.calls.some(([path]) => path === "/api/remote-link")).toBe(false);
    expect(request.mock.calls.some(([path]) => path === "/api/phone-relay/status")).toBe(false);
  });

  it("preserves the Sync deep link to Account", async () => {
    const pane = await render("sync");
    expect(host.querySelector('nav [aria-current="page"]')?.getAttribute("aria-label")).toBe("Account");
    expect(pane.querySelector("#settings-profile-name")).not.toBeNull();
    expect(host.querySelector("output")?.textContent).toBe("sync");
  });

  it("lands the companion deep link on Phone and reveals relay setup on demand", async () => {
    const pane = await render("companion");
    expect(host.querySelector('nav [aria-current="page"]')?.getAttribute("aria-label")).toBe("Phone");
    expect(pane.querySelector("[data-phone-settings]")).not.toBeNull();
    expect(pane.querySelector("#settings-profile-name")).toBeNull();
    expect(pane.querySelector("[data-phone-access-setup]")).toBeNull();
    const relay = [...pane.querySelectorAll("button")].find((node) => node.textContent === "Have a relay setup code?")!;
    await act(async () => relay.click());
    expect(pane.querySelector("[data-phone-access-setup]")).not.toBeNull();
  });

  it("shows Phone even on a packaged PC without the legacy companion service", async () => {
    vi.stubGlobal("ogb", { platform: "win32", packaged: true });
    phoneAvailable = false;
    url = "";
    const pane = await render("companion");
    expect(host.querySelector('nav [aria-current="page"]')?.getAttribute("aria-label")).toBe("Phone");
    expect(pane.querySelectorAll("ol > li")).toHaveLength(3);
  });
});
