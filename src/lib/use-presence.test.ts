// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_EXIT_MS, Presence, usePresence, type Presence as PresenceState } from "./use-presence";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

let host: HTMLDivElement;
let root: Root;
const seen: Array<PresenceState<string | null>> = [];

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
    expect(seen.at(-1)).toMatchObject({ mounted: false, closing: false, enter: false, value: null });
  });

  it("hands back the falsy value once an object surface has faded out", async () => {
    function Holder({ when }: { when: { id: string } | null }) {
      const presence = usePresence(when);
      return presence.value ? createElement("div", { "data-holder": presence.value.id }) : null;
    }
    const show = (when: { id: string } | null) => act(async () => root.render(createElement(Holder, { when })));
    await show({ id: "menu" });
    await show(null);
    expect(host.querySelector("[data-holder]")?.getAttribute("data-holder")).toBe("menu");
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS));
    expect(host.querySelector("[data-holder]")).toBeNull();
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS * 3));
    expect(host.querySelector("[data-holder]")).toBeNull();
  });

  it("enters only on an open from fully shut, never at mount or on a reopen mid-close", async () => {
    await render("settings");
    expect(seen.at(-1)?.enter).toBe(false);
    await render(null);
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS));
    await render("settings");
    expect(seen.at(-1)?.enter).toBe(true);
    await render(null);
    expect(seen.at(-1)).toMatchObject({ closing: true, enter: false });
    await render("settings");
    expect(seen.at(-1)).toMatchObject({ closing: false, enter: false });
  });

  it("cuts a close short when the user did not ask for it", async () => {
    await render("settings");
    await render(null);
    await act(async () => seen.at(-1)!.cut());
    expect(probe()).toBeNull();
  });

  it("holds an open the chat switch left stale until the first commit settles", async () => {
    const calls: boolean[] = [];
    function Lagging() {
      const [stale, setStale] = useState(true);
      useEffect(() => setStale(false), []);
      const child = (closing: boolean) => {
        calls.push(closing);
        return createElement("span", { "data-child": "" });
      };
      return createElement(Presence, { open: stale, afterMount: true, children: child });
    }
    await act(async () => root.render(createElement(Lagging)));
    expect(calls).toEqual([]);
    expect(host.querySelector("[data-child]")).toBeNull();
  });

  it("shows an open still standing after the first commit at its end state, and enters the user's next open", async () => {
    const flags: Array<[boolean, boolean]> = [];
    const child = (closing: boolean, enter: boolean) => {
      flags.push([closing, enter]);
      return createElement("span", { "data-child": "" });
    };
    const show = (open: boolean) => act(async () => root.render(createElement(Presence, { open, afterMount: true, children: child })));
    await show(true);
    expect(host.querySelector("[data-child]")).not.toBeNull();
    expect(flags).toEqual([[false, false]]);
    await show(false);
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS));
    await show(true);
    expect(flags.at(-1)).toEqual([false, true]);
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

  it("folds a closing expand shut over the hook's exit time", () => {
    const closing = css.match(/\[data-expand\]\[data-closing\] \{([^}]*)\}/)?.[1] ?? "";
    expect(closing).toContain(`expand-out ${PRESENCE_EXIT_MS / 1000}s`);
    expect(closing).toContain("forwards");
  });

  it("enters pop, panel, fade and expand surfaces on one timing and curve", () => {
    const timings = ["panel-in", "pop-in", "fade-in", "expand-in"].map((name) => css.match(new RegExp(`--animate-${name}: ${name} ([^;]*);`))?.[1]);
    expect(timings).toEqual(Array(4).fill("0.16s cubic-bezier(0.22, 1, 0.36, 1) var(--motion-head-start)"));
  });

  it("drops the enter animations under reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\r?\n {2}\.animate-caret, \.animate-msg-in, \.animate-pop-in, \.animate-panel-in, \.animate-fade-in, \.animate-expand-in \{ animation: none; \}/);
  });
});
