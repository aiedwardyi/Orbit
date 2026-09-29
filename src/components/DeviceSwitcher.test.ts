// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => store);

import { I18nProvider } from "@/lib/i18n";
import { DeviceSwitcher, type DeviceItem } from "./DeviceSwitcher";

const device = (id: string, over: Partial<DeviceItem> = {}): DeviceItem => ({
  deviceId: id,
  name: id,
  host: `${id}.tail396477.ts.net`,
  current: false,
  offline: false,
  ...over,
});

function setPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({ matches: phone && query.includes("max-width"), media: query })) as never;
}

afterEach(() => {
  store.api.mockReset();
  document.body.innerHTML = "";
});

async function renderView(devices: DeviceItem[], navigate = vi.fn()) {
  store.api.mockResolvedValue({ devices });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(DeviceSwitcher, { navigate }))));
  return { host, root, navigate };
}

const click = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const key = (target: Element, name: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));

describe("DeviceSwitcher", () => {
  it("is hidden with fewer than 2 devices", async () => {
    setPhone(true);
    const { host } = await renderView([device("home", { current: true })]);
    expect(host.textContent).toBe("");
  });

  it("is hidden off a phone", async () => {
    setPhone(false);
    const { host } = await renderView([device("home", { current: true }), device("work")]);
    expect(host.textContent).toBe("");
  });

  it("marks the current PC and jumps to another", async () => {
    setPhone(true);
    const { host, navigate } = await renderView([
      device("home", { current: true }),
      device("laptop", { offline: true }),
      device("work"),
    ]);
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-label")).toBe("Your PCs");
    expect(toggle.textContent).toBe("");
    expect(host.querySelector("ul")).toBeNull();
    await act(async () => click(toggle));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("This PC");
    expect(host.textContent).toContain("Offline");
    await act(async () => click(host.querySelector("[data-device-id=home]")!));
    expect(navigate).not.toHaveBeenCalled();
    expect(host.querySelector("ul")).toBeNull();
    await act(async () => click(toggle));
    await act(async () => click(host.querySelector("[data-device-id=laptop]")!));
    expect(navigate).toHaveBeenCalledWith("https://laptop.tail396477.ts.net/");
  });

  it("renames this PC inline", async () => {
    setPhone(true);
    const { host } = await renderView([device("home", { current: true, name: "EDWARD-PC" }), device("work")]);
    await act(async () => click(host.querySelector("button[aria-expanded]")!));
    expect(host.querySelectorAll("button[aria-label='Rename this PC']")).toHaveLength(1);
    await act(async () => click(host.querySelector("button[aria-label='Rename this PC']")!));
    let input = host.querySelector("input")!;
    expect(input.value).toBe("EDWARD-PC");
    await act(async () => key(input, "Escape"));
    expect(host.querySelector("input")).toBeNull();
    expect(store.api).toHaveBeenCalledTimes(1);

    await act(async () => click(host.querySelector("button[aria-label='Rename this PC']")!));
    input = host.querySelector("input")!;
    input.value = "   ";
    await act(async () => key(input, "Enter"));
    expect(store.api).toHaveBeenCalledTimes(1);

    store.api.mockResolvedValueOnce({ name: "Home" });
    input.value = " Home ";
    await act(async () => key(input, "Enter"));
    expect(store.api).toHaveBeenLastCalledWith("/api/devices/name", { method: "PUT", body: JSON.stringify({ name: "Home" }) });
    expect(host.querySelector("input")).toBeNull();
    expect(host.querySelector("[data-device-id=home]")!.textContent).toContain("Home");
  });
});
