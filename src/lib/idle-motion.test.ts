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
    expect(root.getAttribute("data-orbit-idle")).toBe("");
    window.dispatchEvent(new PointerEvent("pointerdown"));
    expect(root.hasAttribute("data-orbit-idle")).toBe(true);
    window.dispatchEvent(new Event("focus"));
    expect(root.hasAttribute("data-orbit-idle")).toBe(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.hasAttribute("data-orbit-idle")).toBe(true);
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
    expect(root.hasAttribute("data-orbit-idle")).toBe(true);
    stop();
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
});
