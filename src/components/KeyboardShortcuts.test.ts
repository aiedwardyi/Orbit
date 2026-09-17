// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { I18nProvider, persistPreference } from "@/lib/i18n";

import { KeyboardShortcuts } from "./KeyboardShortcuts";

describe("KeyboardShortcuts", () => {
  afterEach(() => persistPreference("en"));

  it("keeps navigation shortcuts while hiding composer and close help rows", () => {
    persistPreference("en");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
    );

    expect(html).toContain(">Toggle Themes<");
    expect(html).toContain(">Find in conversation<");
    expect(html).not.toContain("Send message");
    expect(html).not.toContain("New line");
    expect(html).not.toContain("Edit last message");
    expect(html).not.toContain("Close a dialog or menu");
  });
});
