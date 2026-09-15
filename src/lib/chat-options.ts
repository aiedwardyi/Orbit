const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MAX_OPTION_LEN = 80;
const LIST_ITEM = /^(?:[-*+]|\d+[.)]|[A-Ea-e][.)])\s+(\S.*)$/;

function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
}

function optionLabel(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > MAX_OPTION_LEN) return null;
  return text;
}

function trailingList(text: string): { prompt: string; items: string[] } | null {
  const lines = text.replace(/\s+$/, "").split("\n");
  const items: string[] = [];
  let index = lines.length - 1;
  while (index >= 0) {
    const line = lines[index]!.trim();
    if (!line) {
      if (items.length) {
        index -= 1;
        continue;
      }
      break;
    }
    const match = line.match(LIST_ITEM);
    if (!match) break;
    const item = optionLabel(match[1] ?? "");
    if (!item) return null;
    items.unshift(item);
    index -= 1;
  }
  if (items.length < MIN_OPTIONS || items.length > MAX_OPTIONS) return null;
  return { prompt: lines.slice(0, index + 1).join("\n").trim(), items };
}

function orChoices(text: string): string[] | null {
  const match = text.trim().match(/^(?:[\s\S]*\n)?(.+?)\s+or\s+(.+?)\?\s*$/i);
  if (!match) return null;
  let left = match[1]!.trim();
  const right = match[2]!.trim().replace(/[?.!]+$/, "").trim();
  if (!left || !right || left.includes("\n") || right.includes("\n")) return null;
  if (/\bor\b/i.test(left) || /\bor\b/i.test(right)) return null;
  const words = left.split(/\s+/);
  if (words.length >= 2) left = words[words.length - 1]!;
  if (left.length > MAX_OPTION_LEN || right.length > MAX_OPTION_LEN) return null;
  if (left.toLowerCase() === right.toLowerCase()) return null;
  return [left, right];
}

/** Trailing 2-5 choices only when the prompt is a question. Never a random list. */
export function chatOptionChoices(text: string): string[] | null {
  const body = stripFences(text).replace(/\s+$/, "");
  if (!body) return null;
  const listed = trailingList(body);
  if (listed) return /\?\s*$/.test(listed.prompt) ? listed.items : null;
  return orChoices(body);
}
