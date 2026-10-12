export function createTerminalLineTracker() {
  let printable = 0;
  let escape = "";
  let string = false;
  let stringEscape = false;
  let mouse = 0;
  let paste = false;
  return (data: string): boolean => {
    let submitted = false;
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
        escape += char;
        if (escape.length === 2) {
          if (char === "[" || char === "O") continue;
          string = "]PX^_".includes(char);
        } else {
          const code = char.charCodeAt(0);
          if (code < 0x40 || code > 0x7e) continue;
          if (escape === "\x1b[M") mouse = 3;
          if (escape === "\x1b[200~") paste = true;
          if (escape === "\x1b[201~") paste = false;
        }
        escape = "";
        continue;
      }
      if (char === "\x1b") escape = char;
      else if (char === "\r" || char === "\n") {
        // A newline inside bracketed paste does not submit the draft.
        if (!paste) {
          submitted ||= printable > 0;
          printable = 0;
        }
      } else if (char === "\x08" || char === "\x7f") printable = Math.max(0, printable - 1);
      else if (char === "\x03" || char === "\x15") printable = 0;
      else {
        const code = char.charCodeAt(0);
        if (code >= 0x20 && (code < 0x7f || code > 0x9f)) printable++;
      }
    }
    return submitted;
  };
}
