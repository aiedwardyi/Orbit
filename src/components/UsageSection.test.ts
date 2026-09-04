import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const { mockState } = vi.hoisted(() => {
  const engine = (
    instanceId: string,
    driverKind: string,
    displayName: string,
    extra: Partial<InstanceInfo> = {},
  ): InstanceInfo => ({
    instanceId,
    driverKind,
    displayName,
    snapshot: { state: "available", authenticated: true },
    models: { default: "default", options: [] },
    ...extra,
  });
  return {
    mockState: {
      bots: [
        {
          id: "bot-1",
          hidden: false,
          name: "Friend",
          modelSelection: { instanceId: "grok", model: "grok-4.6" },
          tasks: [{ threadId: "t", title: "", createdAt: 0, usage: { input: 10, output: 4, costUsd: 0.01, turns: 2 } }],
        },
      ],
      instances: [
        engine("claude", "claudeAgent", "Claude", {
          rateLimits: {
            observedAt: new Date().toISOString(),
            windows: [{ id: "five_hour", usedPercent: 10, resetsAt: Date.now() + 3_600_000 }],
          },
        }),
        engine("kimi", "kimiAgent", "Kimi"),
        engine("codex", "codex", "Codex"),
        engine("grok", "grokAgent", "Grok"),
        engine("gemini", "geminiAgent", "Gemini API"),
        engine("antigravity", "antigravityAgent", "Gemini (Antigravity)"),
        engine("opencode", "opencodeGo", "OpenCode"),
      ],
    },
  };
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: mockState,
      dispatch: () => undefined,
    }),
  };
});

import { UsageSection } from "./UsageSection";

describe("UsageSection friends plan card", () => {
  it("shows the featured engines in picker order and hides the per-bot table", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
    expect(html).toContain("Plan usage");
    expect(html).toContain("Grok");
    expect(html).toContain("Claude");
    expect(html).toContain("Codex");
    expect(html).toContain("Gemini (Antigravity)");
    expect(html).toContain("OpenCode");
    expect(html).not.toContain("Gemini API");
    expect(html).not.toContain("Kimi");
    expect(html).toContain("not available at the moment");
    expect(html).not.toContain(">Turns<");
    expect(html).not.toContain(">Tokens<");
    expect(html).not.toContain(">Cost<");
    expect(html).not.toContain("Friend");
    const grok = html.indexOf("Grok");
    const claude = html.indexOf("Claude");
    const codex = html.indexOf("Codex");
    const antigravity = html.indexOf("Gemini (Antigravity)");
    const opencode = html.indexOf("OpenCode");
    expect(grok).toBeGreaterThan(-1);
    expect(claude).toBeGreaterThan(grok);
    expect(codex).toBeGreaterThan(claude);
    expect(antigravity).toBeGreaterThan(codex);
    expect(opencode).toBeGreaterThan(antigravity);
  });
});
