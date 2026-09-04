import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider, translate } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const { mockInstances } = vi.hoisted(() => {
  const row = (instanceId: string, driverKind: string, displayName: string): InstanceInfo => ({
    instanceId,
    driverKind,
    displayName,
    snapshot: { state: "available", authenticated: true },
    models: { default: "default", options: [] },
    cliDefault: instanceId,
  });
  return {
    mockInstances: [
      row("claude", "claudeAgent", "Claude"),
      row("kimi", "kimiAgent", "Kimi"),
      row("codex", "codex", "Codex"),
      row("grok", "grokAgent", "Grok"),
      row("gemini", "geminiAgent", "Gemini API"),
      row("antigravity", "antigravityAgent", "Gemini (Antigravity)"),
      row("opencode", "opencodeGo", "OpenCode"),
      row("hermes", "hermesAgent", "Hermes"),
    ],
  };
});

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: { ogb: undefined },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "en" },
    configurable: true,
  });
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { instances: mockInstances },
      refreshInstances: async () => undefined,
    }),
  };
});

import { CustomPicker, EnginesSettings, cliPickerCommitValue, inUseCliPath } from "./EnginesSettings";

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
    expect(html.indexOf(PATH_DEFAULT)).toBeLessThan(html.indexOf(OTHER));
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
  it("shows Set CLI for Grok Claude Codex Antigravity, not Gemini API or OpenCode or the zoo", () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(EnginesSettings)),
    );
    expect(html).toContain("Grok");
    expect(html).toContain("Claude");
    expect(html).toContain("Codex");
    expect(html).toContain("Gemini (Antigravity)");
    expect(html).toContain("Set CLI…");
    expect(html).toContain(">Models<");
    expect(html).not.toContain(">Cloud<");
    expect(html).not.toContain("Gemini API");
    expect(html).not.toContain("OpenCode");
    expect(html).not.toContain("Kimi");
    expect(html).not.toContain("Hermes");
    expect(html).not.toContain("Show all engines");
    const grok = html.indexOf("Grok");
    const claude = html.indexOf("Claude");
    const codex = html.indexOf("Codex");
    const antigravity = html.indexOf("Gemini (Antigravity)");
    expect(grok).toBeGreaterThan(-1);
    expect(claude).toBeGreaterThan(grok);
    expect(codex).toBeGreaterThan(claude);
    expect(antigravity).toBeGreaterThan(codex);
  });
});
