// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ModelPicker.css"), "utf8");

function closeTop({ caption, win32 }: { caption: string; win32: boolean }) {
  document.head.innerHTML = `<style>${css}</style>`;
  document.documentElement.style.setProperty("--orbit-caption-height", caption);
  if (win32) document.documentElement.dataset.orbitCaption = "win32";
  document.body.innerHTML = '<div class="model-cross-backdrop"><header class="model-cross-header"></header></div>';
  const top = getComputedStyle(document.querySelector(".model-cross-header")!).top;
  return (top.match(/-?\d+(\.\d+)?(?=px)/g) ?? []).reduce((sum, n) => sum + Number(n), 0);
}

describe("ModelPicker close button", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-orbit-caption");
  });

  it("follows the desktop caption strip height", () => {
    const tall = closeTop({ caption: "40px", win32: true });
    expect(tall - closeTop({ caption: "32px", win32: true })).toBe(8);
    expect(closeTop({ caption: "32px", win32: true })).toBeGreaterThanOrEqual(32);
  });

  it("stays at the base offset without a caption strip", () => {
    expect(closeTop({ caption: "32px", win32: false })).toBe(20);
  });
});
