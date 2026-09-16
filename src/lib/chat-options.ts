const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MAX_OPTION_LEN = 80;
const LIST_ITEM = /^(?:[-*+]|\d+[.)]|[A-Ea-e][.)])\s+(\S.*)$/;

export type ChatOptionsDetection = {
  options: string[];
  /**
   * Exact question for the card header. Null when the heuristic cannot supply
   * a trustworthy heading (short A-or-B) — keep message prose intact.
   */
  question: string | null;
  /**
   * Preceding prose to keep in the transcript bubble when the trailing
   * question+list is rendered only in the card. Null means do not strip.
   */
  messagePrefix: string | null;
};

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
  return {
    prompt: lines.slice(0, index + 1).join("\n").trim(),
    items,
  };
}

function questionFromPrompt(prompt: string): string {
  const blocks = prompt.split(/\n{2,}/);
  const last = (blocks[blocks.length - 1] ?? prompt).trim();
  return last || prompt.trim();
}

function proseBeforeQuestion(prompt: string, question: string): string {
  const idx = prompt.lastIndexOf(question);
  if (idx <= 0) return "";
  return prompt.slice(0, idx).replace(/\s+$/, "");
}

/**
 * Strip the trailing question+list from the bubble only when the same list is
 * present at the end of the original message (offsets match the source).
 */
function prefixBeforeTrailingList(
  original: string,
  listed: { prompt: string; items: string[] },
  question: string,
): string | null {
  const fromOriginal = trailingList(original);
  if (!fromOriginal || fromOriginal.items.join("\0") !== listed.items.join("\0")) return null;
  if (!/\?\s*$/.test(fromOriginal.prompt)) return null;
  return proseBeforeQuestion(fromOriginal.prompt, questionFromPrompt(fromOriginal.prompt) || question);
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

/** Full detection for the choice card (options + optional question / prefix). */
export function detectChatOptions(text: string): ChatOptionsDetection | null {
  const body = stripFences(text).replace(/\s+$/, "");
  if (!body) return null;
  const listed = trailingList(body);
  if (listed) {
    if (!/\?\s*$/.test(listed.prompt)) return null;
    const question = questionFromPrompt(listed.prompt);
    if (!question) return null;
    const messagePrefix = prefixBeforeTrailingList(text, listed, question);
    return {
      options: listed.items,
      question,
      messagePrefix,
    };
  }
  const orItems = orChoices(body);
  if (!orItems) return null;
  // A-or-B wording is abbreviated — do not invent a card heading or strip prose.
  return { options: orItems, question: null, messagePrefix: null };
}

/** Trailing 2-5 choices only when the prompt is a question. Never a random list. */
export function chatOptionChoices(text: string): string[] | null {
  return detectChatOptions(text)?.options ?? null;
}

/** First later user text after `messageId` on the active transcript path. */
export function laterUserAnswer(
  messages: ReadonlyArray<{ id: string; role: string; kind?: string; text?: string | null }>,
  messageId: string,
): string | null {
  const index = messages.findIndex((entry) => entry.id === messageId);
  if (index < 0) return null;
  for (let i = index + 1; i < messages.length; i += 1) {
    const entry = messages[i]!;
    if (entry.role === "user" && (entry.kind === undefined || entry.kind === "text")) {
      const text = entry.text?.trim() ?? "";
      if (text) return text;
    }
  }
  return null;
}
