import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalScreen } from "./terminal-screen.mjs";

test("models cursor movement, erase, resize, and wrapped text", () => {
  const screen = createTerminalScreen({ cols: 5, rows: 3 });
  screen.consume("abc\x1b[2J\x1b[Hxy\x1b[2;2Hz\x1b[2K\x1b[2;2Hwide!");
  assert.equal(screen.snapshot().screenText, "xy\n wide\n!");
  assert.equal(screen.text(), "xy\n wide\n!");
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

test("consumes charset designations instead of printing their final byte", () => {
  const screen = createTerminalScreen({ cols: 10, rows: 1 });
  screen.consume("> \x1b(B\x0f\x1b)0\x1b(\x1b[31mx");
  assert.equal(screen.snapshot().screenText, "> x");
  assert.deepEqual(runs(screen), [{ t: "> " }, { t: "x", fg: 1 }]);
});

test("ignores kitty startup and exit queries during relative redraws", () => {
  const screen = createTerminalScreen({ cols: 20, rows: 6 });
  screen.consume("saved\x1b[s\x1b[3;2H\x1b[?u\x1b[1B\x1b[2Cstart\x1b[<u\x1b[1B\x1b[2Dend\x1b[u!");
  assert.equal(screen.snapshot().screenText.trimEnd(), "saved!\n\n\n   start\n      end");
});

for (const marker of ["?", ">", "!", "=", "<"]) {
  test(`ignores ${marker}s without overwriting the saved cursor`, () => {
    const screen = createTerminalScreen({ cols: 12, rows: 4 });
    screen.consume(`saved\x1b[s\x1b[3;2H\x1b[${marker}s\x1b[4;4H\x1b[u!`);
    assert.equal(screen.snapshot().screenText.trimEnd(), "saved!");
  });

  test(`ignores ${marker}u without restoring the cursor`, () => {
    const screen = createTerminalScreen({ cols: 12, rows: 4 });
    screen.consume(`saved\x1b[s\x1b[2;2H\x1b[${marker}u\x1b[1B\x1b[2Cdraw\x1b[u!`);
    assert.equal(screen.snapshot().screenText.trimEnd(), "saved!\n\n   draw");
  });
}

test("replays the captured Claude trust-menu selection redraw", () => {
  const screen = createTerminalScreen({ cols: 120, rows: 40 });
  // Startup and Down redraw from remote-term/proof/claude.raw.log.
  for (const chunk of [
    "\u001b[1t",
    "\u001b[c\u001b[?1004h\u001b[?9001h",
    "\u001b]0;claude\u001b\\",
    "\u001b7\u001b[r\u001b8\u001b[?25h",
    "\u001b[?25l",
    "\u001b[?2004h\u001b[?2031h\u001b[?1004h\u001b[?9001l\u001b[?9001h",
    "\r\n\u001b[93m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[39m\r\n\u001b[2G\u001b[93m\u001b[1mAccessing\u001b[12Gworkspace:\u001b[22m\u001b[39m\r\n\r\n\u001b[2G\u001b[1mC:\\Users\\mredw\\AppData\\Local\\Temp\\remote-term-claude-7UalE7\u001b[22m\r\n\r\n\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\u001b[52Gor\u001b[55Gone\u001b[59Gyou\u001b[63Gtrust?\u001b[70G(Like\u001b[76Gyour\u001b[81Gown\u001b[85Gcode,\u001b[91Ga\u001b[93Gwell-known\u001b[104Gopen\u001b[109Gsource\r\n\u001b[2Gproject,\u001b[11Gor\u001b[14Gwork\u001b[19Gfrom\u001b[24Gyour\u001b[29Gteam).\u001b[36GIf\u001b[39Gnot,\u001b[44Gtake\u001b[49Ga\u001b[51Gmoment\u001b[58Gto\u001b[61Greview\u001b[68Gwhat's\u001b[75Gin\u001b[78Gthis\u001b[83Gfolder\u001b[90Gfirst.\r\n\r\n\u001b[2GClaude\u001b[9GCode'll\u001b[17Gbe\u001b[20Gable\u001b[25Gto\u001b[28Gread,\u001b[34Gedit,\u001b[40Gand\u001b[44Gexecute\u001b[52Gfiles\u001b[58Ghere.\r\n\r\n\u001b[2G\u001b[37mSecurity\u001b[11Gguide\u001b[39m\r\n\r\n\u001b[2G\u001b[94m❯\u001b[4GNo,\u001b[8Gexit\u001b[39m\r\n\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\n\r\n\u001b[2G\u001b[37mEnter\u001b[8Gto\u001b[11Gconfirm\u001b[19G·\u001b[21GEsc\u001b[25Gto\u001b[28Gcancel\u001b[39m\r\n\u001b[1C\u001b[4A",
    "\u001b[>0q",
    "\u001b[?u\u001b[c",
  ]) screen.consume(chunk);
  screen.consume("\u001b[1D\u001b[4B\r\u001b[1C\u001b[4A \u001b[4GNo, exit\r\u001b[1C\u001b[1B\u001b[94m❯\u001b[4GYes, I trust this folder\u001b[39m\r\n\n\n\u001b[1C\u001b[3A");
  assert.equal(screen.snapshot().screenText.trimEnd(), "\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n Accessing workspace:\n\n C:\\Users\\mredw\\AppData\\Local\\Temp\\remote-term-claude-7UalE7\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\n project, or work from your team). If not, take a moment to review what's in this folder first.\n\n Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n   No, exit\n ❯ Yes, I trust this folder\n\n Enter to confirm · Esc to cancel");
});
