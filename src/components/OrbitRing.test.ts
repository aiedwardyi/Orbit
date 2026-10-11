// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BotAvatar } from "./Avatar";
import { workingRingStyle } from "./OrbitRing";
import { DockedPresence, TurnPresence } from "./TurnPresence";

function reducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches && query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe("orbit ring geometry", () => {
  it.each([16, 24, 36])("follows a circle and a rounded square at %ipx", (size) => {
    const circle = workingRingStyle({ size, crop: "circle", image: true });
    const rounded = workingRingStyle({ size, crop: "rounded", image: true });
    const squircle = workingRingStyle({ size, crop: "mascot", mascotStyle: "squircle", image: false });
    const icon = workingRingStyle({ size, crop: "mascot", mascotStyle: "icon-31", image: false });
    expect(circle.inset).toBe(-2);
    expect(circle.borderRadius).toBe(size / 2 + 2);
    expect(rounded.inset).toBe(-2);
    expect(rounded.borderRadius).toBeCloseTo(size * 0.22 + 2);
    expect(squircle.borderRadius).not.toBe(circle.borderRadius);
    expect(icon.borderRadius).not.toBe(squircle.borderRadius);
    expect(String(squircle.top)).not.toBe(String(icon.top));
  });

  it("hugs the squircle art, not the square element", () => {
    const style = workingRingStyle({ size: 36, crop: "mascot", mascotStyle: "squircle", image: false });
    expect(style.top).toBe("3.63px");
    expect(style.borderRadius).toBe("9.88px");
  });
});

describe("orbit ring presence", () => {
  it("renders the ring only while the working row is up", () => {
    reducedMotion(false);
    const working = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "Waiting for the model" }));
    expect(working).toContain("data-orbit-ring");
    expect(working).toContain("orbit-ring-spin");
    expect(working).toContain("Waiting for the model");
    expect(renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: false }))).not.toContain("data-orbit-ring");
    expect(renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, docked: true }))).not.toContain("data-orbit-ring");
    const docked = renderToStaticMarkup(createElement(DockedPresence, { avatar: null, label: "Thinking", live: true }));
    expect(docked).toContain("data-orbit-ring");
    expect(renderToStaticMarkup(createElement(DockedPresence, { avatar: null, label: "Thinking", live: false }))).not.toContain("data-orbit-ring");
    vi.unstubAllGlobals();
  });

  it("omits the ring under reduced motion and keeps the label", () => {
    reducedMotion(true);
    const markup = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "Waiting for the model" }));
    expect(markup).not.toContain("data-orbit-ring");
    expect(markup).toContain("thinking-shimmer");
    expect(markup).toContain("thinking-sheen");
    expect(markup).toContain("Waiting for the model");
    const docked = renderToStaticMarkup(createElement(DockedPresence, { avatar: null, label: "Thinking", live: true }));
    expect(docked).not.toContain("data-orbit-ring");
    expect(docked).toContain("Thinking");
    vi.unstubAllGlobals();
  });

  it("rings the working-row bot avatar on its own shape", () => {
    reducedMotion(false);
    const markup = renderToStaticMarkup(createElement(TurnPresence, {
      avatar: createElement(BotAvatar, { bot: { name: "A", color: "pink", mascotStyle: "squircle" }, size: 36 }),
      visible: true,
      label: "Waiting for the model",
    }));
    expect(markup).toContain("data-orbit-ring");
    expect(markup).toContain("9.88px");
    expect(markup).toContain("mascot-avatar");
    vi.unstubAllGlobals();
  });

  it("does not ring an avatar outside the working row", () => {
    reducedMotion(false);
    const markup = renderToStaticMarkup(createElement(BotAvatar, { bot: { name: "A", color: "pink" }, size: 36 }));
    expect(markup).not.toContain("data-orbit-ring");
    expect(markup).toContain("mascot-avatar");
    vi.unstubAllGlobals();
  });
});
