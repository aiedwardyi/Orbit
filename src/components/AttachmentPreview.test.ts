// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShownImage } from "./AttachmentPreview";

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
