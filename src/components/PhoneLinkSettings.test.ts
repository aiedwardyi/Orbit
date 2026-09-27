// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => store);

import { I18nProvider } from "@/lib/i18n";
import { PhoneLinkSettings } from "./PhoneLinkSettings";

afterEach(() => {
  store.api.mockReset();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
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
    const url = "https://laptop.tail396477.ts.net/remote?key=secretkey";
    store.api.mockResolvedValue({ url });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { host, root } = await renderView();
    expect(host.textContent).toContain("laptop.tail396477.ts.net");
    expect(host.textContent).not.toContain("secretkey");
    await act(async () => click(host.querySelector("button")!));
    expect(writeText).toHaveBeenCalledWith(url);
    expect(host.textContent).toContain("Copied");
    await act(async () => root.unmount());
  });
});
