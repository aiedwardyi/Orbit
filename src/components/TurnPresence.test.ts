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

  it.each([
    ["terminal", true, "(12s)"],
    ["terminal", false, null],
    ["tui", true, null],
  ])("%s docked live=%s shows its elapsed time", (skin, live, shown) => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    document.documentElement.dataset.skin = skin;
    try {
      const markup = renderToStaticMarkup(createElement(DockedPresence, { avatar: null, label: "Responding", live, since: 88_000 }));
      if (shown) expect(markup).toContain(shown);
      else expect(markup).not.toMatch(/\(\d+s\)/);
    } finally {
      delete document.documentElement.dataset.skin;
      vi.useRealTimers();
    }
  });

  it.each([
    ["wait", "max-w-full", () => createElement(TurnPresence, { avatar: null, visible: true, label: "답변 쓰는 중" })],
    ["docked", "w-max", () => createElement(DockedPresence, { avatar: null, label: "답변 쓰는 중", live: true })],
  ])("keeps the %s label on one line and ends it with an ellipsis", (_name, boxClass, view) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(view());
    const label = host.querySelector(".thinking-shimmer");
    expect(host.querySelector("[data-turn-mascot]")?.className).toContain(boxClass);
    expect(label?.className).toContain("whitespace-nowrap");
    expect(label?.className).toContain("text-ellipsis");
    expect(label?.className).toContain("min-w-0");
    expect(host.querySelector(".thinking-sheen > span")?.className).toContain("text-ellipsis");
  });

  it("keeps the terminal timer from shrinking beside the label", () => {
    document.documentElement.dataset.skin = "terminal";
    try {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(createElement(DockedPresence, { avatar: null, label: "Responding", live: true, since: Date.now() }));
      const timer = [...host.querySelectorAll("span")].find((el) => /^\(\d+s\)$/.test(el.textContent ?? ""));
      expect(timer?.className).toContain("shrink-0");
    } finally {
      delete document.documentElement.dataset.skin;
    }
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
