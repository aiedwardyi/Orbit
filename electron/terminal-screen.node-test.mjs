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

test("keeps alternate-screen cursor restoration separate from DECSC", () => {
  const screen = createTerminalScreen({ cols: 8, rows: 2 });
  screen.consume("abc\x1b[?1049h\x1b7\x1b[?1049lZ");
  assert.equal(screen.snapshot().screenText.split("\n")[0], "abcZ");
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

const runs = (screen, row = 0) => screen.snapshot().screenRuns[row];

test("styles runs with fg, bg, bold, 256 and truecolor", () => {
  const screen = createTerminalScreen({ cols: 20, rows: 2 });
  screen.consume("\x1b[1;32mok\x1b[0m \x1b[44mbg\x1b[38;5;208mX\x1b[m\x1b[38;2;255;0;16mT\x1b[48:2:1:2:3mC");
  assert.deepEqual(runs(screen), [
    { t: "ok", fg: 2, b: 1 },
    { t: " " },
    { t: "bg", bg: 4 },
    { t: "X", fg: 208, bg: 4 },
    { t: "T", fg: "#ff0010" },
    { t: "C", fg: "#ff0010", bg: "#010203" },
  ]);
  assert.equal(screen.snapshot().screenText.split("\n")[0], "ok bgXTC");
});

test("reset and attribute-off codes clear style", () => {
  const screen = createTerminalScreen({ cols: 20, rows: 2 });
  screen.consume("\x1b[1;2;3;4;9;91;101ma\x1b[22;23;24;29;39;49mb\x1b[31mc\x1b[0md");
  assert.deepEqual(runs(screen), [{ t: "a", fg: 9, bg: 9, b: 1, d: 1, i: 1, u: 1, s: 1 }, { t: "b" }, { t: "c", fg: 1 }, { t: "d" }]);
});

test("erases leave unstyled cells and trailing blanks are trimmed", () => {
  const screen = createTerminalScreen({ cols: 10, rows: 2 });
  screen.consume("\x1b[41mabcdef\x1b[3D\x1b[K\x1b[1G\x1b[2X");
  assert.deepEqual(runs(screen), [{ t: "  " }, { t: "c", bg: 1 }]);
  screen.consume("\r\n\x1b[42m   ");
  assert.deepEqual(runs(screen, 1), [{ t: "   ", bg: 2 }]);
  assert.equal(screen.snapshot().screenText.split("\n")[1], "");
});

test("resolves inverse by swapping fg and bg", () => {
  const screen = createTerminalScreen({ cols: 10, rows: 1 });
  screen.consume("\x1b[7ma\x1b[31mb\x1b[27mc");
  assert.deepEqual(runs(screen), [{ t: "a", fg: 0, bg: 7 }, { t: "b", fg: 0, bg: 1 }, { t: "c", fg: 1 }]);
});

test("ignores private-marker m sequences", () => {
  const screen = createTerminalScreen({ cols: 10, rows: 1 });
  screen.consume("\x1b[31m\x1b[>4;2ma");
  assert.deepEqual(runs(screen), [{ t: "a", fg: 1 }]);
});

test("truncation keeps screenRuns aligned with screenText", () => {
  const screen = createTerminalScreen({ cols: 8, rows: 4 });
  screen.consume("\x1b[31mone\r\n\x1b[32mtwo22\r\n\x1b[33mthree\r\nfour");
  const snapshot = screen.snapshot({ maxScreenChars: 14 });
  const lines = snapshot.screenText.split("\n");
  assert.equal(snapshot.screenText, "o22\nthree\nfour");
  assert.equal(snapshot.screenRuns.length, lines.length);
  assert.deepEqual(snapshot.screenRuns.map((row) => row.map((run) => run.t).join("")), lines);
  assert.deepEqual(snapshot.screenRuns[0], [{ t: "o22", fg: 2 }]);
});

test("consumes SGR 58 underline color and ignores 59", () => {
  const screen = createTerminalScreen({ cols: 10, rows: 1 });
  screen.consume("\x1b[58;5;31ma\x1b[58;2;41;42;43;4mb\x1b[59;32mc\x1b[58:2::1:2:3md");
  assert.deepEqual(runs(screen), [{ t: "a" }, { t: "b", u: 1 }, { t: "cd", fg: 2, u: 1 }]);
});

test("reads colon sub-params as one group", () => {
  const screen = createTerminalScreen({ cols: 10, rows: 1 });
  screen.consume("\x1b[38:2::255:0:16ma\x1b[4:3mb\x1b[4:0;48:5:9mc");
  assert.deepEqual(runs(screen), [{ t: "a", fg: "#ff0010" }, { t: "b", fg: "#ff0010", u: 1 }, { t: "c", fg: "#ff0010", bg: 9 }]);
});

test("omits screenRuns past the run cap but keeps screenText", () => {
  const screen = createTerminalScreen({ cols: 10, rows: 2 });
  screen.consume("\x1b[31ma\x1b[32mb\x1b[33mc\r\n\x1b[34md");
  assert.equal(screen.snapshot({ maxScreenRuns: 4 }).screenRuns.length, 2);
  const capped = screen.snapshot({ maxScreenRuns: 3 });
  assert.equal(capped.screenRuns, undefined);
  assert.equal(capped.screenText, "abc\nd");
});
