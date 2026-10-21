import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider, translate } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const { mockInstances, refreshInstances } = vi.hoisted(() => {
  const row = (instanceId: string, driverKind: string, displayName: string): InstanceInfo => ({
    instanceId,
    driverKind,
    displayName,
    snapshot: { state: "available", authenticated: true },
    models: { default: "default", options: [] },
    cliDefault: instanceId,
  });
  return {
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
    }),
  };
});

import { CustomPicker, EnginesSettings, cliPickerCommitValue, inUseCliPath, isEngineConnected } from "./EnginesSettings";
import { EngineSetup } from "./EngineSetup";

applyLocale("en");

const PATH_DEFAULT = "/usr/bin/claude";
const OTHER = "/opt/homebrew/bin/claude";
const CANDIDATES = [PATH_DEFAULT, OTHER];

function instance(partial: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    instanceId: "claude",
    driverKind: "claudeAgent",
    displayName: "Claude",
    snapshot: { state: "available", authenticated: true },
    models: { default: "sonnet", options: [] },
    cliDefault: "claude",
    cliCandidates: CANDIDATES,
    ...partial,
  };
}

function pickerMarkup(partial: Partial<InstanceInfo> = {}) {
  const inst = instance(partial);
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(CustomPicker, {
        instance: inst,
        cliDefault: inst.cliDefault,
        onClose: () => undefined,
        onSaved: async () => undefined,
      }),
    ),
  );
}

describe("inUseCliPath", () => {
  it("uses the override when that path is a detected candidate", () => {
    expect(inUseCliPath({ cli: OTHER }, CANDIDATES)).toBe(OTHER);
  });

  it("uses the PATH-default candidate when no override is set", () => {
    expect(inUseCliPath({}, CANDIDATES)).toBe(PATH_DEFAULT);
    expect(inUseCliPath({ cliDefault: "claude" }, CANDIDATES)).toBe(PATH_DEFAULT);
  });

  it("uses an exact cliDefault path when that is the driver default", () => {
    expect(inUseCliPath({ cliDefault: OTHER }, CANDIDATES)).toBe(OTHER);
  });

  it("marks nothing when the override is a wrapper outside the list", () => {
    expect(inUseCliPath({ cli: "/ag claude agp" }, CANDIDATES)).toBeUndefined();
  });

  it("does not invent a path when there are no candidates", () => {
    expect(inUseCliPath({}, [])).toBeUndefined();
    expect(inUseCliPath({ cli: PATH_DEFAULT }, [])).toBeUndefined();
  });
});

describe("CLI-candidates in-use marker", () => {
  it("labels only the in-use candidate and keeps every option value as the raw path", () => {
    const html = pickerMarkup({ cli: OTHER });
    expect(html).toMatch(
      new RegExp(`<option[^>]*value="${OTHER}"[^>]*>${OTHER} · in use<`),
    );
    expect(html).toMatch(
      new RegExp(`<option[^>]*value="${PATH_DEFAULT}"[^>]*>${PATH_DEFAULT}<`),
    );
    expect(html).not.toContain(`${PATH_DEFAULT} · in use`);
    expect(html).not.toContain(`value="${OTHER} · in use"`);
    const selectStart = html.indexOf("<select");
    const selectEnd = html.indexOf("</select>", selectStart);
    expect(selectStart).toBeGreaterThanOrEqual(0);
    expect(selectEnd).toBeGreaterThanOrEqual(0);
    const selectHtml = html.slice(selectStart, selectEnd);
    expect(selectHtml.indexOf(PATH_DEFAULT)).toBeLessThan(selectHtml.indexOf(OTHER));
  });

  it("marks the PATH-default candidate when the engine is on the driver default", () => {
    const html = pickerMarkup();
    expect(html).toContain(`${PATH_DEFAULT} · in use`);
    expect(html).not.toContain(`${OTHER} · in use`);
    expect(html).toContain(`value="${PATH_DEFAULT}"`);
    expect(html).toContain(`value="${OTHER}"`);
  });

  it("does not label any detected path when the override is a wrapper outside the list", () => {
    const html = pickerMarkup({ cli: "/ag claude agp" });
    expect(html).not.toContain(" · in use");
    expect(html).toContain(`value="${PATH_DEFAULT}"`);
    expect(html).toContain(`value="${OTHER}"`);
  });

  it("selecting a labeled option still commits the raw path", () => {
    const inUse = inUseCliPath({ cli: OTHER }, CANDIDATES);
    expect(inUse).toBe(OTHER);
    const labeled = translate("en", "engines.inUseSuffix", { cli: OTHER });
    expect(labeled).toBe(`${OTHER} · in use`);
    expect(cliPickerCommitValue("", OTHER)).toBe(OTHER);
    expect(cliPickerCommitValue("", OTHER)).not.toBe(labeled);
    expect(cliPickerCommitValue("/tmp/wrapper", OTHER)).toBe("/tmp/wrapper");
  });
});

describe("EnginesSettings friends Connections list", () => {
  it("shows installed engines once with quiet Connected rows and Details", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(EnginesSettings)));
    for (const name of ["Claude", "Codex", "Grok", "Gemini (Antigravity)", "Meta Muse"]) {
      expect(html.split(name)).toHaveLength(2);
    }
    expect(html.match(/>Connected</g)).toHaveLength(5);
    expect(html.match(/>Details</g)).toHaveLength(5);
    expect(html).not.toContain("lucide-triangle-alert");
    expect(html).not.toContain("lucide-check");
    expect(html).not.toContain("Set CLI");
    expect(html).not.toContain("Gemini API");
    expect(html).not.toContain("Kimi");
  });

  it("holds absent engines under More Engines until opened", async () => {
    const grok = mockInstances.find((row) => row.instanceId === "grok")!;
    const previous = grok.snapshot;
    grok.snapshot = { state: "unavailable" };
    grok.install = { command: { linux: "install-grok" }, signInCommand: "grok login" };
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(I18nProvider, null, createElement(EnginesSettings))));
      expect(host.textContent).toContain("More Engines");
      expect(host.textContent).not.toContain("Install Grok");
      const more = [...host.querySelectorAll("button")].find((button) => button.textContent === "More Engines")!;
      await act(async () => more.click());
      expect(host.textContent).toContain("Install Grok");
    } finally {
      await act(async () => root.unmount());
      grok.snapshot = previous;
      delete grok.install;
    }
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
