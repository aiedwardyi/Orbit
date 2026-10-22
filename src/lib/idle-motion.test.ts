// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startIdleMotion } from "./idle-motion";

const root = document.documentElement;

afterEach(() => {
  root.removeAttribute("data-orbit-idle");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function focused() {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
}

describe("idle motion attribute", () => {
  it("sets data-orbit-idle on blur and on hidden, and clears it on focus", () => {
    focused();
    const stop = startIdleMotion(root);
    expect(root.hasAttribute("data-orbit-idle")).toBe(false);
    window.dispatchEvent(new Event("blur"));
    expect(root.getAttribute("data-orbit-idle")).toBe("blur");
    window.dispatchEvent(new PointerEvent("pointerdown"));
    expect(root.hasAttribute("data-orbit-idle")).toBe(true);
    window.dispatchEvent(new Event("focus"));
    expect(root.hasAttribute("data-orbit-idle")).toBe(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.getAttribute("data-orbit-idle")).toBe("hidden");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(root.hasAttribute("data-orbit-idle")).toBe(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.hasAttribute("data-orbit-idle")).toBe(false);
    stop();
  });

  it("re-reads focus on a visibility change with no focus or blur event", () => {
    focused();
    const stop = startIdleMotion(root);
    window.dispatchEvent(new Event("blur"));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.hasAttribute("data-orbit-idle")).toBe(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.getAttribute("data-orbit-idle")).toBe("blur");
    stop();
  });

  it.each(["visible", "hidden"] as const)("initializes an unfocused %s document", (visibility) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
    const stop = startIdleMotion(root);
    expect(root.getAttribute("data-orbit-idle")).toBe(visibility === "visible" ? "blur" : "hidden");
    stop();
    expect(root.hasAttribute("data-orbit-idle")).toBe(false);
  });

  it("keeps a hidden document paused through focus and blur events", () => {
    focused();
    const stop = startIdleMotion(root);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(root.getAttribute("data-orbit-idle")).toBe("hidden");
    window.dispatchEvent(new Event("blur"));
    expect(root.getAttribute("data-orbit-idle")).toBe("hidden");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.getAttribute("data-orbit-idle")).toBe("blur");
    stop();
    window.dispatchEvent(new Event("blur"));
    expect(root.hasAttribute("data-orbit-idle")).toBe(false);
  });

  it("never sets data-orbit-idle while focused with no input", () => {
    vi.useFakeTimers();
    focused();
    const stop = startIdleMotion(root);
    vi.advanceTimersByTime(120_000);
    expect(root.hasAttribute("data-orbit-idle")).toBe(false);
    window.dispatchEvent(new PointerEvent("pointermove"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    vi.advanceTimersByTime(120_000);
    expect(root.hasAttribute("data-orbit-idle")).toBe(false);
    stop();
  });

  it("pauses background loops and leaves the needs-you pulse running", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
    const rule = css.slice(css.indexOf("html[data-orbit-idle]"));
    expect(rule).toContain(".mascot-avatar .mascot-idle");
    expect(rule).toContain(".mascot-avatar .mascot-blink");
    expect(rule).toContain(".orbit-mark-rings");
    expect(rule).toContain(".orbit-ring-spin");
    expect(rule).toContain(".thinking-sheen");
    expect(rule).toContain(".animate-spin");
    expect(rule).toContain("[data-orbit-rainbow] > span");
    expect(rule).toContain("animation-play-state: paused");
    expect(rule.slice(0, rule.indexOf("}"))).toContain("animation-play-state: paused !important");
    expect(rule).not.toContain("needs-you-pulse");
    expect(rule).not.toContain("arrival-glow");
    expect(rule).not.toContain("unread-ring");
    expect(rule).not.toContain("term-blink");
    expect(rule).not.toContain("maus-working");
  });

  it("pauses the theme colors ring with the rainbow, changing only its colors", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
    const composer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../components/Composer.tsx"), "utf8");
    expect(composer).toContain('data-orbit-rainbow={theme ? "theme" : ""}');
    const start = css.indexOf('[data-orbit-rainbow="theme"] > span {');
    expect(start).toBeGreaterThan(-1);
    const theme = css.slice(start, css.indexOf("}", start));
    expect(theme).toContain("var(--color-accent)");
    expect(theme).not.toContain("animation");
    expect(css).toContain("html[data-orbit-idle] [data-orbit-composer-frame]:focus-within > [data-orbit-rainbow] > span {");
  });

  it("keeps every indicator ring paused while blurred and visible", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
    expect(css).not.toContain('html[data-orbit-idle="blur"]');
    const rule = css.slice(css.indexOf("html[data-orbit-idle] :is("));
    const selector = rule.slice(0, rule.indexOf("{")).replace(/\s+/g, " ").replace(/\( | \)/g, (m) => m.trim());
    const host = document.body.appendChild(document.createElement("div"));
    host.innerHTML = `
      <div data-turn-mascot class="turn-mascot-in">
        <span class="orbit-ring orbit-ring-halo"><span id="halo" class="orbit-ring-spin"></span></span>
        <span class="orbit-ring"><span id="sharp" class="orbit-ring-spin"></span></span>
      </div>
      <div data-turn-mascot class="turn-mascot-docked turn-mascot-in">
        <span class="orbit-ring orbit-ring--hole"><span id="docked" class="orbit-ring-spin"></span></span>
      </div>
    `;
    try {
      root.setAttribute("data-orbit-idle", "blur");
      expect([...document.querySelectorAll(selector)].map((node) => node.id)).toEqual(["halo", "sharp", "docked"]);
      root.removeAttribute("data-orbit-idle");
      expect(document.querySelectorAll(selector)).toHaveLength(0);
    } finally {
      host.remove();
    }
  });

  it("hides only the turn ring while idle, so a paused ring never reads as hung", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
    const start = css.indexOf("html[data-orbit-idle] [data-turn-mascot] .orbit-ring {");
    expect(start).toBeGreaterThan(-1);
    const selector = css.slice(start, css.indexOf("{", start)).trim();
    expect(css.slice(start, css.indexOf("}", start))).toContain("visibility: hidden");
    const host = document.body.appendChild(document.createElement("div"));
    host.innerHTML = `
      <div data-turn-mascot><span id="turn" class="orbit-ring"></span><span id="timer">(42s)</span></div>
      <div><span id="sidebar" class="orbit-ring"></span></div>
    `;
    try {
      root.setAttribute("data-orbit-idle", "blur");
      expect([...document.querySelectorAll(selector)].map((node) => node.id)).toEqual(["turn"]);
      root.removeAttribute("data-orbit-idle");
      expect(document.querySelectorAll(selector)).toHaveLength(0);
    } finally {
      host.remove();
    }
  });
});
