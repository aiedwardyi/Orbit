import { describe, expect, it } from "vitest";

import { createTerminalLineTracker } from "./terminal-input";

describe("typed terminal lines", () => {
  it("submits printable input only when Enter follows it", () => {
    const input = createTerminalLineTracker();
    expect(input("follow up")).toBe(false);
    expect(input("\r")).toBe(true);
    expect(input("\r\n")).toBe(false);
    expect(input("한글🙂\n")).toBe(true);
  });

  it.each([
    ["\r"], ["\n"], ["\t\r"], ["\x03\x15\r"], ["\x1b", "\r"],
    ["\x1b[A\x1b[B\r"], ["\x1b[99;5u\r"], ["\x1b[?1;2c\r"],
    ["\x1b[12;24R\r"], ["\x1b[<0;12;24M\r"], ["\x1b[M", " !!", "\r"],
    ["\x1b", "[", "A", "\r"], ["\x1bO1;2A\r"],
    ["\x1b]52;c;aGVsbG8=", "\x07", "\r"], ["\x1bPdevice reply\x1b", "\\", "\r"],
  ])("ignores keys and emulator replies %j", (...chunks) => {
    const input = createTerminalLineTracker();
    for (const chunk of chunks) expect(input(chunk)).toBe(false);
  });

  it("does not submit a line erased or cancelled before Enter", () => {
    const input = createTerminalLineTracker();
    expect(input("x\x7f\r")).toBe(false);
    expect(input("x\x08\r")).toBe(false);
    expect(input("follow up\x15\r")).toBe(false);
    expect(input("follow up\x03\r")).toBe(false);
  });

  it("waits for Enter after a multiline bracketed paste", () => {
    const input = createTerminalLineTracker();
    expect(input("\x1b[200~follow up\nthen test\x1b[201~")).toBe(false);
    expect(input("\r")).toBe(true);
    expect(input("\r")).toBe(false);
  });
});
