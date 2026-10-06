// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { StartFreshRow } from "./StartFreshRow";

afterEach(() => { delete window.ogb; });

it("cancel does nothing and repeated confirm calls reset only once", async () => {
  const startFresh = vi.fn(() => new Promise<void>(() => {}));
  Object.defineProperty(window, "ogb", { value: { startFresh }, configurable: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = (button: Element) => button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(StartFreshRow))));
    await act(async () => click(host.querySelector("button")!));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("A backup copy is kept on this PC.");
    const buttons = () => [...document.querySelectorAll('[role="dialog"] button')];
    await act(async () => click(buttons().find((button) => button.textContent === "Cancel")!));
    expect(startFresh).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => click(host.querySelector("button")!));
    const confirm = buttons().find((button) => button.textContent === "Start fresh")!;
    await act(async () => { click(confirm); click(confirm); });
    expect(startFresh).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
