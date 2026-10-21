// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => store);

import { I18nProvider } from "@/lib/i18n";
import { PhoneLinkSettings } from "./PhoneLinkSettings";

afterEach(() => {
  store.api.mockReset();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Phone Link setup", () => {
  const enableUrl = "https://login.tailscale.com/f/serve?node=fixture";
  const url = "https://pc.tail123.ts.net/remote?key=fixture";
  let view: Awaited<ReturnType<typeof renderView>> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.setItem("omb-locale", "en");
  });

  afterEach(async () => {
    if (view) await act(async () => view!.root.unmount());
    view = undefined;
    localStorage.clear();
    vi.useRealTimers();
  });

  async function render(body: object, locale = "en") {
    localStorage.setItem("omb-locale", locale);
    store.api.mockResolvedValue(body);
    view = await renderView();
    return view.host;
  }

  it.each([
    ["en", "Enable Tailscale Serve to connect your phone.", "Enable Serve"],
    ["ko", "휴대폰을 연결하려면 Tailscale Serve를 켜세요.", "Serve 켜기"],
  ])("shows the exact enable link and one setup line in %s", async (locale, help, label) => {
    const host = await render({ url: null, setup: { state: "serve-disabled", enableUrl } }, locale);
    expect(host.textContent).toContain(help);
    expect(host.querySelector("a")?.textContent).toBe(label);
    expect(host.querySelector("a")?.getAttribute("href")).toBe(enableUrl);
    expect(host.querySelector("a")?.getAttribute("target")).toBe("_blank");
    expect(host.querySelector("code")).toBeNull();
  });

  it.each([
    ["en", "missing", "Tailscale isn't installed. Install it and connect."],
    ["ko", "missing", "Tailscale이 없어요. 설치한 뒤 실행하고 연결하세요."],
    ["en", "not-running", "Tailscale is offline. Open it and connect."],
    ["ko", "not-running", "Tailscale이 꺼져 있어요. 실행하고 연결하세요."],
  ])("shows the %s %s recovery step", async (locale, state, help) => {
    const host = await render({ url: null, setup: { state } }, locale);
    expect(host.textContent).toContain(help);
  });

  it.each(["poll", "focus"])("updates to the working link on %s and stops after unmount", async (trigger) => {
    const host = await render({ url: null, setup: { state: "missing" } });
    store.api.mockResolvedValue({ url, setup: { state: "ready" } });
    await act(async () => {
      if (trigger === "poll") await vi.advanceTimersByTimeAsync(5_000);
      else window.dispatchEvent(new Event("focus"));
    });
    expect(host.querySelector("code")?.textContent).toContain("pc.tail123.ts.net");
    expect(host.querySelector("button")?.textContent).toBe("Copy");
    await act(async () => view!.root.unmount());
    view = undefined;
    const count = store.api.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.api).toHaveBeenCalledTimes(count);
  });

  it("does not overlap slow status requests", async () => {
    let finish!: (response: object) => void;
    store.api.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    view = await renderView();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(store.api).toHaveBeenCalledTimes(1);
    await act(async () => finish({ url, setup: { state: "ready" } }));
    expect(view.host.querySelector("code")).not.toBeNull();
  });

  it("leaves an explicitly disabled Phone Link hidden", async () => {
    const host = await render({ url: null, setup: { state: "disabled" } });
    expect(host.textContent).toBe("");
  });
});

async function renderView() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
  return { host, root };
}

const click = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

describe("PhoneLinkSettings", () => {
  it("renders nothing when remote mode is off", async () => {
    store.api.mockResolvedValue({ url: null });
    const { host, root } = await renderView();
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
  });

  it("shows the host and copies the full url", async () => {
    const url = "https://laptop.tail1234.ts.net/remote?key=secretkey";
    store.api.mockResolvedValue({ url });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { host, root } = await renderView();
    expect(host.textContent).toContain("laptop.tail1234.ts.net/••••••••");
    expect(host.textContent).not.toContain("secretkey");
    await act(async () => click(host.querySelector("button")!));
    expect(writeText).toHaveBeenCalledWith(url);
    expect(host.textContent).toContain("Copied");
    await act(async () => root.unmount());
  });
});
