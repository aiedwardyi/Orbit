// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { I18nProvider, persistPreference } from "@/lib/i18n";

import { KeyboardShortcuts } from "./KeyboardShortcuts";

describe("KeyboardShortcuts", () => {
  afterEach(() => persistPreference("en"));

  it("lists Toggle Model index once with Alt+I only", () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
    );

    expect(html.match(/>Toggle Model index</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Alt + I"');
    expect(html).not.toContain("Shift + M");
  });

  it("names the cycle row like Cycle theme and drops the terminal note", () => {
    const win = window as unknown as { ogb?: unknown };
    win.ogb = { terminal: {} };
    try {
      const html = renderToStaticMarkup(
        createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
      );
      expect(html).toContain(">Cycle Model index tab<");
      expect(html).toContain(">Toggle terminal<");

      persistPreference("ko");
      const ko = renderToStaticMarkup(
        createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
      );
      expect(ko).toContain(">모델 지표 탭 전환<");
      expect(ko).toContain(">터미널 열기 / 닫기<");
    } finally {
      delete win.ogb;
    }
  });

  it("lists the terminal toggle in a window with no preload", () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
    );
    expect(html).toContain(">Toggle terminal<");
    expect(html).toContain("`");
  });

  it("keeps the compact set while hiding low-value help rows", () => {
    persistPreference("en");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
    );

    expect(html).toContain(">Toggle Themes<");
    expect(html).toContain(">Toggle Usage<");
    expect(html).toContain(">Refresh Usage<");
    expect(html).toContain('aria-label="Alt + R"');
    expect(html).not.toContain("New bot");
    expect(html).not.toContain("Switch to bot 1");
    expect(html).not.toContain("Previous bot");
    expect(html).not.toContain("Next bot");
    expect(html).not.toContain("Find in conversation");
    expect(html).not.toContain("Send message");
    expect(html).not.toContain("New line");
    expect(html).not.toContain("Edit last message");
    expect(html).not.toContain("Close a dialog or menu");
  });
});
