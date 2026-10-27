import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const { mockInstances, refreshInstances, dispatch } = vi.hoisted(() => {
  const row = (instanceId: string, driverKind: string, displayName: string): InstanceInfo => ({
    instanceId,
    driverKind,
    displayName,
    snapshot: { state: "available", authenticated: true },
    models: { default: "default", options: [] },
    cliDefault: instanceId,
  });
  return {
    dispatch: vi.fn(),
    refreshInstances: vi.fn(async () => undefined),
    mockInstances: [
      row("claude", "claudeAgent", "Claude"),
      row("kimi", "kimiAgent", "Kimi"),
      row("codex", "codex", "Codex"),
      row("grok", "grokAgent", "Grok"),
      row("gemini", "geminiAgent", "Gemini API"),
      row("antigravity", "antigravityAgent", "Gemini (Antigravity)"),
      row("muse", "museAgent", "Meta Muse"),
      row("hermes", "hermesAgent", "Hermes"),
    ],
  };
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { instances: mockInstances },
      refreshInstances,
      dispatch,
    }),
    useOptionalStoreDispatch: () => dispatch,
  };
});

import { EngineRow, EnginesSettings, isEngineConnected } from "./EnginesSettings";
import { EngineSetup } from "./EngineSetup";

applyLocale("en");

it("shares signed-out instances with the model picker and onboarding", async () => {
  const signedOut = instance({ snapshot: { state: "available", authenticated: false }, install: { logout: ["logout"] } });
  const previous = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ instances: [signedOut], candidates: [] }), { status: 200 }));
  dispatch.mockClear();
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(EngineRow, {
      instance: instance({ install: { logout: ["logout"] } }),
    }))));
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Sign Out"))!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "instances", instances: [signedOut], preserveRateLimits: true });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previous;
  }
});

const OTHER = "/opt/homebrew/bin/claude";

function instance(partial: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    instanceId: "claude",
    driverKind: "claudeAgent",
    displayName: "Claude",
    snapshot: { state: "available", authenticated: true },
    models: { default: "sonnet", options: [] },
    cliDefault: "claude",
    ...partial,
  };
}

