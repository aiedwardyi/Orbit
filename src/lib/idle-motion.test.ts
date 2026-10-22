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

  it("steps only live indicator sharp rings while blurred and visible", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
    const rule = css.match(/(html\[data-orbit-idle="blur"\][^{]+)\{([^}]+)\}/);
    expect(rule).not.toBeNull();
    const [, selector, declarations] = rule!;
    expect(css.indexOf(rule![0])).toBeGreaterThan(css.indexOf("animation-play-state: paused !important"));
    expect(declarations).toContain("animation-play-state: running !important;");
    expect(declarations).toContain("animation-timing-function: steps(24, end);");
    expect(css).toContain("animation: orbit-ring-spin 2.4s linear infinite;");
    expect(css.match(/@keyframes orbit-ring-spin \{\s*to \{([^}]+)\}/)?.[1].trim()).toBe("transform: rotate(1turn);");
    const host = document.body.appendChild(document.createElement("div"));
    host.innerHTML = `
      <div data-turn-mascot class="turn-mascot-in">
        <span class="orbit-ring orbit-ring-halo"><span id="halo" class="orbit-ring-spin"></span></span>
        <span class="orbit-ring"><span id="sharp" class="orbit-ring-spin"></span></span>
        <span class="thinking-sheen"><span></span></span>
        <span class="mascot-avatar"><span class="mascot-idle"></span><span class="mascot-blink"></span></span>
      </div>
      <div data-turn-mascot class="turn-mascot-docked turn-mascot-in">
        <span class="orbit-ring orbit-ring-halo"><span class="orbit-ring-hole"><span class="orbit-ring-spin"></span></span></span>
        <span class="orbit-ring orbit-ring--hole"><span id="docked" class="orbit-ring-spin"></span></span>
      </div>
      <div data-turn-mascot class="turn-mascot-out"><span class="orbit-ring"><span class="orbit-ring-spin"></span></span></div>
      <aside><span class="orbit-mark-rings"></span><span class="orbit-ring"><span class="orbit-ring-spin"></span></span></aside>
      <span class="animate-spin"></span>
      <span data-orbit-rainbow><span></span></span>
    `;
    try {
      root.setAttribute("data-orbit-idle", "blur");
      expect([...document.querySelectorAll(selector.trim())].map((node) => node.id)).toEqual(["sharp", "docked"]);
      root.setAttribute("data-orbit-idle", "hidden");
      expect(document.querySelectorAll(selector.trim())).toHaveLength(0);
      root.removeAttribute("data-orbit-idle");
      expect(document.querySelectorAll(selector.trim())).toHaveLength(0);
    } finally {
      host.remove();
    }
  });
});
