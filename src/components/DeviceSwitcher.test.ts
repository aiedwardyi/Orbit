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
  host: `${id}.tail1234.ts.net`,
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

async function renderView(
  devices: DeviceItem[],
  navigate = vi.fn(),
  view: typeof DeviceSwitcher | typeof DeviceTag = DeviceSwitcher,
  labeled = false,
  drawerOpen?: boolean,
  iconOnly = false,
) {
  store.api.mockResolvedValue({ devices });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const node = view === DeviceTag
    ? createElement(DeviceTag)
    : createElement(DeviceSwitcher, { navigate, labeled, drawerOpen, iconOnly });
  await act(async () => root.render(createElement(I18nProvider, null, node)));
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
    const { host } = await renderView([device("home", { current: true })], vi.fn(), DeviceTag);
    expect(host.textContent).toBe("");
  });

  it("is hidden off a phone", async () => {
    setPhone(false);
    const { host } = await renderView([device("home", { current: true }), device("work")]);
    expect(host.textContent).toBe("");
  });

  it("leaves the sidebar to the phone header", async () => {
    setPhone(true);
    const { host } = await renderView([device("home", { current: true }), device("work")]);
    expect(host.textContent).toBe("");
  });

  it("marks the current PC and jumps to another from the phone drawer", async () => {
    setPhone(true);
    const { host, navigate } = await renderView(
      [device("home", { current: true }), device("laptop", { offline: true }), device("work")],
      vi.fn(),
      DeviceSwitcher,
      true,
    );
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-label")).toBe("Your PCs");
    expect(toggle.textContent).toBe("home");
    expect(document.querySelector("ul")).toBeNull();
    await act(async () => click(toggle));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("This PC");
    expect(document.body.textContent).toContain("Offline");
    await act(async () => click(document.querySelector("[data-device-id=home]")!));
    expect(navigate).not.toHaveBeenCalled();
    expect(document.querySelector("ul:not([inert])")).toBeNull();
    await act(async () => click(toggle));
    await act(async () => click(document.querySelector("[data-device-id=laptop]")!));
    expect(navigate).toHaveBeenCalledWith("https://laptop.tail1234.ts.net/");
  });

  it("hands the phone jump to Back navigation", async () => {
    setPhone(true);
    store.api.mockResolvedValue({ devices: [device("home", { current: true }), device("work")] });
    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => createRoot(host).render(createElement(I18nProvider, null, createElement(DeviceSwitcher, { labeled: true }))));
    const leave = vi.fn();
    window.addEventListener("orbit:leave", leave);
    await act(async () => click(host.querySelector("button[aria-expanded]")!));
    await act(async () => click(document.querySelector("[data-device-id=work]")!));
    window.removeEventListener("orbit:leave", leave);
    expect(leave).toHaveBeenCalledOnce();
    expect(leave.mock.calls[0][0].detail).toBe("https://work.tail1234.ts.net/");
  });

  it("refreshes devices when the menu opens", async () => {
    setPhone(false);
    setDesktop();
    const { host } = await renderView([device("laptop", { current: true }), device("work")]);
    expect(host.querySelector("button[aria-expanded] .lucide-monitor")).not.toBeNull();
    store.api.mockResolvedValue({ devices: [device("laptop", { current: true, laptop: true }), device("work")] });
    await act(async () => click(host.querySelector("button[aria-expanded]")!));
    expect(store.api).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-device-id=laptop] .lucide-laptop")).not.toBeNull();
  });

  it("renames this PC inline", async () => {
    setPhone(true);
    const { host } = await renderView([device("home", { current: true, name: "EDWARD-PC" }), device("work")], vi.fn(), DeviceSwitcher, true);
    await act(async () => click(host.querySelector("button[aria-expanded]")!));
    expect(document.querySelectorAll("button[aria-label='Rename this PC']")).toHaveLength(1);
    await act(async () => click(document.querySelector("button[aria-label='Rename this PC']")!));
    let input = document.querySelector("input")!;
    expect(input.value).toBe("EDWARD-PC");
    await act(async () => key(input, "Escape"));
    expect(document.querySelector("input")).toBeNull();
    expect(store.api).toHaveBeenCalledTimes(2);

    await act(async () => click(document.querySelector("button[aria-label='Rename this PC']")!));
    input = document.querySelector("input")!;
    input.value = "   ";
    await act(async () => key(input, "Enter"));
    expect(store.api).toHaveBeenCalledTimes(2);

    store.api.mockResolvedValueOnce({ name: "Home" });
    store.api.mockResolvedValue({ devices: [device("home", { current: true, name: "Home" }), device("work")] });
    input.value = " Home ";
    await act(async () => key(input, "Enter"));
    expect(store.api).toHaveBeenCalledWith("/api/devices/name", { method: "PUT", body: JSON.stringify({ name: "Home" }) });
    expect(store.api).toHaveBeenLastCalledWith("/api/devices");
    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelector("[data-device-id=home]")!.textContent).toContain("Home");
  });

  it("closes the phone menu when the drawer shuts", async () => {
    setPhone(true);
    const { host, root } = await renderView(
      [device("home", { current: true }), device("work")],
      vi.fn(),
      DeviceSwitcher,
      true,
      true,
    );
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => click(toggle));
    expect(document.querySelector("ul:not([inert])")).not.toBeNull();
    await act(async () => root.render(createElement(I18nProvider, null, createElement(DeviceSwitcher, { labeled: true, drawerOpen: false }))));
    expect(document.querySelector("ul:not([inert])")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => root.render(createElement(I18nProvider, null, createElement(DeviceSwitcher, { labeled: true, drawerOpen: true }))));
    expect(document.querySelector("ul:not([inert])")).toBeNull();
    expect(host.querySelector("button[aria-expanded]")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows in the desktop app and opens another PC in its own window", async () => {
    setPhone(false);
    const open = setDesktop();
    const { host, navigate } = await renderView([device("home", { current: true }), device("work", { name: "Work" })]);
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => click(toggle));
    await act(async () => click(host.querySelector("[data-device-id=home]")!));
    expect(open).not.toHaveBeenCalled();
    expect(host.querySelector("ul:not([inert])")).toBeNull();
    await act(async () => click(toggle));
    await act(async () => click(host.querySelector("[data-device-id=work]")!));
    expect(open).toHaveBeenCalledWith("work.tail1234.ts.net", "Work");
    expect(navigate).not.toHaveBeenCalled();
    expect(host.querySelector("ul:not([inert])")).toBeNull();
  });

  it("keeps the desktop menu on screen beside a narrow sidebar", async () => {
    setPhone(false);
    setDesktop();
    const { host } = await renderView([device("home", { current: true }), device("work")]);
    const aside = document.createElement("aside");
    document.body.append(aside);
    aside.append(host);
    const box = (left: number, right: number) => new DOMRect(left, 0, right - left, 40);
    vi.spyOn(aside, "getBoundingClientRect").mockReturnValue(box(0, 220));
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(box(0, 204));
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    Object.defineProperty(toggle, "offsetParent", { value: host });
    await act(async () => click(toggle));
    expect(host.querySelector("ul")!.style.right).toBe("-44px");
  });

  it("clamps the desktop menu to a wide sidebar's own edges", async () => {
    setPhone(false);
    setDesktop();
    const { host } = await renderView([device("home", { current: true }), device("work")]);
    const aside = document.createElement("aside");
    document.body.append(aside);
    aside.append(host);
    const box = (left: number, right: number) => new DOMRect(left, 0, right - left, 40);
    vi.spyOn(aside, "getBoundingClientRect").mockReturnValue(box(100, 400));
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(box(100, 204));
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    Object.defineProperty(toggle, "offsetParent", { value: host });
    await act(async () => click(toggle));
    expect(host.querySelector("ul")!.style.right).toBe("-144px");
  });
});

