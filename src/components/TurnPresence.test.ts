// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DockedPresence, TurnPresence } from "./TurnPresence";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("turn presence", () => {
  it("keeps the wait label while no text has arrived", () => {
    const markup = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "Responding" }));
    expect(markup).toContain("turn-presence");
    expect(markup).toContain("Responding");
  });

  it("leaves at once when the mascot docks under live text", () => {
    expect(renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: false, docked: true }))).toBe("");
  });

  it("docks with its activity label while the reply types out", () => {
    const markup = renderToStaticMarkup(createElement(DockedPresence, { avatar: null, label: "Responding", live: true }));
    expect(markup).toContain("data-turn-mascot");
    expect(markup).toContain("turn-mascot-in");
    expect(markup).toContain("Responding");
  });

  it("fades out in place at turn end, then leaves", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = (live: boolean) => act(async () => root.render(createElement(DockedPresence, { avatar: null, label: "Responding", live })));
    try {
      await render(true);
      await render(false);
      const mascot = host.querySelector("[data-turn-mascot]");
      expect(mascot?.className).toContain("turn-mascot-out");
      expect(mascot?.getAttribute("aria-hidden")).toBe("true");
      expect(host.textContent).not.toContain("Responding");
      await act(async () => { await sleep(320); });
      expect(host.innerHTML).toBe("");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
