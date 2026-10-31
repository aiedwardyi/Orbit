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

  it("hides the relay link on a remote device, where relay setup is refused", async () => {
    store.api.mockImplementation(async (path: string) => {
      if (path === "/api/phone-relay/status") throw new Error("manage phone access on this PC");
      return { url, setup: { state: "ready" } };
    });
    root = createRoot(host);
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
    expect(host.querySelector("[data-phone-link-qr] svg")).not.toBeNull();
    expect(button("Have a relay setup code?")).toBeUndefined();
    expect(document.getElementById("phone-relay-settings")).toBeNull();
  });

  it.each([[false, "smooth"], [true, "auto"]])("scrolls the opened relay form into view and focuses its field (reduced motion %s)", async (reduce, behavior) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce") }));
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    await render({ url: null, setup: { state: "missing" } });
    await act(async () => button("Have a relay setup code?").click());
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("phone-relay-settings"));
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior });
    expect(document.activeElement).toBe(host.querySelector("[data-phone-access-setup]"));
    await act(async () => button("Have a relay setup code?").click());
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("waits for a relay form that loads late before scrolling to it", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    await render({ url: null, setup: { state: "missing" } });
    const relay = button("Have a relay setup code?");
    const box = document.getElementById(relay.getAttribute("aria-controls")!)!;
    const late = vi.spyOn(box, "firstElementChild", "get").mockReturnValue(null);
    await act(async () => relay.click());
    expect(scroll).not.toHaveBeenCalled();
    late.mockRestore();
    await act(async () => box.appendChild(document.createElement("span")));
    expect(scroll).toHaveBeenCalledTimes(1);
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
    store.api.mockImplementation((path: string) => path === "/api/remote-link" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
    root = createRoot(host);
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(store.api.mock.calls.filter(([path]) => path === "/api/remote-link")).toHaveLength(1);
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

  it("keeps today's page when no phone has opened Wink", async () => {
    await render({ url, setup: { state: "ready" }, phones: [] });
    expect(host.querySelector("[data-phone-list]")).toBeNull();
    expect(host.querySelector('[data-phone-step="2"]')?.getAttribute("data-complete")).toBe("false");
    expect(host.querySelector('[data-phone-step="3"]')?.getAttribute("data-complete")).toBe("false");
    expect(host.querySelector('[data-phone-step="2"]')?.textContent).toContain("2");
  });

  it.each([
    ["en", ["Android phone · Active 5m ago", "iPhone · Active now", "Phone · Active 3d ago", "iPad · Active 2h ago"], "A phone has opened Wink"],
    ["ko", ["Android 휴대폰 · 5분 전 사용", "iPhone · 지금 사용 중", "휴대폰 · 3일 전 사용", "iPad · 2시간 전 사용"], "휴대폰에서 Wink를 열었습니다"],
  ])("lists phones and checks every step in %s", async (locale, rows, label) => {
    localStorage.setItem("omb-locale", locale);
    vi.setSystemTime(1_800_000_000_000);
    const ago = (ms: number) => 1_800_000_000_000 - ms;
    await render({ url, setup: { state: "ready" }, phones: [
      { id: "a", kind: "android", lastSeen: ago(5 * 60_000) },
      { id: "b", kind: "iphone", lastSeen: ago(30_000) },
      { id: "c", kind: "phone", lastSeen: ago(3 * 86_400_000) },
      { id: "d", kind: "ipad", lastSeen: ago(2 * 3_600_000) },
    ] });
    expect([...host.querySelectorAll("[data-phone-list] li")].map((row) => row.textContent)).toEqual(rows);
    for (const step of ["1", "2", "3"]) expect(host.querySelector(`[data-phone-step="${step}"]`)?.getAttribute("data-complete")).toBe("true");
    expect(host.querySelectorAll(`[aria-label="${label}"]`)).toHaveLength(2);
    expect(host.querySelector("[data-phone-link-qr] svg")).not.toBeNull();
    expect(host.textContent).not.toMatch(/Mozilla|\d+\.\d+\.\d+\.\d+/);
  });

  it("shows a phone as soon as the next refresh sees it", async () => {
    await render({ url, setup: { state: "ready" } });
    expect(host.querySelector("[data-phone-list]")).toBeNull();
    store.api.mockResolvedValue({ url, setup: { state: "ready" }, phones: [{ id: "a", kind: "android", lastSeen: Date.now() }] });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector("[data-phone-list]")?.textContent).toBe("Android phone · Active now");
    expect(host.querySelector('[data-phone-step="3"]')?.getAttribute("data-complete")).toBe("true");
  });

  it("renders all new steps and the relay link in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    await render({ url, setup: { state: "ready" } });
    for (const text of ["이 PC에 Tailscale 설치", "휴대폰에도 Tailscale을 설치하고 같은 계정으로 로그인", "휴대폰 카메라로 이 코드를 스캔", "링크 복사", "릴레이 설정 코드가 있나요?"]) expect(host.textContent).toContain(text);
  });
});
