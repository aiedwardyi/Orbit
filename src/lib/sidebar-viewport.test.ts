import "../components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fitSidebarWidth } from "./sidebar-preferences";
import { useSidebarViewportWidth } from "./sidebar-viewport";

let root: Root;
let renders: number;
const originalWidth = window.innerWidth;

function Probe({ aside = 0 }: { aside?: number }) {
  renders++;
  const viewport = useSidebarViewportWidth(aside);
  return createElement("span", null, fitSidebarWidth(480, viewport, aside));
}

async function resize(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  await act(async () => window.dispatchEvent(new Event("resize")));
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  renders = 0;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
});

describe("sidebar viewport", () => {
  it("does not rerender while every sidebar width still fits", async () => {
    await act(async () => root.render(createElement(Probe)));
    const before = renders;
    for (let step = 1; step <= 60; step++) await resize(step <= 30 ? 1440 - step * 18 : 900 + (step - 30) * 18);
    expect(renders).toBe(before);
    expect(document.body.textContent).toBe("480");
  });

  it("keeps the same fit at narrow and drawer widths", async () => {
    await act(async () => root.render(createElement(Probe)));
    for (const width of [850, 800, 768, 767, 600, 1440]) {
      await resize(width);
      expect(document.body.textContent).toBe(String(fitSidebarWidth(480, width)));
    }
  });

  it("updates immediately when bot details changes the available width", async () => {
    await act(async () => root.render(createElement(Probe, { aside: 400 })));
    await resize(1000);
    expect(document.body.textContent).toBe("220");
    await act(async () => root.render(createElement(Probe, { aside: 0 })));
    expect(document.body.textContent).toBe("480");
    await act(async () => root.render(createElement(Probe, { aside: 400 })));
    expect(document.body.textContent).toBe("220");
    await resize(1440);
    expect(document.body.textContent).toBe("480");
  });
});