describe("DeviceTag", () => {
  const pcs = [device("home", { current: true, name: "Home" }), device("work")];

  it("names this PC in remote windows", async () => {
    setPhone(false);
    const { host } = await renderView(pcs, vi.fn(), DeviceTag);
    expect(host.querySelector("[data-device-tag]")!.textContent).toBe("Home");
    expect(host.querySelector("[data-device-tag] .lucide-monitor")).not.toBeNull();
  });

  it("stays out of the phone header", async () => {
    setPhone(true);
    const { host } = await renderView(pcs, vi.fn(), DeviceTag);
    expect(host.querySelector("[data-device-tag]")).toBeNull();
    expect(host.querySelector("[data-device-switcher]")).toBeNull();
    expect(host.textContent).toBe("");
    expect(store.api).not.toHaveBeenCalled();
  });

  it("shows this PC's icon and name on the phone drawer", async () => {
    setPhone(true);
    const { host } = await renderView(pcs, vi.fn(), DeviceSwitcher, true);
    const tag = host.querySelector("button[data-device-tag]")!;
    expect(tag.getAttribute("title")).toBe("Home");
    expect(tag.textContent).toBe("Home");
    expect(tag.querySelector(".lucide-monitor")).not.toBeNull();
    expect(store.api).toHaveBeenCalledTimes(1);
  });

  it("shows a laptop icon on a laptop", async () => {
    setPhone(true);
    const { host } = await renderView([device("laptop", { current: true, laptop: true, name: "Laptop" }), device("work")], vi.fn(), DeviceSwitcher, true);
    expect(host.querySelector("[data-device-tag] .lucide-laptop")).not.toBeNull();
    expect(host.querySelector("[data-device-tag]")!.textContent).toBe("Laptop");
  });

  it("shows only a 40 px icon in the phone icon rail and names the PC in its tooltip", async () => {
    setPhone(true);
    const { host } = await renderView(pcs, vi.fn(), DeviceSwitcher, true, undefined, true);
    const tag = host.querySelector("button[data-device-tag]")!;
    expect(tag.textContent).toBe("");
    expect(tag.className).toContain("size-10");
    expect(tag.getAttribute("title")).toBe("Your PCs: Home");
    expect(tag.getAttribute("aria-label")).toBe("Your PCs: Home");
    expect(tag.querySelector(".lucide-monitor")?.getAttribute("width")).toBe("20");
    await act(async () => click(tag));
    expect(document.querySelector("ul")?.className).toContain("fixed");
    expect(document.querySelector("[data-device-id=home]")!.textContent).toContain("This PC");
  });

  it("hides the phone drawer picker with one PC", async () => {
    setPhone(true);
    const { host } = await renderView([pcs[0]], vi.fn(), DeviceSwitcher, true);
    expect(host.textContent).toBe("");
    expect(host.querySelector("[data-device-switcher]")).toBeNull();
  });

  it("portals the phone menu so the drawer cannot clip it", async () => {
    setPhone(true);
    const { host } = await renderView(pcs, vi.fn(), DeviceSwitcher, true);
    const drawer = document.createElement("div");
    drawer.setAttribute("data-phone-drawer", "");
    drawer.append(host);
    await act(async () => click(host.querySelector("button[aria-expanded]")!));
    const menu = document.querySelector("ul");
    expect(menu).not.toBeNull();
    expect(drawer.contains(menu)).toBe(false);
    expect(menu?.className).toContain("fixed");
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
