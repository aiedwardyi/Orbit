// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { MediaViewer } from "./MediaViewer";
import { MediaViewerProvider, ReadableImage } from "./MediaViewerProvider";
import { ChatMarkdown } from "./ChatMarkdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("mdast-util-from-markdown", async (original) => {
  const module = await original<typeof import("mdast-util-from-markdown")>();
  return { ...module, fromMarkdown: vi.fn(module.fromMarkdown) };
});

const image = { src: "/api/attachments/collage.png", name: "collage.png" };
const roots: Root[] = [];
const render = async (element: React.ReactNode) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return { host, root };
};
const stage = () => document.querySelector<HTMLElement>("[data-image-stage]")!;
const pointer = (type: string, x: number, y: number, pointerId = 1) => stage().dispatchEvent(new PointerEvent(type, {
  bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId, pointerType: "touch",
}));
const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
const load = async (w = 3216, h = 4974) => {
  Object.defineProperties(stage(), { clientWidth: { value: 390, configurable: true }, clientHeight: { value: 788, configurable: true } });
  const img = stage().querySelector("img")!;
  Object.defineProperties(img, { naturalWidth: { value: w, configurable: true }, naturalHeight: { value: h, configurable: true } });
  await act(async () => img.dispatchEvent(new Event("load")));
  return img;
};

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("media reader regressions", () => {
  it("does no media parsing for 30 patches of 300 messages while closed, then parses on open", async () => {
    let messages = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "bot" : "user", kind: "text", text: "A reply." }));
    const child = createElement(ReadableImage, image);
    const element = () => createElement(MediaViewerProvider, { threadId: "chat", messages, children: child });
    const { root, host } = await render(element());
    vi.mocked(fromMarkdown).mockClear();
    for (let i = 0; i < 30; i++) {
      messages = messages.map((message, index) => index === 299 ? { ...message, text: `Patch ${i}` } : message);
      await act(async () => root.render(element()));
    }
    expect(vi.mocked(fromMarkdown).mock.calls.length).toBe(0);
    await act(async () => host.querySelector("button")!.click());
    expect(fromMarkdown).toHaveBeenCalledTimes(150);
    expect(document.querySelector("[data-media-viewer]")).not.toBeNull();
  });

  it("leaves a linked markdown image as the link's plain image", async () => {
    const { host } = await render(createElement(ChatMarkdown, { text: "[![Badge](/api/attachments/badge.png)](https://example.com/docs)" }));
    const link = host.querySelector("a")!;
    expect(link.querySelector("img")).not.toBeNull();
    expect(link.querySelector("button")).toBeNull();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => link.querySelector("img")!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-media-viewer]")).toBeNull();
  });

  it.each([false, true])("taps and swipes a loading or broken image (failed %s)", async (failed) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    await render(createElement(MediaViewer, { image, onClose, onNavigate, previous: true, next: true }));
    if (failed) await act(async () => stage().querySelector("img")!.dispatchEvent(new Event("error")));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    const reader = document.querySelector<HTMLElement>("[data-media-viewer]")!;
    await act(async () => { pointer("pointerdown", 190, 300); pointer("pointerup", 190, 300); });
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(reader.dataset.controls).toBe("visible");
    await act(async () => { pointer("pointerdown", 280, 300); pointer("pointermove", 100, 300); pointer("pointerup", 100, 300); });
    expect(onNavigate).toHaveBeenCalledWith(1);
    await act(async () => { pointer("pointerdown", 190, 200); pointer("pointermove", 190, 360); pointer("pointerup", 190, 360); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pans with the finger left after a pinch without dismissing or navigating", async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    await render(createElement(MediaViewer, { image, onClose, onNavigate, next: true }));
    const img = await load();
    await act(async () => {
      pointer("pointerdown", 145, 400, 1); pointer("pointerdown", 245, 400, 2);
      pointer("pointermove", 45, 400, 1); pointer("pointermove", 345, 400, 2);
      pointer("pointerup", 345, 400, 2);
    });
    await frame();
    const before = img.style.transform;
    await act(async () => pointer("pointermove", 100, 480, 1));
    await frame();
    expect(img.style.transform).not.toBe(before);
    await act(async () => pointer("pointerup", 100, 480, 1));
    expect(onClose).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("opens the later duplicate at its own place in the chat", async () => {
    const messages = ["collage", "middle", "collage", "last"].map((name, i) => ({ id: `m${i}`, role: "bot", kind: "text", text: `![Image](/api/attachments/${name}.png)` }));
    const children = messages.map((message, i) => createElement("div", { key: message.id, "data-mid": message.id }, createElement(ReadableImage, { src: `/api/attachments/${i === 1 ? "middle" : i === 3 ? "last" : "collage"}.png` })));
    const { host } = await render(createElement(MediaViewerProvider, { threadId: "chat", messages, children }));
    await act(async () => host.querySelectorAll("button")[2].click());
    expect(document.querySelector("[data-viewer-previous]")).not.toBeNull();
    await act(async () => (document.querySelector("[data-viewer-next]") as HTMLElement).click());
    expect(stage().querySelector("img")!.getAttribute("src")).toBe("/api/attachments/last.png");
  });

  it("uses 2x for the native button and double tap when fit is already native", async () => {
    await render(createElement(MediaViewer, { image, onClose: vi.fn() }));
    await load(96, 64);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".media-viewer-zoom button")];
    await act(async () => buttons[1].click());
    await frame();
    expect(Number(stage().dataset.zoom)).toBe(2);
    await act(async () => buttons[0].click());
    await act(async () => {
      pointer("pointerdown", 195, 394); pointer("pointerup", 195, 394);
      pointer("pointerdown", 195, 394); pointer("pointerup", 195, 394);
    });
    await frame();
    expect(Number(stage().dataset.zoom)).toBe(2);
  });
});