describe("EnginesSettings friends Connections list", () => {
  async function renderList() {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(EnginesSettings))));
    const row = (id: string) => [...host.querySelectorAll("div")].find((node) => node.dataset.engineRow === id)!;
    return { host, root, row };
  }

  function stage(id: string, partial: Partial<InstanceInfo>) {
    const target = mockInstances.find((row) => row.instanceId === id)!;
    const previous = { ...target };
    Object.assign(target, partial);
    return () => {
      for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
      Object.assign(target, previous);
    };
  }

  it("shows a connected engine as Connected with a quiet Sign Out and nothing else", async () => {
    const restore = stage("claude", { cli: OTHER, install: { logout: ["auth", "logout"], signInCommand: "claude", docsUrl: "https://example.com/claude" } });
    const { root, row } = await renderList();
    try {
      expect(row("claude").textContent).toBe("ClaudeConnectedSign Out");
      expect(row("claude").querySelector("input, select, code, a")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });

  it("shows a signed-out engine with only Sign In", async () => {
    const restore = stage("codex", {
      snapshot: { state: "available", authenticated: false },
      install: { login: { args: ["login"] }, logout: ["logout"], signInCommand: "codex login", docsUrl: "https://example.com/codex" },
    });
    const { root, row } = await renderList();
    try {
      expect([...row("codex").querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Sign In"]);
      expect(row("codex").textContent).toBe("CodexSign In");
      expect(row("codex").querySelector("input, select, code, a")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });

  it.each([undefined, "/missing/grok"])("opens the install terminal for a missing engine with cli %s", async (cli) => {
    const previous = window.ogb;
    const openInstallTerminal = vi.fn(async () => true);
    Object.assign(window, { ogb: { platform: "win32", openInstallTerminal } });
    const restore = stage("grok", {
      snapshot: { state: "unavailable" },
      cli,
      install: { command: { win32: "install-grok", linux: "install-grok", darwin: "install-grok" }, signInCommand: "grok login", docsUrl: "https://x.ai/cli" },
    });
    const { host, root, row } = await renderList();
    try {
      expect(row("grok")).toBeUndefined();
      await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "More Engines")!.click());
      expect(row("grok").textContent).toBe("GrokNot InstalledInstall");
      expect(row("grok").querySelector("a, input, select, code")).toBeNull();
      await act(async () => row("grok").querySelector("button")!.click());
      expect(openInstallTerminal).toHaveBeenCalledExactlyOnceWith("install-grok");
      expect(row("grok").textContent).toContain("Terminal openedInstallPaste the command in Terminal and press Enter.");
      expect(row("grok").querySelector("button")?.textContent).toBe("Install");
    } finally {
      await act(async () => root.unmount());
      restore();
      window.ogb = previous;
    }
  });

  it("omits the install link when an engine has no guide", async () => {
    const restore = stage("grok", { snapshot: { state: "unavailable" } });
    const { host, root, row } = await renderList();
    try {
      await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "More Engines")!.click());
      expect(row("grok").textContent).toBe("GrokNot Installed");
      expect(row("grok").querySelector("a")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });

  it("keeps the guide when this platform has no install command", () => {
    const previous = window.ogb;
    Object.assign(window, { ogb: { platform: "win32" } });
    try {
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(EngineRow, {
        instance: instance({ snapshot: { state: "unavailable" }, install: { command: { linux: "install-cli" }, docsUrl: "https://example.com/install" } }),
      })));
      expect(html).toContain('href="https://example.com/install"');
      expect(html).not.toContain("<button");
    } finally {
      window.ogb = previous;
    }
  });

  it.each(["missing", "rejected", "copied", "blocked"])("handles a %s install bridge without false feedback", async (mode) => {
    const previous = window.ogb;
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async () => {
      if (mode === "blocked") throw new Error("clipboard blocked");
    });
    Object.assign(window, { ogb: { platform: "win32", ...(mode !== "missing" && { openInstallTerminal: async () => {
      if (mode === "copied") return false;
      throw new Error("no handler");
    } }) } });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(I18nProvider, null, createElement(EngineRow, {
        instance: instance({ snapshot: { state: "unavailable" }, install: { command: { win32: "install-cli" } } }),
      }))));
      await act(async () => host.querySelector("button")!.click());
      expect(copy).toHaveBeenCalledTimes(mode === "copied" ? 0 : 1);
      if (mode !== "copied") expect(copy).toHaveBeenCalledWith("install-cli");
      expect(host.textContent?.includes("Command copied")).toBe(mode !== "blocked");
      expect(host.textContent).not.toMatch(/Terminal opened|Paste the command/);
    } finally {
      await act(async () => root.unmount());
      copy.mockRestore();
      window.ogb = previous;
    }
  });

  it.each(["npm install -g @openai/codex", "irm https://example.com/install.ps1 | iex"])("shows the Node requirement only for npm: %s", (command) => {
    const previous = window.ogb;
    Object.assign(window, { ogb: { platform: "win32" } });
    try {
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(EngineRow, {
        instance: instance({ snapshot: { state: "unavailable" }, install: { command: { win32: command }, needsNode: true } }),
      })));
      expect(html.includes("Requires Node.js and npm.")).toBe(command.startsWith("npm"));
    } finally {
      window.ogb = previous;
    }
  });

  it("moves an installed CLI to Sign In after returning to Connections", async () => {
    const previous = window.ogb;
    const openInstallTerminal = vi.fn(async () => true);
    Object.assign(window, { ogb: { platform: "win32", openInstallTerminal } });
    const restore = stage("codex", {
      snapshot: { state: "unavailable" },
      install: { command: { win32: "npm install -g @openai/codex" }, login: { args: ["login"] }, signInCommand: "codex login" },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    const { host, root, row } = await renderList();
    try {
      await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "More Engines")!.click());
      await act(async () => row("codex").querySelector("button")!.click());
      expect(openInstallTerminal).toHaveBeenCalledExactlyOnceWith("npm install -g @openai/codex");
      vi.setSystemTime(Date.now() + 6000);
      await act(async () => window.dispatchEvent(new Event("blur")));
      refreshInstances.mockImplementationOnce(async () => {
        mockInstances.find((row) => row.instanceId === "codex")!.snapshot = { state: "available", authenticated: false };
        root.render(createElement(I18nProvider, null, createElement(EnginesSettings)));
      });
      vi.setSystemTime(Date.now() + 6000);
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(row("codex").textContent).toBe("CodexSign In");
      expect(row("codex").querySelector("a")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      restore();
      window.ogb = previous;
      vi.useRealTimers();
    }
  });

  it("shows installed engines once with no path or Details controls", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(EnginesSettings)));
    for (const name of ["Claude", "Codex", "Grok", "Gemini (Antigravity)", "Meta Muse"]) {
      expect(html.split(name)).toHaveLength(2);
    }
    expect(html.match(/>Connected</g)).toHaveLength(5);
    expect(html).not.toContain("Details");
    expect(html).not.toContain("Advanced");
    expect(html).not.toMatch(/<(input|select|code)/);
    expect(html).not.toContain("lucide-triangle-alert");
    expect(html).not.toContain("lucide-check");
    expect(html).not.toContain("Set CLI");
    expect(html).not.toContain("Gemini API");
    expect(html).not.toContain("Kimi");
  });
});

