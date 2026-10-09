import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
});
