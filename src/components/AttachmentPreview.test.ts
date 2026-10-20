// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import { AttachmentPreviewDialog, ShownImage } from "./AttachmentPreview";

// SAFETY: happy-dom has no act flag; the test sets the one React reads.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderShownImage(name: string, caption?: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ShownImage, { name, caption })));
  return { host, root };
}

const dialog = () => document.body.querySelector('[role="dialog"]');
const click = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ShownImage", () => {
  it("opens the preview dialog on click, with a download link to the original file", async () => {
    const { host, root } = await renderShownImage("/a/b/abc-123.png", "a photo");
    try {
      const button = host.querySelector("button")!;
      expect(button.getAttribute("aria-label")).toBe("Open image abc-123.png");
      expect(dialog()).toBeNull();

      await act(async () => click(button));

      expect(dialog()).not.toBeNull();
      const downloadLink = dialog()!.querySelector("a[download]")!;
      expect(downloadLink.getAttribute("href")).toBe("/api/attachments/abc-123.png");
      expect(downloadLink.getAttribute("download")).toBe("abc-123.png");

      await act(async () => click(dialog()!.querySelector('[aria-label="Close image preview"]')!));
      expect(dialog()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("stays closed after the preview fades out", async () => {
    const { host, root } = await renderShownImage("/a/b/abc-123.png");
    try {
      await act(async () => click(host.querySelector("button")!));
      await act(async () => click(dialog()!.querySelector('[aria-label="Close image preview"]')!));
      await act(() => new Promise<void>((done) => setTimeout(done, PRESENCE_EXIT_MS + 60)));
      expect(document.body.querySelector('[aria-label="Preview abc-123.png"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("drops the preview once the image fails to load", async () => {
    const { host, root } = await renderShownImage("/a/b/abc-123.png");
    try {
      const img = host.querySelector("img")!;
      await act(async () => img.dispatchEvent(new Event("error")));
      expect(host.querySelector('[aria-label^="Open image"]')).toBeNull();
      expect(host.textContent).toContain("Image not available");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("shows the image after a failed load retries successfully", async () => {
    vi.useFakeTimers();
    const { host, root } = await renderShownImage("/a/b/abc-123.png");
    try {
      const first = host.querySelector("img")!;
      expect(first.getAttribute("src")).toBe("/api/attachments/abc-123.png");
      await act(async () => first.dispatchEvent(new Event("error")));
      expect(host.querySelector("img")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      const second = host.querySelector("img")!;
      expect(second.getAttribute("src")).toBe("/api/attachments/abc-123.png?retry=1");
      await act(async () => second.dispatchEvent(new Event("load")));
      expect(host.querySelector("img")).not.toBeNull();
      expect(host.textContent).not.toContain("Image not available");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  });
});

describe("AttachmentPreviewDialog viewer image", () => {
  const image = { src: "/api/attachments/abc-123.png", name: "abc-123.png" };

  async function renderDialog(onClose: () => void) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(AttachmentPreviewDialog, { image, onClose })));
    const stage = document.body.querySelector("[data-image-stage]") as HTMLElement;
    // happy-dom reports no layout, so the zoom frame measures nothing.
    for (const [key, value] of [["clientWidth", 800], ["clientHeight", 600]] as const) {
      Object.defineProperty(stage, key, { value, configurable: true });
    }
    const img = stage.querySelector("img")!;
    Object.defineProperties(img, {
      naturalWidth: { value: 400, configurable: true },
      naturalHeight: { value: 300, configurable: true },
    });
    await act(async () => img.dispatchEvent(new Event("load")));
    return { host, root, stage, img };
  }

  it("leaves the viewer image hit-testable for the native menu", async () => {
    const { host, root } = await renderDialog(() => {});
    try {
      const img = document.body.querySelector("[data-image-stage] img")!;
      expect(img.classList.contains("pointer-events-none")).toBe(false);
      expect(img.getAttribute("draggable")).toBe("false");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("still pans and zooms from a pointer event on the image", async () => {
    const { host, root, stage, img } = await renderDialog(() => {});
    try {
      const down = new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0, clientX: 60, clientY: 70, pointerId: 7,
      });
      await act(async () => img.dispatchEvent(down));
      expect(down.defaultPrevented).toBe(true);
      const up = new PointerEvent("pointerup", { bubbles: true, clientX: 60, clientY: 70, pointerId: 7 });
      await act(async () => img.dispatchEvent(up));
      expect(stage.getAttribute("data-zoom")).not.toBe("1");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("does not backdrop-close from a pointer on the image", async () => {
    const onClose = vi.fn();
    const { host, root, img } = await renderDialog(onClose);
    try {
      await act(async () => {
        img.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 60, clientY: 70, pointerId: 9 }));
        img.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 60, clientY: 70, pointerId: 9 }));
      });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