it("opens sign-in with only the instance id and shows running instructions", async () => {
  const previous = window.ogb;
  const openEngineSignIn = vi.fn(async () => "running" as const);
  const openInstallTerminal = vi.fn(async () => true);
  Object.assign(window, { ogb: { platform: "win32", openEngineSignIn, openInstallTerminal } });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(EngineSetup, {
      instance: instance({ snapshot: { state: "available", authenticated: false }, install: { signInCommand: "claude" } }),
    }))));
    const button = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Open Sign-in"))!;
    await act(async () => button.click());
    expect(openEngineSignIn).toHaveBeenCalledExactlyOnceWith("claude");
    expect(openInstallTerminal).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Paste the command");
    expect(host.textContent).toContain("Follow the sign-in steps");
  } finally {
    await act(async () => root.unmount());
    window.ogb = previous;
  }
});

describe("isEngineConnected", () => {
  it("requires a confirmed sign-in for a green check", () => {
    expect(isEngineConnected(instance({ snapshot: { state: "available", authenticated: false } }))).toBe(false);
    expect(isEngineConnected(instance({ snapshot: { state: "available" } }))).toBe(false);
    expect(isEngineConnected(instance({ snapshot: { state: "available", authenticated: true } }))).toBe(true);
  });

  it("lights an engine detected on PATH with no configured override", () => {
    expect(isEngineConnected(instance({ snapshot: { state: "available", authenticated: true } }))).toBe(true);
  });

  it("lights an engine whose override probe succeeded", () => {
    expect(isEngineConnected(instance({ snapshot: { state: "available", authenticated: true }, cli: OTHER }))).toBe(true);
  });

  it("leaves an absent engine unlit even with an override configured", () => {
    expect(isEngineConnected(instance({ snapshot: { state: "unavailable" }, cli: OTHER }))).toBe(false);
    expect(isEngineConnected(instance({ snapshot: { state: "unavailable" } }))).toBe(false);
  });
});

it("rescans sign-in on opening Connections and after a real trip away", async () => {
  refreshInstances.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  const host = document.createElement("div");
  const root = createRoot(host);
  const after = async (ms: number, event: "blur" | "focus") => {
    vi.setSystemTime(Date.now() + ms);
    await act(async () => window.dispatchEvent(new Event(event)));
  };
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(EnginesSettings))));
    expect(refreshInstances).toHaveBeenCalledExactlyOnceWith(true);
    await after(0, "blur");
    await after(0, "focus");
    await after(6000, "blur");
    await after(1000, "focus");
    expect(refreshInstances).toHaveBeenCalledTimes(1);
    await after(0, "blur");
    await after(6000, "focus");
    expect(refreshInstances).toHaveBeenCalledTimes(2);
    expect(refreshInstances).toHaveBeenLastCalledWith(true);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
  window.dispatchEvent(new Event("focus"));
  expect(refreshInstances).toHaveBeenCalledTimes(2);
});
