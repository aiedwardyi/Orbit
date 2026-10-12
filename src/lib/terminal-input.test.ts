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
    ["\r"], ["\n"], ["\x03\x15\r"],
  ])("ignores empty and cancelled lines %j", (...chunks) => {
    const input = createTerminalLineTracker();
    for (const chunk of chunks) expect(input(chunk)).toBe(false);
  });

  it.each([
    ["x\x1b[D\x7f\r", true],
    ["\x1b[A\r", true],
    ["\r", false],
    ["ab\x7f\x7f\r", false],
  ])("tracks edited input %j", (line, expected) => {
    expect(createTerminalLineTracker()(line)).toBe(expected);
  });

  it.each([
    ["\t\r"],
    ["\x1b[A\x1b[B\r"],
    ["\x1b", "[", "A", "\r"], ["\x1bO1;2A\r"],
  ])("submits unknown lines for edit keys %j", (...chunks) => {
    const input = createTerminalLineTracker();
    for (const chunk of chunks.slice(0, -1)) expect(input(chunk)).toBe(false);
    expect(input(chunks.at(-1)!)).toBe(true);
  });

  it.each([
    ["\x1b", "\r"],
    ["\x1b[99;5u\r"], ["\x1b[?1;2c\r"],
    ["\x1b[12;24R\r"], ["\x1b[<0;12;24M\r"], ["\x1b[M", " !!", "\r"],
    ["\x1b]52;c;aGVsbG8=", "\x07", "\r"], ["\x1bPdevice reply\x1b", "\\", "\r"],
  ])("ignores terminal replies and mouse reports %j", (...chunks) => {
    const input = createTerminalLineTracker();
    for (const chunk of chunks) expect(input(chunk)).toBe(false);
  });

  it("treats Alt+Enter as draft content, not a submit", () => {
    const input = createTerminalLineTracker();
    expect(input("\x1b\r")).toBe(false);
    expect(input("abc")).toBe(false);
    expect(input("\r")).toBe(true);
  });

  it("clears the draft on lone Esc", () => {
    const input = createTerminalLineTracker();
    expect(input("abc\x1b")).toBe(false);
    expect(input("\r")).toBe(false);
  });

  it("notifies Delete after an erased line", () => {
    const input = createTerminalLineTracker();
    expect(input("ab")).toBe(false);
    expect(input("\x7f\x7f")).toBe(false);
    expect(input("\x1b[3~\r")).toBe(true);
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
