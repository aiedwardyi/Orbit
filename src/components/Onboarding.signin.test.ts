// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { Onboarding } from "./Onboarding";

const RETIRED_KINDS = ["grok", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent", "qwenAgent", "hermesAgent", "openai-compat", "piAgent", "minimax", "opencodeGo"];
let roots: Root[] = [];

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function renderWith(status: number, onDone = vi.fn()) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status })));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(Onboarding, { onDone }))));
  return host;
}

function phoneWidth() {
  // SAFETY: isPhone only reads .matches
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") }) as MediaQueryList);
}

describe("Onboarding engine check", () => {
  it("updates Ready and disables continue after signing out the last ready engine", async () => {
    let authenticated = false;
    const instance = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
      snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] },
      install: { login: { args: ["auth", "login"] }, logout: ["auth", "logout"] },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/sign-out")) authenticated = false;
      return new Response(JSON.stringify(url.includes("cli-candidates") ? { candidates: [] }
        : { instances: [{ ...instance, snapshot: { state: "available", authenticated } }] }));
    }));
    const host = document.createElement("div");
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(Onboarding, { onDone: vi.fn() }))));
    const click = async (label: string) => {
      const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
      expect(button, label).toBeDefined();
      await act(async () => button!.click());
    };
    await click("Continue");
    authenticated = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    const ready = () => [...host.querySelectorAll("section")].find((section) => section.textContent?.startsWith("Ready"));
    const next = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Open Wink")!;
    expect(ready()).toBeDefined();
    expect(next().disabled).toBe(false);
    await click("Sign Out");
    expect(ready()).toBeUndefined();
    expect(next().disabled).toBe(true);
  });

  it("reuses the sign-in row for an installed engine", async () => {
    const instance = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
      snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] },
      install: { login: { args: ["auth", "login"] }, signInCommand: "claude auth login" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [instance] }))));
    const host = document.createElement("div");
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(Onboarding, { onDone: vi.fn() }))));
    const next = [...host.querySelectorAll("button")].find((button) => button.textContent === "Continue")!;
    await act(async () => next.click());
    expect(host.textContent).toContain("Sign In");
    expect(host.textContent).not.toContain("Details");
    expect(host.textContent).not.toContain("Open Sign-in in Terminal");
  });
  it("never counts a retired engine a cached probe calls ready", async () => {
    const retired = RETIRED_KINDS.map((driverKind) => ({
      instanceId: driverKind, driverKind, displayName: `Old ${driverKind}`,
      snapshot: { state: "available", authenticated: true }, models: { default: "m", options: [] },
      install: { docsUrl: "https://example.com" },
    }));
    const claude = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
      snapshot: { state: "unavailable" }, models: { default: "", options: [] }, install: { docsUrl: "https://claude.com" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ instances: [...retired, claude] }))));
    const onDone = vi.fn();
    const host = document.createElement("div");
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(Onboarding, { onDone }))));
    const next = [...host.querySelectorAll("button")].find((button) => button.textContent === "Connect an Engine");
    expect(next).toBeDefined();
    await act(async () => next!.click());
    expect(onDone).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Claude");
    expect(host.textContent).not.toContain("Old ");
  });

  it("asks an unpaired phone to sign in instead of blaming the engines", async () => {
    const host = await renderWith(401);
    expect(host.textContent).toContain("Sign in to this PC");
    expect(host.textContent).toContain("Settings → Phone link");
    expect(host.textContent).not.toContain("couldn't check the engines");
  });

  it("opens a paired phone straight to the chat", async () => {
    phoneWidth();
    const onDone = vi.fn();
    const host = await renderWith(200, onDone);
    expect(onDone).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("");
  });

  it("still asks an unpaired phone to sign in, and welcomes a first launch of the desktop app", async () => {
    phoneWidth();
    expect((await renderWith(401)).textContent).toContain("Sign in to this PC");
    vi.stubGlobal("ogb", { platform: "win32" });
    const onDone = vi.fn();
    expect((await renderWith(200, onDone)).textContent).toContain("Welcome to Wink");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("still reports a real engine check failure", async () => {
    const host = await renderWith(500);
    expect(host.textContent).toContain("Wink couldn't check the engines on this computer.");
    expect(host.textContent).not.toContain("Sign in to this PC");
  });

  it("reads the last check on open and asks for a fresh probe on retry and on focus", async () => {
    const host = await renderWith(500);
    const fetchMock = vi.mocked(fetch);
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Try again");
    await act(async () => retry!.click());
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/instances",
      "/api/instances?refresh=1",
      "/api/instances?refresh=1",
    ]);
  });
});
