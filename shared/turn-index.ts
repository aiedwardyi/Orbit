// What the timeline rail counts as a turn, and the words its card shows for one.

/** What the user typed or another bot sent into the chat; replies, tool rows, notes and cards are not turns. */
export function isTurn(message: { role: string; kind: string }): boolean {
  return message.role === "user" && message.kind === "text";
}

// About one card row, counting wide (Hangul, CJK) characters twice.
const ROW_UNITS = 40;

const wide = (code: number) =>
  (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
  || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x1f300;

const ENTITY = new Map([["quot", "\""], ["lt", "<"], ["gt", ">"], ["amp", "&"]]);

/** One line of a turn, cut at a word with an ellipsis once it outgrows a card row. */
export function turnWords(text: string): string {
  const line = text
    .replace(/<\/?pasted-text[^>]*>/g, " ")
    .replace(/<attached-image\s[^>]*>/g, " ")
    .replace(/<attached-file\s+path="([^"]*)"[^>]*>/g, (tag, path: string) =>
      ` ${(/\sname="([^"]*)"/.exec(tag)?.[1] ?? path.split(/[\\/]/).pop() ?? "").replace(/&(quot|lt|gt|amp);/g, (_, name: string) => ENTITY.get(name)!)} `)
    .replace(/\s+/g, " ")
    .trim();
  let units = 0;
  let at = 0;
  for (const char of line) {
    units += wide(char.codePointAt(0)!) ? 2 : 1;
    if (units > ROW_UNITS) {
      const cut = line.lastIndexOf(" ", at);
      return `${(cut > 0 ? line.slice(0, cut) : line.slice(0, at)).replace(/[.,;:!?]+$/, "")}…`;
    }
    at += char.length;
  }
  return line;
}
