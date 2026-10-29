// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerAttachments } from "./ComposerAttachments";

describe("ComposerAttachments remove button", () => {
  const markup = renderToStaticMarkup(
    createElement(ComposerAttachments, {
      items: [{ kind: "file", id: "f1", name: "a.txt", path: "C:/a.txt", size: 3 }],
      onAdd: () => {},
      onRemove: () => {},
      onDisplayInChatBox: () => {},
      notice: null,
      onNotice: () => {},
    }),
  );
  const classes = /<button[^>]*aria-label="Remove file"[^>]*class="([^"]*)"|<button[^>]*class="([^"]*)"[^>]*aria-label="Remove file"/.exec(markup);
  const className = classes?.[1] ?? classes?.[2] ?? "";

  it("stays hover-only on a mouse and shows on touch with a 24px target", () => {
    expect(className).toContain("opacity-0");
    expect(className).toContain("group-hover:opacity-100");
    expect(className).toContain("pointer-coarse:opacity-100");
    expect(className).toContain("pointer-coarse:size-6");
  });

  it("gets room in the scrolling row for its corner offset", () => {
    const row = /<div class="([^"]*overflow-x-auto[^"]*)"/.exec(markup)?.[1] ?? "";
    expect(className).toContain("-top-1.5");
    expect(className).toContain("-right-1.5");
    expect(row).toContain("pt-1.5");
    expect(row).toContain("pr-1.5");
    expect(row).not.toContain("-mt-");
  });
});

describe("ComposerAttachments upload chip", () => {
  it("shows name, size and percent, and the x cancels the upload", async () => {
    const onCancelUpload = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const size = 1717986918;
    await act(async () =>
      root.render(
        createElement(ComposerAttachments, {
          items: [{ kind: "upload", id: "u1", name: "meeting.mp4", size, type: "video/mp4", lastModified: 7, sent: Math.ceil(size * 0.37), state: "uploading" }],
          onAdd: () => {},
          onRemove: () => {},
          onCancelUpload,
          onDisplayInChatBox: () => {},
          notice: null,
          onNotice: () => {},
        }),
      ),
    );
    expect(host.textContent).toContain("meeting.mp4");
    expect(host.textContent).toContain("1.6 GB · 37%");
    host.querySelector<HTMLButtonElement>('button[aria-label="Cancel upload"]')!.click();
    expect(onCancelUpload).toHaveBeenCalledWith("u1");
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps the name clear of the touch x when the chip has an action line", () => {
    const nameClass = (state: "uploading" | "failed" | "repick") => {
      const markup = renderToStaticMarkup(
        createElement(ComposerAttachments, {
          items: [{ kind: "upload", id: "u1", name: "meeting.mp4", size: 10, type: "video/mp4", lastModified: 7, sent: 4, state }],
          onAdd: () => {},
          onRemove: () => {},
          onDisplayInChatBox: () => {},
          notice: null,
          onNotice: () => {},
        }),
      );
      return /<div class="([^"]*)">meeting\.mp4<\/div>/.exec(markup)?.[1] ?? "";
    };
    expect(nameClass("uploading")).toContain("truncate");
    expect(nameClass("uploading")).not.toContain("pointer-coarse:pr-5");
    expect(nameClass("failed")).toContain("pointer-coarse:pr-5");
    expect(nameClass("repick")).toContain("pointer-coarse:pr-5");
  });
});
