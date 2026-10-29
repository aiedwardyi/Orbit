import "./ProfileFields.test-dom.ts";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistPreference, I18nProvider } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import { Onboarding } from "./Onboarding";
import { NoEngines } from "./NoEngines";
import { EngineConnect } from "./EngineConnect";

let instances: InstanceInfo[];
let host: HTMLDivElement;
let root: Root | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const refreshInstances = vi.fn(async (_mode?: boolean | "passive") => {});
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances }, refreshInstances }),
}));

const fleet = () => [
  ["claude", "claudeAgent", "Claude"], ["codex", "codex", "Codex"],
  ["grok", "grokAgent", "Grok"], ["antigravity", "antigravityAgent", "Gemini (Antigravity)"],
  ["muse", "museAgent", "Meta Muse"],
].map(([instanceId, driverKind, displayName]): InstanceInfo => ({
  instanceId, driverKind, displayName, snapshot: { state: "unavailable" }, models: { default: "", options: [] },
  install: { command: { win32: `install-${instanceId}`, linux: `install-${instanceId}` },
    signInCommand: `${instanceId} login`, docsUrl: `https://example.com/${instanceId}` },
}));

async function render(view: ReactElement = createElement(Onboarding, { onDone: vi.fn() })) {
  root ??= createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, view)));
}

async function click(label: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

async function connect() {
  await render();
  await click("Connect an Engine");
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(() => {
  instances = fleet();
  host = document.createElement("div");
  document.body.append(host);
  vi.stubGlobal("localStorage", window.localStorage);
  persistPreference("en");
  vi.useFakeTimers();
  Object.assign(window, { ogb: { platform: "win32", openEngineInstall: vi.fn(async () => "running"),
    openEngineSignIn: vi.fn(async () => "running") } });
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ instances })));
  vi.stubGlobal("fetch", fetchMock);
  refreshInstances.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.assign(window, { ogb: undefined });
});

