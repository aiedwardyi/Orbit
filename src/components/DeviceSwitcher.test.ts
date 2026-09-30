// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => store);

import { I18nProvider } from "@/lib/i18n";
import { DeviceSwitcher, DeviceTag, type DeviceItem } from "./DeviceSwitcher";

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
  delete window.ogb;
  document.body.innerHTML = "";
});

async function renderView(devices: DeviceItem[], navigate = vi.fn(), view: typeof DeviceSwitcher | typeof DeviceTag = DeviceSwitcher) {
  store.api.mockResolvedValue({ devices });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(view, { navigate }))));
  return { host, root, navigate };
}

function setDesktop() {
  const open = vi.fn().mockResolvedValue(true);
  window.ogb = { deviceWindow: { open } } as never;
  return open;
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
    store.api.mockResolvedValue({ devices: [device("home", { current: true, name: "Home" }), device("work")] });
    input.value = " Home ";
    await act(async () => key(input, "Enter"));
    expect(store.api).toHaveBeenCalledWith("/api/devices/name", { method: "PUT", body: JSON.stringify({ name: "Home" }) });
    expect(store.api).toHaveBeenLastCalledWith("/api/devices");
    expect(host.querySelector("input")).toBeNull();
    expect(host.querySelector("[data-device-id=home]")!.textContent).toContain("Home");
  });

  it("shows in the desktop app and opens another PC in its own window", async () => {
    setPhone(false);
    const open = setDesktop();
    const { host, navigate } = await renderView([device("home", { current: true }), device("work", { name: "Work" })]);
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => click(toggle));
    await act(async () => click(host.querySelector("[data-device-id=home]")!));
    expect(open).not.toHaveBeenCalled();
    expect(host.querySelector("ul")).toBeNull();
    await act(async () => click(toggle));
    await act(async () => click(host.querySelector("[data-device-id=work]")!));
    expect(open).toHaveBeenCalledWith("work.tail396477.ts.net", "Work");
    expect(navigate).not.toHaveBeenCalled();
    expect(host.querySelector("ul")).toBeNull();
  });
});

describe("DeviceTag", () => {
  const pcs = [device("home", { current: true, name: "Home" }), device("work")];

  it("names this PC on phones and remote windows", async () => {
    setPhone(true);
    const { host } = await renderView(pcs, vi.fn(), DeviceTag);
    expect(host.querySelector("[data-device-tag]")!.textContent).toBe("Home");
  });

  it("is hidden in the local desktop app", async () => {
    setPhone(false);
    setDesktop();
    const { host } = await renderView(pcs, vi.fn(), DeviceTag);
    expect(host.textContent).toBe("");
    expect(store.api).not.toHaveBeenCalled();
  });

  it("is hidden with a single PC", async () => {
    setPhone(true);
    const { host } = await renderView([pcs[0]], vi.fn(), DeviceTag);
    expect(host.textContent).toBe("");
  });
});
