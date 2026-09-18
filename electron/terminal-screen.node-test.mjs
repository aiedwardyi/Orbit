import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalScreen } from "./terminal-screen.mjs";

test("models cursor movement, erase, resize, and wrapped text", () => {
  const screen = createTerminalScreen({ cols: 5, rows: 3 });
  screen.consume("abc\x1b[2J\x1b[Hxy\x1b[2;2Hz\x1b[2K\x1b[2;2Hwide!");
  assert.equal(screen.snapshot().screenText, "xy\n wide\n!");
  screen.resize(7, 4);
  assert.equal(screen.snapshot().cols, 7);
  assert.equal(screen.snapshot().rows, 4);
});

test("keeps the main screen while a TUI uses the alternate buffer", () => {
  const screen = createTerminalScreen({ cols: 12, rows: 3 });
  screen.consume("shell prompt\r\nready");
  screen.consume("\x1b[?1049h\x1b[Hmenu\x1b[?1049l");
  assert.match(screen.snapshot().screenText, /^shell prompt\nready/u);
  screen.consume("\x1b[?1049h\x1b[Hmenu");
  assert.equal(screen.snapshot().alternate, true);
  assert.match(screen.snapshot().screenText, /^menu/u);
});

test("bounds scrollback and reports truncation", () => {
  const screen = createTerminalScreen({ cols: 8, rows: 2, scrollback: 2 });
  screen.consume("one\r\ntwo\r\nthree\r\nfour");
  const snapshot = screen.snapshot({ maxScrollbackChars: 5 });
  assert.equal(snapshot.recentText.length <= 5, true);
  assert.equal(snapshot.truncated, true);
});

test("erases the full line for CSI 2K and shifts cells left for CSI P", () => {
  const screen = createTerminalScreen({ cols: 12, rows: 2 });
  screen.consume("SECRET\x1b[2KOK");
  assert.equal(screen.snapshot().screenText.split("\n")[0], "      OK");

  screen.consume("\x1b[2J\x1b[Habcdefghi\x1b[3D\x1b[2P");
  assert.equal(screen.snapshot().screenText.split("\n")[0], "abcdefi");
});

test("bounds CSI counts and combining text", () => {
  const screen = createTerminalScreen({ cols: 8, rows: 2 });
  assert.doesNotThrow(() => screen.consume("\x1b[200000L\x1b[200000M\x1b[200000P"));
  assert.doesNotThrow(() => screen.consume("a" + "\u0301".repeat(10_000)));
  assert.ok(screen.snapshot().screenText.length < 300);
});