describe("first engine connection", () => {
  it("leads with Claude and hides the unchanged commands behind Show Commands", async () => {
    await connect();
    expect(host.textContent).toContain("Your bots run on an engine. Most people start with Claude.");
    expect(host.textContent).toContain("A window opens and installs Claude. Then sign in with a paid Claude account.");
    expect(host.textContent).toContain("Other Engines");
    for (const name of ["ChatGPT account", "Google account", "Grok account", "Meta account", "Gemini (Antigravity)"]) {
      expect(host.textContent).toContain(name);
    }
    expect(host.querySelector("code")).toBeNull();
    expect(host.textContent).not.toContain("Check again");
    await click("Show Commands");
    expect(host.querySelector("code")?.textContent).toBe("install-claude");
    expect(host.textContent).toContain("View Setup Guide");
    await click("Show Commands");
    expect(host.querySelector("code")).toBeNull();
  });

  it("polls every five seconds after a click and stops on installation, retaining sign-in and ready states", async () => {
    await connect();
    await advance(15000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await click("Install Claude");
    expect(window.ogb!.openEngineInstall).toHaveBeenCalledExactlyOnceWith("claude");
    expect(host.textContent).toContain("Installing Claude…");
    expect(host.textContent).toContain("Finish in the window that opened.");
    await advance(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    instances = instances.map((row) => row.instanceId === "claude" ? { ...row, snapshot: { state: "available", authenticated: false } } : row);
    await advance(1);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/instances?refresh=1");
    expect(host.textContent).toContain("Sign in to Claude");
    expect(host.textContent).not.toContain("Installing Claude…");
    const count = fetchMock.mock.calls.length;
    await advance(15000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
    await click("Sign in to Claude");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/instances/claude/sign-in", expect.objectContaining({ method: "POST", body: '{"device":false}' }));
    expect(window.ogb!.openEngineSignIn).not.toHaveBeenCalled();
    instances = instances.map((row) => row.instanceId === "claude" ? { ...row, snapshot: { state: "available", authenticated: true } } : row);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.textContent).toContain("Claude is ready");
    expect(host.querySelector("code")).toBeNull();
  });

  it("times out at ten minutes, retries with a fresh deadline and still checks on focus", async () => {
    await connect();
    await click("Install Claude");
    await advance(599999);
    expect(host.textContent).toContain("Installing Claude…");
    await advance(1);
    expect(host.textContent).toContain("Didn't finish?");
    const count = fetchMock.mock.calls.length;
    await advance(20000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fetchMock).toHaveBeenCalledTimes(count + 1);
    await click("Try Again");
    expect(window.ogb!.openEngineInstall).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(fetchMock).toHaveBeenCalledTimes(count + 2);
    expect(host.textContent).toContain("Installing Claude…");
  });

  it("keeps polling after a failed recheck, without losing the commands escape", async () => {
    await connect();
    await click("Install Claude");
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await advance(5000);
    expect(host.textContent).toContain("Installing Claude…");
    await advance(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await click("Show Commands");
    expect(host.querySelector("code")).not.toBeNull();
  });

  it.each(["codex", "antigravity", "grok", "muse"])("installs %s through the existing path and uses the same row states", async (id) => {
    await connect();
    const row = host.querySelector(`[data-engine-connect="${id}"]`)!;
    expect(row).not.toBeNull();
    await click("Install", row);
    expect(window.ogb!.openEngineInstall).toHaveBeenCalledExactlyOnceWith(id);
    expect(row.textContent).toContain("Finish in the window that opened.");
    instances = instances.map((instance) => instance.instanceId === id ? { ...instance, snapshot: { state: "available", authenticated: false } } : instance);
    await advance(5000);
    expect(row.textContent).toContain(`Sign in to ${id === "antigravity" ? "Gemini (Antigravity)" : instances.find((item) => item.instanceId === id)!.displayName}`);
  });

  it("keeps independent deadlines and stops probing when the last install completes", async () => {
    await connect();
    await click("Install Claude");
    await advance(10000);
    await click("Install", host.querySelector('[data-engine-connect="codex"]')!);
    instances = instances.map((row) => row.instanceId === "claude" ? { ...row, snapshot: { state: "available", authenticated: true } } : row);
    await advance(5000);
    expect(host.textContent).toContain("Claude is ready");
    expect(host.textContent).toContain("Installing Codex…");
    instances = instances.map((row) => ({ ...row, snapshot: { state: "available", authenticated: true } }));
    await advance(5000);
    const count = fetchMock.mock.calls.length;
    await advance(600000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("keeps the five-second cadence when another engine starts between probes", async () => {
    await connect();
    await click("Install Claude");
    await advance(2500);
    await click("Install", host.querySelector('[data-engine-connect="codex"]')!);
    await advance(2500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops polling and focus rechecks when the screen unmounts", async () => {
    await connect();
    await click("Install Claude");
    await act(async () => root!.unmount());
    root = undefined;
    const count = fetchMock.mock.calls.length;
    await advance(600000);
    window.dispatchEvent(new Event("focus"));
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("offers retry and commands when the installer and clipboard fail", async () => {
    window.ogb!.openEngineInstall = vi.fn(async () => { throw new Error("No handler registered"); });
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await connect();
    await click("Install Claude");
    expect(host.textContent).toContain("Didn't finish?");
    await click("Show Commands");
    expect(host.querySelector("code")?.textContent).toBe("install-claude");
    expect(host.textContent).toContain("Try Again");
  });

  it("opens commands by default in a browser and copies the install command", async () => {
    Object.assign(window, { ogb: undefined });
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await connect();
    expect(host.querySelector("code")?.textContent).toBe("install-claude");
    expect(host.textContent).toContain("Copy Command");
    await click("Copy Command");
    expect(copy).toHaveBeenCalledWith("install-claude");
    await advance(30000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing onboarding path when an engine was installed before opening", async () => {
    instances[0]!.snapshot = { state: "available", authenticated: false };
    await render();
    await click("Continue");
    expect(host.textContent).toContain("Wink found the engines on this computer.");
    expect(host.textContent).not.toContain("Most people start with Claude");
  });

  it("shares the Claude-first desktop NoEngines screen and focus recheck", async () => {
    await render(createElement(NoEngines));
    expect(host.textContent).toContain("Install Claude");
    expect(host.querySelector("code")).toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(refreshInstances).toHaveBeenCalledExactlyOnceWith("passive");
    await click("Install Claude");
    await advance(5000);
    expect(refreshInstances).toHaveBeenCalledTimes(2);
    expect(refreshInstances).toHaveBeenLastCalledWith("passive");
    expect(refreshInstances.mock.calls.every((args) => !args.includes(true))).toBe(true);
  });

  it("keeps an onboarding poll response that takes longer than five seconds, including a focus check", async () => {
    await connect();
    await click("Install Claude");
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 12000));
      return Response.json({ instances: instances.map((row) => row.instanceId === "claude"
        ? { ...row, snapshot: { state: "available", authenticated: true } } : row) });
    });
    await advance(5000);
    await advance(5000);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await advance(7000);
    expect(host.textContent).toContain("Claude is ready");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/instances", "/api/instances?refresh=1"]);
  });

  it("shows paste guidance and commands for a blank terminal, polling until the ten-minute deadline", async () => {
    Object.assign(window.ogb!, { platform: "linux", openEngineInstall: vi.fn(async () => "opened") });
    await connect();
    await click("Install Claude");
    const row = host.querySelector('[data-engine-connect="claude"]')!;
    expect(row.textContent).toContain("Paste the command in Terminal and press Enter.");
    expect(row.textContent).toContain("Terminal opened");
    expect(row.textContent).not.toContain("Installing Claude…");
    expect(row.textContent).not.toContain("Finish in the window that opened.");
    expect(host.querySelector("[data-engine-connect-commands] code")?.textContent).toBe("install-claude");
    await advance(595000);
    expect(fetchMock).toHaveBeenCalledTimes(120);
    await advance(25000);
    expect(fetchMock).toHaveBeenCalledTimes(120);
    expect(row.textContent).toContain("Didn't finish?");
  });

  it.each(["claudeAgent", "codex"])("signs in the configured %s instance through the server", async (kind) => {
    const instance = instances.find((row) => row.driverKind === kind)!;
    const configured = { ...instance, instanceId: `${instance.instanceId} work/profile`,
      snapshot: { state: "available" as const, authenticated: false } };
    await render(createElement(EngineConnect, { instances: [configured], onRefresh: refreshInstances }));
    await click(`Sign in to ${configured.displayName}`);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/instances/${encodeURIComponent(configured.instanceId)}/sign-in`,
      expect.objectContaining({ method: "POST", body: '{"device":false}' }));
    expect(window.ogb!.openEngineSignIn).not.toHaveBeenCalled();
  });

  it("disables the ready status button", async () => {
    instances[0]!.snapshot = { state: "available", authenticated: true };
    await render(createElement(EngineConnect, { instances, onRefresh: refreshInstances }));
    const button = host.querySelector<HTMLButtonElement>('[data-engine-connect="claude"] button')!;
    expect(button.textContent).toBe("Claude is ready");
    expect(button.disabled).toBe(true);
  });

  it("resets the connect session on Back after an engine becomes available", async () => {
    await connect();
    instances[0]!.snapshot = { state: "available", authenticated: false };
    await act(async () => window.dispatchEvent(new Event("focus")));
    await click("Back");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Continue")).toBe(true);
    await click("Continue");
    expect(host.textContent).toContain("Wink found the engines on this computer.");
  });

  it("uses the configured Antigravity display name", async () => {
    instances.find((row) => row.driverKind === "antigravityAgent")!.displayName = "Gemini Work";
    await connect();
    const row = host.querySelector('[data-engine-connect="antigravity"]')!;
    expect(row.textContent).toContain("Gemini Work");
    expect(row.textContent).not.toContain("Gemini (Antigravity)");
  });

  it.each(["en", "ko"] as const)("shows only the phone copy in %s, with no commands or polling", async (locale) => {
    persistPreference(locale);
    Object.assign(window, { ogb: undefined });
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    await render(createElement(NoEngines));
    expect(host.textContent).toContain(locale === "en"
      ? "Your bots run on an engine. Install one in Wink on your PC. Most people start with Claude."
      : "봇은 엔진으로 작동합니다. PC의 Wink에서 엔진을 설치하세요. 대부분 Claude로 시작합니다.");
    expect(host.querySelector("code")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    await advance(600000);
    expect(refreshInstances).not.toHaveBeenCalled();
  });
});
