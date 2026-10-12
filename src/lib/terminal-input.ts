export function createTerminalLineTracker() {
  let printable = 0;
  let unknown = false;
  let escape = "";
  let string = false;
  let stringEscape = false;
  let mouse = 0;
  let paste = false;
  return (data: string): boolean => {
    let submitted = false;
    // A pending ESC from the prior chunk was lone unless this one continues it.
    if (escape === "\x1b" && data.length > 0) {
      const first = data[0]!;
      if (first !== "[" && first !== "O" && !"]PX^_".includes(first)) {
        printable = 0;
        unknown = false;
        escape = "";
      }
    }
    for (const char of data) {
      if (mouse) {
        mouse--;
        continue;
      }
      if (string) {
        if (char === "\x07" || (stringEscape && char === "\\")) string = false;
        stringEscape = char === "\x1b";
        continue;
      }
      if (escape) {
        // Alt+Enter in one chunk adds a draft newline, never submits.
        if (escape === "\x1b" && (char === "\r" || char === "\n")) {
          printable++;
          escape = "";
          continue;
        }
        escape += char;
        if (escape.length === 2) {
          if (char === "[" || char === "O") continue;
          string = "]PX^_".includes(char);
          escape = "";
          continue;
        }
        const code = char.charCodeAt(0);
        if (code < 0x40 || code > 0x7e) continue;
        if (escape === "\x1b[M") mouse = 3;
        else if (escape === "\x1b[200~") paste = true;
        else if (escape === "\x1b[201~") paste = false;
        else if (escape.startsWith("\x1b[") || escape.startsWith("\x1bO")) {
          if (char === "A" || char === "B" || char === "C" || char === "D" || char === "H" || char === "F") unknown = true;
          else if (char === "~") unknown = true;
        }
        escape = "";
        continue;
      }
      if (char === "\x1b") escape = char;
      else if (char === "\r" || char === "\n") {
        // A newline inside bracketed paste does not submit the draft.
        if (!paste) {
          submitted ||= printable > 0 || unknown;
          printable = 0;
          unknown = false;
        }
      } else if (char === "\x08" || char === "\x7f") printable = Math.max(0, printable - 1);
      else if (char === "\x03" || char === "\x15") {
        printable = 0;
        unknown = false;
      } else {
        const code = char.charCodeAt(0);
        if (code >= 0x20 && (code < 0x7f || code > 0x9f)) printable++;
        else if (code === 0x09 || (code < 0x20 && code !== 0x0d && code !== 0x0a && code !== 0x08 && code !== 0x03 && code !== 0x15)) unknown = true;
      }
    }
    // Lone Esc clears the draft like Ctrl+U but stays pending for a split sequence.
    if (escape === "\x1b") {
      printable = 0;
      unknown = false;
    }
    return submitted;
  };
}
