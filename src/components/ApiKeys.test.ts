import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";

const { mockState } = vi.hoisted(() => {
  Object.defineProperty(globalThis, "navigator", { value: { language: "en" }, configurable: true });
  return { mockState: { config: undefined as unknown, bots: [] as unknown[] } };
});

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: () => new Promise(() => {}),
  useStore: () => ({ state: mockState, dispatch: () => undefined }),
}));

import { relativeTimeLabel, SavedKeys } from "./ApiKeys";

applyLocale("en");

const render = () => renderToStaticMarkup(createElement(I18nProvider, null, createElement(SavedKeys)));

describe("SavedKeys", () => {
  it("lists only saved brokerable keys, never a value", () => {
    mockState.config = { imageGen: { configured: true }, xai: { configured: false }, box: { configured: true }, anthropic: { configured: true } };
    const html = render();
    expect(html).toContain("OpenAI API key");
    expect(html).toContain("Claude API key");
    expect(html).toContain("Not used yet");
    expect(html).toContain('aria-label="Remove the saved key"');
    expect(html).not.toContain("xAI API key");
    expect(html).not.toContain("Box API key");
    expect(html).not.toContain("type=\"password\"");
  });

  it("lists a custom key as name and host", () => {
    mockState.config = { customKeys: [{ host: "api.acme.dev", name: "Acme" }] };
    expect(render()).toContain("Acme · api.acme.dev");
  });

  it("shows one muted line when no key is saved", () => {
    mockState.config = { imageGen: { configured: false } };
    expect(render()).toContain("Bots ask for keys when they need them.");
  });
});

describe("relativeTimeLabel", () => {
  it("formats the last use relative to now", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    expect(relativeTimeLabel("2026-09-27T11:59:30Z", "en", now)).toBe("this minute");
    expect(relativeTimeLabel("2026-09-27T09:00:00Z", "en", now)).toBe("3 hours ago");
    expect(relativeTimeLabel("2026-09-26T12:00:00Z", "en", now)).toBe("yesterday");
  });
});
