// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => store);
vi.mock("./PhoneAccessSettings", () => ({ PhoneAccessSettings: () => createElement("input", { "data-phone-access-setup": true }) }));

import { I18nProvider } from "@/lib/i18n";
import { PhoneLinkSettings } from "./PhoneLinkSettings";

const url = "https://fixture.invalid/remote?key=fixture";
let root: Root | undefined;
let host: HTMLDivElement;
const button = (label: string) => [...host.querySelectorAll("button, a")].find((node) => node.textContent === label) as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("omb-locale", "en");
  host = document.body.appendChild(document.createElement("div"));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.remove();
  store.api.mockReset();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function render(body: object) {
  store.api.mockResolvedValue(body);
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
}

describe("Phone setup steps", () => {
  it.each([
    ["missing", "Tailscale isn't installed. Install it and connect.", false],
    ["not-running", "Tailscale is offline. Open it and connect.", false],
    ["serve-disabled", "Enable Tailscale Serve to connect your phone.", true],
    ["checking", "Checking Tailscale...", false],
    ["error", "Check Tailscale Serve settings. Wink will retry.", false],
    ["ready", "Scan this code with your phone's camera", true],
  ])("renders %s with QR and Copy Link only when ready", async (state, help, running) => {
    await render({ url, setup: { state, enableUrl: "https://login.tailscale.com/f/serve?node=fixture" } });
    expect(host.querySelectorAll("ol > li")).toHaveLength(3);
    expect(host.textContent).toContain(help);
    expect(host.querySelector('[data-phone-step="1"]')?.getAttribute("data-complete")).toBe(String(running));
    expect(!!host.querySelector("[data-phone-link-qr] svg")).toBe(state === "ready");
    expect(!!button("Copy Link")).toBe(state === "ready");
    expect(!!button("Enable Serve")).toBe(state === "serve-disabled");
    expect(host.textContent).not.toContain(url);
  });

  it("opens Get Tailscale through the desktop external path", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ogb", { openExternal });
    await render({ url: null, setup: { state: "missing" } });
    await act(async () => button("Get Tailscale").click());
    expect(openExternal).toHaveBeenCalledWith("https://tailscale.com/download");
  });

  it("keeps a browser download fallback", async () => {
    vi.stubGlobal("ogb", undefined);
    await render({ url: null, setup: { state: "missing" } });
    expect(button("Get Tailscale").getAttribute("href")).toBe("https://tailscale.com/download");
    expect(button("Get Tailscale").getAttribute("target")).toBe("_blank");
  });

  it("copies the same link encoded by the local QR", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await render({ url, setup: { state: "ready" } });
    const qr = document.createElement("div");
    qr.innerHTML = renderToStaticMarkup(createElement(QRCodeSVG, { value: url, size: 168, level: "M", bgColor: "#ffffff", fgColor: "#111111" }));
    expect(host.querySelector("[data-phone-link-qr] svg")?.outerHTML).toBe(qr.innerHTML);
    expect(host.querySelector("img")).toBeNull();
    await act(async () => button("Copy Link").click());
    expect(writeText).toHaveBeenCalledWith(url);
    expect(button("Copied")).toBeDefined();
  });

  it("keeps Copied through a focus refresh", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await render({ url, setup: { state: "ready" } });
    await act(async () => button("Copy Link").click());
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(button("Copied")).toBeDefined();
  });

  it.each(["not-running", "serve-disabled", "error", "checking"])("hides Get Tailscale when %s", async (state) => {
    await render({ url: null, setup: { state } });
    expect(button("Get Tailscale")).toBeUndefined();
  });

  it("opens the relay code box only from its link", async () => {
    await render({ url: null, setup: { state: "missing" } });
    const relay = button("Have a relay setup code?");
    expect(host.querySelector("[data-phone-access-setup]")).toBeNull();
    expect(document.getElementById(relay.getAttribute("aria-controls")!)?.hidden).toBe(true);
    await act(async () => relay.click());
    expect(host.querySelector("[data-phone-access-setup]")).not.toBeNull();
    expect(document.getElementById(relay.getAttribute("aria-controls")!)?.hidden).toBe(false);
  });

  it.each(["focus", "poll"])("refreshes on %s even after ready and stops on unmount", async (trigger) => {
    await render({ url, setup: { state: "ready" } });
    store.api.mockResolvedValue({ url: null, setup: { state: "not-running" } });
    await act(async () => {
      if (trigger === "focus") window.dispatchEvent(new Event("focus"));
      else await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(host.querySelector("[data-phone-link-qr]")).toBeNull();
    await act(async () => root!.unmount());
    root = undefined;
    const count = store.api.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.api).toHaveBeenCalledTimes(count);
  });

  it("does not overlap slow requests and ignores a result after unmount", async () => {
    let finish!: (body: object) => void;
    store.api.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    root = createRoot(host);
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(store.api).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => finish({ url, setup: { state: "ready" } }));
    expect(host.textContent).toBe("");
  });

  it("clears a ready QR if the request fails", async () => {
    await render({ url, setup: { state: "ready" } });
    store.api.mockRejectedValue(new Error("fixture"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector("[data-phone-link-qr]")).toBeNull();
    expect(host.textContent).toContain("Wink will retry.");
  });

  it("pauses requests in a background window and rechecks when visible", async () => {
    await render({ url: null, setup: { state: "checking" } });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const count = store.api.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(store.api).toHaveBeenCalledTimes(count);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(store.api).toHaveBeenCalledTimes(count + 1);
  });

  it("renders all new steps and the relay link in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    await render({ url, setup: { state: "ready" } });
    for (const text of ["이 PC에 Tailscale 설치", "휴대폰에도 Tailscale을 설치하고 같은 계정으로 로그인", "휴대폰 카메라로 이 코드를 스캔", "링크 복사", "릴레이 설정 코드가 있나요?"]) expect(host.textContent).toContain(text);
  });
});
