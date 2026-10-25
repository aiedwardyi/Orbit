// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, t } from "@/lib/i18n";
import { StoreProvider } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  onmessage: (() => void) | null = null;
  close = vi.fn();
}

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mountComposer({ hold = false } = {}) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const bodies: number[] = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).includes("/api/attachments")) return Response.json({ error: "not in this test" }, { status: 404 });
    const bytes = (await new Response(init?.body).arrayBuffer()).byteLength;
    bodies.push(bytes);
    if (!bytes) return Response.json({ error: "empty image" }, { status: 400 });
    if (hold) await held;
    return Response.json({ path: "/tmp/shot.png", mime: "image/png", bytes });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null,
    createElement(StoreProvider, null, createElement(Composer, {})),
  )));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return {
    host,
    bodies,
    release,
    notice: () => host.querySelector(".bg-warning\\/10 > span")?.textContent ?? null,
    chips: () => host.querySelectorAll('[aria-label="Remove file"]').length,
  };
}

const image = () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
const emptyImage = () => new File([], "image.png", { type: "image/png" });

const paste = (host: HTMLElement, file: File) => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [file], getData: () => "" } });
  host.querySelector("textarea")!.dispatchEvent(event);
};

const intakes: Array<[string, (host: HTMLElement) => void]> = [
  ["paste", (host) => paste(host, image())],
  ["pick", (host) => {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [image()], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }],
  ["drop", () => {
    const event = new Event("drop", { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [image()] } });
    window.dispatchEvent(event);
  }],
];

describe("0-byte image paste", () => {
  it("reads the image again through the desktop bridge and attaches it", async () => {
    const readClipboardImage = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
    vi.stubGlobal("ogb", { readClipboardImage });
    const composer = await mountComposer();
    await act(async () => paste(composer.host, emptyImage()));
    await vi.waitFor(() => expect(composer.chips()).toBe(1));
    expect(readClipboardImage).toHaveBeenCalledTimes(1);
    expect(composer.bodies).toEqual([4]);
    expect(composer.notice()).toBeNull();
  });

  it.each([
    ["the desktop bridge", { readClipboardImage: async () => null }],
    ["phone and web", undefined],
  ])("shows the plain notice and uploads nothing when %s has no image left", async (_name, ogb) => {
    if (ogb) vi.stubGlobal("ogb", ogb);
    const composer = await mountComposer();
    await act(async () => paste(composer.host, emptyImage()));
    await vi.waitFor(() => expect(composer.notice()).toBe(t("composer.pasteImageFailed")));
    expect(composer.bodies).toEqual([]);
    expect(composer.chips()).toBe(0);
  });
});

describe("attachment notice", () => {
  it.each(intakes)("clears once a later %s attaches", async (_name, intake) => {
    const composer = await mountComposer();
    await act(async () => paste(composer.host, emptyImage()));
    await vi.waitFor(() => expect(composer.notice()).not.toBeNull());
    await act(async () => intake(composer.host));
    await vi.waitFor(() => expect(composer.chips()).toBe(1));
    expect(composer.notice()).toBeNull();
  });

  it.each(intakes)("stays when a %s started before it attaches", async (_name, intake) => {
    const composer = await mountComposer({ hold: true });
    await act(async () => intake(composer.host));
    await vi.waitFor(() => expect(composer.bodies).toEqual([3]));
    await act(async () => paste(composer.host, emptyImage()));
    await vi.waitFor(() => expect(composer.notice()).toBe(t("composer.pasteImageFailed")));
    await act(async () => composer.release());
    await vi.waitFor(() => expect(composer.chips()).toBe(1));
    expect(composer.notice()).toBe(t("composer.pasteImageFailed"));
  });

  it("clears when the draft is sent", async () => {
    const composer = await mountComposer();
    const box = composer.host.querySelector("textarea")!;
    await act(async () => paste(composer.host, emptyImage()));
    await vi.waitFor(() => expect(composer.notice()).not.toBeNull());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "hi");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })));
    expect(box.value).toBe("");
    expect(composer.notice()).toBeNull();
  });
});
