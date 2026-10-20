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

const days = Array.from({ length: 14 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 8, 17 + index));
  return date.toISOString().slice(0, 10);
});
const zeros = Array.from({ length: 14 }, () => 0);
const phone = zeros.map(() => ({ count: 0, minutes: 0 }));
const now = Date.parse("2026-10-12T12:00:00Z");

function peopleStats(people: unknown[]) {
  return { now, days, pcs: [], people };
}

const ownerStats = peopleStats([
  {
    id: "ada",
    name: "Ada",
    online: true,
    lastSeen: now,
    pcs: [
      { label: "aaaaaaaaaaaaaaaa", name: "Field", online: true },
      { label: "bbbbbbbbbbbbbbbb", name: "Studio", online: false },
    ],
    hours: [...zeros.slice(0, 7), 1, 1, 1, 1, 1, 1, 1.5],
    phone,
  },
  {
    id: "bea",
    name: "Bea",
    online: false,
    lastSeen: now - 3 * 60 * 60 * 1000,
    pcs: [{ label: "cccccccccccccccc", name: "Spare", online: false }],
    hours: [...zeros.slice(0, 13), 1],
    phone,
  },
]);

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
  return createElement(Fragment, null, state.appSettingsOpen && createElement(SettingsModal), createElement("output", null, state.appSettingsSection));
}

describe("Team settings", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let signedIn = true;
  let syncEmail: string | null = null;
  let teamStatus = 200;
  let teamBody = ownerStats;

  beforeEach(() => {
    signedIn = true;
    syncEmail = null;
    teamStatus = 200;
    teamBody = ownerStats;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/google-account") return Response.json(signedIn ? { state: "signed-in", email: "owner@example.com" } : { state: "signed-out" });
      if (path === "/api/google-sync") {
        return Response.json(syncEmail
          ? { state: "ready", email: syncEmail, boundEmail: null, join: null, progress: null, lastSyncAt: null }
          : { state: "signed-out", email: null, boundEmail: null, join: null, progress: null, lastSyncAt: null });
      }
      if (path === "/api/phone-relay/status") return Response.json({ configured: false, available: false });
      if (path === "/api/remote-link") return Response.json({ url: null });
      if (path === "/api/key-uses") return Response.json({ uses: {} });
      if (path === "/api/team") return Response.json(teamBody, { status: teamStatus });
      return Response.json({ error: "no route" }, { status: 404 });
    }));
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
    await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(SettingsView, { section })))));
  }

  function labels() {
    return [...host.querySelectorAll("nav button")].map((button) => button.getAttribute("aria-label"));
  }

  it("shows Team after Usage for the owner, with one card per person", async () => {
    await render();
    await vi.waitFor(() => expect(labels()).toContain("Team"));
    expect(labels()).toEqual(["Account", "General", "Connections", "Themes", "Usage", "Team", "Model index", "Shortcuts"]);
    const team = [...host.querySelectorAll("nav button")].find((button) => button.getAttribute("aria-label") === "Team");
    await act(async () => team!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(host.textContent).toContain("Ada"));
    expect(host.textContent).toContain("Team · 8.5h in 7 days · 1 online");
    expect(host.textContent).toContain("Online");
    expect(host.textContent).not.toContain("PCs");
    expect(host.textContent).toContain("Bea");
    expect(host.textContent).toContain("3h ago");
    expect(host.querySelector("[title='Hours Wink was open']")).not.toBeNull();
    const bar = host.querySelector("article button");
    await act(async () => bar!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.textContent).toContain("online");
  });

  it("shows an empty team when the owner has no teammates", async () => {
    teamBody = peopleStats([]);
    await render();
    await vi.waitFor(() => expect(labels()).toContain("Team"));
    const team = [...host.querySelectorAll("nav button")].find((button) => button.getAttribute("aria-label") === "Team");
    await act(async () => team!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(host.textContent).toContain("No teammates yet."));
    expect(team!.getAttribute("aria-current")).toBe("page");
    expect([...host.querySelectorAll("nav button")].find((button) => button.getAttribute("aria-label") === "General")!.getAttribute("aria-current")).toBeNull();
  });

  it("says No mobile today when there were no phone visits", async () => {
    await render();
    await vi.waitFor(() => expect(labels()).toContain("Team"));
    const team = [...host.querySelectorAll("nav button")].find((button) => button.getAttribute("aria-label") === "Team");
    await act(async () => team!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(host.textContent).toContain("Ada"));
    expect(host.textContent).toContain("No mobile today");
    expect(host.textContent).not.toContain("Phone");
  });

  it("hides Team when the server says not owner", async () => {
    teamStatus = 403;
    await render();
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some((call) => call[0] === "/api/team")).toBe(true));
    expect(labels()).not.toContain("Team");
  });

  it("hides Team with no Google session", async () => {
    signedIn = false;
    await render();
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some((call) => call[0] === "/api/google-account")).toBe(true));
    expect(labels()).not.toContain("Team");
    expect(vi.mocked(fetch).mock.calls.some((call) => call[0] === "/api/team")).toBe(false);
  });

  it("shows Team when the owner signs in and hides it on sign-out", async () => {
    signedIn = false;
    const account = {
      signIn: vi.fn(async () => {
        signedIn = true;
        syncEmail = "owner@example.com";
        return { ok: true as const, email: "owner@example.com" };
      }),
      cancel: vi.fn(async () => undefined),
      signOut: vi.fn(async () => {
        signedIn = false;
        syncEmail = null;
        return { ok: true as const };
      }),
    };
    vi.stubGlobal("ogb", { platform: "win32", googleAccount: account });
    await render();
    const signIn = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Google sign-in");
    await vi.waitFor(() => expect(signIn()).toBeTruthy());
    expect(labels()).not.toContain("Team");
    await act(async () => signIn()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(labels()).toContain("Team"));
    const team = () => [...host.querySelectorAll("nav button")].find((button) => button.getAttribute("aria-label") === "Team");
    await act(async () => team()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(host.textContent).toContain("Ada"));
    const accountNav = [...host.querySelectorAll("nav button")].find((button) => button.getAttribute("aria-label") === "Account");
    await act(async () => accountNav!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const signOut = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Sign out");
    await vi.waitFor(() => expect(signOut()).toBeTruthy());
    await act(async () => signOut()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(labels()).not.toContain("Team"));
    expect(host.textContent).not.toContain("Ada");
  });
});
