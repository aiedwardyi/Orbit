// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_EXIT_MS, Presence, usePresence } from "./use-presence";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

let host: HTMLDivElement;
let root: Root;
const seen: Array<{ mounted: boolean; closing: boolean; value: string | null }> = [];

function Probe({ when }: { when: string | null }) {
  const presence = usePresence(when);
  seen.push(presence);
  return presence.mounted ? createElement("div", { "data-probe": presence.value, "data-closing": presence.closing || undefined }) : null;
}

const render = (when: string | null) => act(async () => root.render(createElement(Probe, { when })));
const probe = () => host.querySelector("[data-probe]");

function stubReducedMotion(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  stubReducedMotion(false);
  seen.length = 0;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("usePresence", () => {
  it("stays mounted and closing for the exit fade, then unmounts", async () => {
    await render("settings");
    expect(probe()?.hasAttribute("data-closing")).toBe(false);

    await render(null);
    expect(probe()?.getAttribute("data-probe")).toBe("settings");
    expect(probe()?.hasAttribute("data-closing")).toBe(true);

    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS - 1));
    expect(probe()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(probe()).toBeNull();
  });

  it("never paints an unmounted frame between open and closing", async () => {
    await render("settings");
    await render(null);
    expect(seen.every((presence) => presence.mounted)).toBe(true);
  });

  it("keeps the same surface when it reopens during the exit", async () => {
    await render("settings");
    const first = probe();
    await render(null);
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS / 2));
    await render("usage");
    expect(probe()).toBe(first);
    expect(probe()?.getAttribute("data-probe")).toBe("usage");
    expect(probe()?.hasAttribute("data-closing")).toBe(false);

    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS * 2));
    expect(probe()).toBe(first);
  });

  it("opens and closes instantly with reduced motion", async () => {
    stubReducedMotion(true);
    await render("settings");
    expect(probe()?.hasAttribute("data-closing")).toBe(false);
    await render(null);
    expect(probe()).toBeNull();
    expect(seen.at(-1)).toEqual({ mounted: false, closing: false, value: "settings" });
  });

  it("renders the Presence child with the closing flag", async () => {
    const child = (closing: boolean) => createElement("span", { "data-child": closing ? "closing" : "open" });
    await act(async () => root.render(createElement(Presence, { open: true, children: child })));
    expect(host.querySelector("[data-child]")?.getAttribute("data-child")).toBe("open");
    await act(async () => root.render(createElement(Presence, { open: false, children: child })));
    expect(host.querySelector("[data-child]")?.getAttribute("data-child")).toBe("closing");
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS));
    expect(host.querySelector("[data-child]")).toBeNull();
  });
});

describe("overlay motion styles", () => {
  it("fades a closing surface out over the hook's exit time without catching taps", () => {
    const closing = css.match(/\[data-closing\] \{([^}]*)\}/)?.[1] ?? "";
    expect(closing).toContain(`fade-out ${PRESENCE_EXIT_MS / 1000}s`);
    expect(closing).toContain("forwards");
    expect(closing).toContain("pointer-events: none;");
  });

  it("enters pop, panel and fade surfaces on one timing and curve", () => {
    const timings = ["panel-in", "pop-in", "fade-in"].map((name) => css.match(new RegExp(`--animate-${name}: ${name} ([^;]*);`))?.[1]);
    expect(timings).toEqual(Array(3).fill("0.16s cubic-bezier(0.22, 1, 0.36, 1)"));
  });

  it("drops the enter animations under reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\r?\n {2}\.animate-caret, \.animate-msg-in, \.animate-pop-in, \.animate-panel-in, \.animate-fade-in \{ animation: none; \}/);
  });
});
