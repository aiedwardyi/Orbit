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

      await act(async () => click(dialog()!.querySelector('[aria-label="Close Image Preview"]')!));
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
      await act(async () => click(dialog()!.querySelector('[aria-label="Close Image Preview"]')!));
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
      naturalWidth: { value: 3216, configurable: true },
      naturalHeight: { value: 4974, configurable: true },
    });
    await act(async () => img.dispatchEvent(new Event("load")));
    return { host, root, stage, img };
  }

  const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const pointer = (img: Element, type: string, x = 350, y = 290, pointerType = "mouse", pointerId = 1) => img.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId, pointerType,
  }));

  it.each(["mouse", "touch"])("double %s toggles native and fit while a single action leaves scale alone", async (pointerType) => {
    const { root, stage, img } = await renderDialog(() => {});
    try {
      const fit = Number(stage.dataset.zoom);
      await act(async () => { pointer(img, "pointerdown", 350, 290, pointerType); pointer(img, "pointerup", 350, 290, pointerType); });
      await frame();
      expect(Number(stage.dataset.zoom)).toBe(fit);
      await act(async () => { pointer(img, "pointerdown", 350, 290, pointerType); pointer(img, "pointerup", 350, 290, pointerType); });
      await frame();
      expect(Number(stage.dataset.zoom)).toBe(1);
      await act(async () => {
        pointer(img, "pointerdown", 350, 290, pointerType); pointer(img, "pointerup", 350, 290, pointerType);
        pointer(img, "pointerdown", 350, 290, pointerType); pointer(img, "pointerup", 350, 290, pointerType);
      });
      await frame();
      expect(Number(stage.dataset.zoom)).toBe(fit);
    } finally { await act(async () => root.unmount()); }
  });

  it("zooms with plain wheel, line wheel and Ctrl wheel", async () => {
    const { root, stage, img } = await renderDialog(() => {});
    try {
      let previous = Number(stage.dataset.zoom);
      for (const event of [{ deltaY: -120 }, { deltaY: -2, deltaMode: 1 }, { deltaY: -120, ctrlKey: true }]) {
        const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 400, clientY: 300, ...event });
        Object.defineProperties(wheel, { clientX: { value: 400 }, clientY: { value: 300 } });
        await act(async () => img.dispatchEvent(wheel));
        expect(wheel.defaultPrevented).toBe(true);
        await frame();
        expect(Number(stage.dataset.zoom)).toBeGreaterThan(previous);
        previous = Number(stage.dataset.zoom);
      }
    } finally { await act(async () => root.unmount()); }
  });

  it.each([{}, { ctrlKey: true }, { metaKey: true }])("owns zoom keys with modifier %j", async (modifiers) => {
    const { root, stage } = await renderDialog(() => {});
    try {
      const fit = Number(stage.dataset.zoom);
      for (const key of ["+", "=", "-", "0"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
        await act(async () => window.dispatchEvent(event));
        await frame();
        expect(event.defaultPrevented).toBe(true);
        expect(Number(stage.dataset.zoom)).toBe(key === "0" ? fit : key === "-" ? fit * 1.25 : key === "=" ? fit * 1.25 * 1.25 : fit * 1.25);
      }
    } finally { await act(async () => root.unmount()); }
  });

  it("traps focus, makes the chat inert, closes with Escape and restores focus", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const { root, host } = await renderDialog(onClose);
    try {
      expect(host.inert).toBe(true);
      const controls = dialog()!.querySelectorAll<HTMLElement>("a, button");
      controls[controls.length - 1].focus();
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
      expect(document.activeElement).toBe(controls[0]);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally { await act(async () => root.unmount()); }
    expect(host.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("keeps Close and Download available after failure and retries the same source", async () => {
    const { root, img } = await renderDialog(() => {});
    try {
      await act(async () => img.dispatchEvent(new Event("error")));
      expect(dialog()!.querySelector("a[download]")?.getAttribute("href")).toBe(image.src);
      expect(dialog()!.querySelector('[aria-label="Close Image Preview"]')).not.toBeNull();
      const retry = [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
      await act(async () => click(retry));
      expect(dialog()!.querySelector("img")?.getAttribute("src")).toBe(image.src + "?retry=1");
    } finally { await act(async () => root.unmount()); }
  });

  it("cancels downward dismiss when a second finger starts a pinch", async () => {
    const onClose = vi.fn();
    const { root, img, stage } = await renderDialog(onClose);
    try {
      await act(async () => {
        pointer(img, "pointerdown", 300, 200, "touch", 1);
        pointer(img, "pointermove", 300, 340, "touch", 1);
        pointer(img, "pointerdown", 400, 340, "touch", 2);
        pointer(img, "pointermove", 500, 340, "touch", 2);
        pointer(img, "pointerup", 500, 340, "touch", 2);
        pointer(img, "pointerup", 300, 340, "touch", 1);
      });
      await frame();
      expect(onClose).not.toHaveBeenCalled();
      expect(Number(stage.dataset.zoom)).toBeGreaterThan(Number(stage.clientHeight) / 4974);
      expect(stage.style.transform).toBe("");
    } finally { await act(async () => root.unmount()); }
  });

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

  it("single clicks leave the image scale unchanged", async () => {
    const { host, root, stage, img } = await renderDialog(() => {});
    try {
      const before = stage.getAttribute("data-zoom");
      const down = new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0, clientX: 60, clientY: 70, pointerId: 7,
      });
      await act(async () => img.dispatchEvent(down));
      expect(down.defaultPrevented).toBe(true);
      const up = new PointerEvent("pointerup", { bubbles: true, clientX: 60, clientY: 70, pointerId: 7 });
      await act(async () => img.dispatchEvent(up));
      expect(stage.getAttribute("data-zoom")).toBe(before);
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
