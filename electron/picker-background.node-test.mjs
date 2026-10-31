import assert from "node:assert/strict";
import test from "node:test";
import { setModelPickerBackground } from "./picker-background.mjs";

function windowWith(color) {
  return {
    color,
    isDestroyed: () => false,
    getBackgroundColor() { return this.color; },
    setBackgroundColor(value) { this.color = value; },
  };
}

test("matches the opaque dial and restores the active theme", () => {
  const win = windowWith("#121316");
  assert.equal(setModelPickerBackground(win, "dial"), true);
  assert.equal(win.color, "#050608");
  assert.equal(setModelPickerBackground(win, null), true);
  assert.equal(win.color, "#121316");
});

test("matches the list backdrop on dark and light themes", () => {
  for (const [theme, expected] of [["#121316", "#040508"], ["#ffffff", "#0d0e11"]]) {
    const win = windowWith(theme);
    setModelPickerBackground(win, "list");
    assert.equal(win.color, expected);
    setModelPickerBackground(win, null);
    assert.equal(win.color, theme);
  }
});

test("switches views without replacing the theme with the old picker color", () => {
  const win = windowWith("#ffffff");
  setModelPickerBackground(win, "dial");
  setModelPickerBackground(win, "list");
  assert.equal(win.color, "#0d0e11");
  setModelPickerBackground(win, null);
  setModelPickerBackground(win, null);
  assert.equal(win.color, "#ffffff");
});

test("keeps a newer theme applied while the picker was open", () => {
  const win = windowWith("#121316");
  setModelPickerBackground(win, "dial");
  win.color = "#ffffff";
  setModelPickerBackground(win, null);
  assert.equal(win.color, "#ffffff");
});

test("ignores invalid views and unavailable windows", () => {
  const win = windowWith("#ffffff");
  assert.equal(setModelPickerBackground(win, "unknown"), false);
  assert.equal(setModelPickerBackground(null, "dial"), false);
  assert.equal(setModelPickerBackground({ isDestroyed: () => true }, "dial"), false);
  assert.equal(win.color, "#ffffff");
});
