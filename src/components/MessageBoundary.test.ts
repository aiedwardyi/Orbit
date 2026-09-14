/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageBoundary } from "./TurnPresence";

function Thrower({ text }: { text: string }) {
  if (text.startsWith("bad")) throw new Error("boom");
  return createElement("span", null, text);
}

function renderText(host: Element, root: ReturnType<typeof createRoot>, text: string) {
  act(() => {
    root.render(createElement(MessageBoundary, { fallbackText: text, children: createElement(Thrower, { text }) }));
  });
  return host.textContent ?? "";
}

describe("MessageBoundary streaming reset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries the render on each new delta instead of sticking on the first bad one", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      expect(renderText(host, root, "bad partial")).toContain("bad partial");
      expect(renderText(host, root, "good delta")).toContain("good delta");
      expect(renderText(host, root, "bad again")).toContain("bad again");
      expect(renderText(host, root, "recovered")).toContain("recovered");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
