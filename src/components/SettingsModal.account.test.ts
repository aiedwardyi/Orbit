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

  it("orders the seven visible pages with Account and General icons", async () => {
    await render();
    const buttons = [...host.querySelectorAll("nav button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Account", "General", "Connections", "Themes", "Usage", "Model index", "Shortcuts",
    ]);
    expect(buttons.map((button) => button.querySelector("svg")?.classList.item(1))).toEqual([
      "lucide-user", "lucide-settings", "lucide-key-round", "lucide-palette", "lucide-coins", "lucide-chart-scatter", "lucide-keyboard",
    ]);
  });

  it("renders Profile, titled Sync, then both phone sections in one card", async () => {
    const pane = await render();
    const cards = [...pane.children];
    expect(cards).toHaveLength(3);
    expect(cards[0].querySelector("#settings-profile-name")).not.toBeNull();
    expect(cards[0].textContent).toContain("Profile");
    expect(cards[1].firstElementChild?.textContent).toBe("Sync");
    expect(cards[1].textContent).toContain("Your bots, memory and chats on all your PCs.");
    expect([...cards[2].children].map((section) => section.firstElementChild?.textContent)).toEqual([
      "Phone access from anywhere", "Phone link",
    ]);
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
    expect(pane.textContent).toContain("Show work steps");
  });

  it("leaves Connections without phone components or their requests", async () => {
    const pane = await render("connections");
    expect(pane.textContent).not.toContain("Phone link");
    expect(pane.textContent).not.toContain("Phone access from anywhere");
    expect(request.mock.calls.some(([path]) => path === "/api/remote-link")).toBe(false);
    expect(request.mock.calls.some(([path]) => path === "/api/phone-relay/status")).toBe(false);
  });

  it("hides the phone card when both phone components return nothing", async () => {
    phoneAvailable = false;
    url = "";
    const pane = await render();
    const phone = pane.lastElementChild!;
    expect(phone.matches(":empty")).toBe(true);
    expect(phone.classList.contains("empty:hidden")).toBe(true);
  });

  it.each(["relay", "link"])("keeps the phone card when only %s is available", async (available) => {
    phoneAvailable = available === "relay";
    url = available === "link" ? url : "";
    const pane = await render();
    expect(pane.children).toHaveLength(3);
    expect(pane.lastElementChild?.children).toHaveLength(1);
    expect(pane.lastElementChild?.textContent).toContain(available === "relay" ? "Phone access from anywhere" : "Phone link");
  });

  it.each(["sync", "companion"] as const)("renders the %s deep link as Account", async (section) => {
    const pane = await render(section);
    expect(host.querySelector('nav [aria-current="page"]')?.getAttribute("aria-label")).toBe("Account");
    expect(pane.querySelector("#settings-profile-name")).not.toBeNull();
    expect(host.querySelector("output")?.textContent).toBe(section);
  });
});
