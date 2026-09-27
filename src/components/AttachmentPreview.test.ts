// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ShownImage } from "./AttachmentPreview";

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

  it("is not clickable once the image fails to load", async () => {
    const { host, root } = await renderShownImage("/a/b/abc-123.png");
    try {
      const img = host.querySelector("img")!;
      await act(async () => img.dispatchEvent(new Event("error")));
      expect(host.querySelector("button")).toBeNull();
      expect(host.textContent).toContain("Image not available");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
