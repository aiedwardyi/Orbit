// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { ErrorReportsRow } from "./ErrorReportsRow";

afterEach(() => { delete window.ogb; localStorage.setItem("omb-locale", "en"); });

it("hides the row when reporting is unavailable", async () => {
  Object.defineProperty(window, "ogb", { value: { errorReportConsent: async () => null, setErrorReportConsent: vi.fn() }, configurable: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    expect(host.textContent).toBe("");
    expect(host.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

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

it("shows the stuck-worker line only when the team relay takes reports", async () => {
  Object.defineProperty(window, "ogb", { value: { errorReportConsent: async () => true, setErrorReportConsent: vi.fn(async (value: boolean) => value) }, configurable: true });
  for (const [status, shown] of [[{ state: "connected", snags: true }, true], [{ state: "connected" }, false], [{ state: "off" }, false]] as const) {
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow, { request: async () => status }))));
      expect(host.textContent?.includes("stuck-worker reports to its owner"), JSON.stringify(status)).toBe(shown);
      expect(host.textContent).toContain("App version, OS and error codes only. Never chats, files or paths.");
    } finally {
      await act(async () => root.unmount());
    }
  }
});

it("turning the switch off with the team line showing withdraws consent", async () => {
  const setErrorReportConsent = vi.fn(async (value: boolean) => value);
  Object.defineProperty(window, "ogb", { value: { errorReportConsent: async () => true, setErrorReportConsent }, configurable: true });
  localStorage.setItem("omb-locale", "ko");
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow, { request: async () => ({ state: "connected", snags: true }) }))));
    expect(host.textContent).toContain("팀 릴레이에서는 멈춘 작업자 보고도 관리자에게 보냅니다");
    await act(async () => host.querySelector("button")!.click());
    expect(setErrorReportConsent).toHaveBeenLastCalledWith(false);
    expect(host.querySelector("button")!.getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
  }
});
