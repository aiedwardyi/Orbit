import { attachedFilePreview } from "@/lib/composer-attachments";
import { summarize } from "../../shared/summarize";

const OPEN = /^[ \t]*(`{3,}(?=[^`]*$)|~{3,})/;

// Prose gets markdown cleanup, each fence body stays literal, all in order.
// The whole opening fence line is skipped, so ```c++ leaves no "++".
function botPinPreview(text: string): string {
  const parts: string[] = [];
  let prose: string[] = [];
  let body: string[] | null = null;
  let mark = "";
  const flushProse = () => {
    const clean = summarize(prose.join("\n"), Infinity);
    if (clean) parts.push(clean);
    prose = [];
  };
  const flushBody = () => {
    const code = body!.join("\n").replace(/\s+/g, " ").trim();
    if (code) parts.push(code);
    body = null;
  };
  for (const line of text.split("\n")) {
    if (body === null) {
      const open = OPEN.exec(line);
      if (open) { flushProse(); body = []; mark = open[1]; continue; }
    } else {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
      if (close && close[1][0] === mark[0] && close[1].length >= mark.length) { flushBody(); continue; }
    }
    (body ?? prose).push(line);
  }
  if (body !== null) flushBody(); else flushProse();
  return parts.join(" ");
}

/** One-line pin banner text. User text stays literal, bot text is cleaned. */
export function pinPreview(role: "user" | "bot", text: string): string {
  const display = attachedFilePreview(text);
  return role === "user" ? display.replace(/\s+/g, " ").trim() : botPinPreview(display);
}
