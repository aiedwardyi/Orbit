// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { ErrorReportsRow } from "./ErrorReportsRow";

afterEach(() => { delete window.ogb; localStorage.setItem("omb-locale", "en"); });

it("starts unchecked, reads local consent and changes it only on an explicit click", async () => {
  let resolve: (value: boolean) => void = () => {};
  const errorReportConsent = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
  const setErrorReportConsent = vi.fn(async (value: boolean) => value);
  Object.defineProperty(window, "ogb", { value: { errorReportConsent, setErrorReportConsent }, configurable: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    const toggle = host.querySelector("button")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(true);
    expect(setErrorReportConsent).not.toHaveBeenCalled();
    await act(async () => resolve(false));
    expect(toggle.disabled).toBe(false);
    expect(host.textContent).toContain("App version, OS and error codes only. Never chats, files or paths.");
    await act(async () => toggle.click());
    expect(setErrorReportConsent).toHaveBeenLastCalledWith(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(setErrorReportConsent).toHaveBeenLastCalledWith(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
