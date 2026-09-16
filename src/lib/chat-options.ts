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

const OPEN_TO_CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE_TO_OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Index of the last top-level `\s+or\s+` word, or -1 if none (e.g. or only inside groups). */
function lastTopLevelOrIndex(text: string): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (OPEN_TO_CLOSE[ch]) {
      depth += 1;
      continue;
    }
    if (CLOSE_TO_OPEN[ch]) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    // Early-exit unless this char could start "or" — avoid slice+regex on every index
    if (ch !== "o" && ch !== "O") continue;
    if (i > 0 && /\s/.test(text[i - 1]!) && /^or\b/i.test(text.slice(i))) {
      const after = i + 2;
      if (after < text.length && /\s/.test(text[after]!)) last = i;
    }
  }
  return last;
}

/**
 * Last choice label from the left phrase: final word, or `word (…)` / `word […]`
 * when the phrase ends in a balanced group (incidental version tags stay attached).
 */
function lastChoiceLabel(phrase: string): string {
  const trimmed = phrase.trim();
  if (!trimmed) return trimmed;
  const endCh = trimmed[trimmed.length - 1]!;
  const openCh = CLOSE_TO_OPEN[endCh];
  if (openCh) {
    let depth = 0;
    let openAt = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const ch = trimmed[i]!;
      if (ch === endCh) depth += 1;
      else if (ch === openCh) {
        depth -= 1;
        if (depth === 0) {
          openAt = i;
          break;
        }
      }
    }
    if (openAt >= 0) {
      let start = openAt;
      while (start > 0 && /\s/.test(trimmed[start - 1]!)) start -= 1;
      while (start > 0 && !/\s/.test(trimmed[start - 1]!)) start -= 1;
      return trimmed.slice(start).trim();
    }
  }
  const words = trimmed.split(/\s+/);
  return words[words.length - 1]!;
}

/**
 * Split a trailing A-or-B question into two choices.
 * Incidental parens/brackets on a label are OK; reject when the splitting
 * `or` itself sits inside a balanced group (policy lists, embedded alternatives).
 * Soft >20 word cutoff still drops huge bracket-free prose.
 */
function orChoices(text: string): string[] | null {
  const candidate = text.trim();
  const lineMatch = candidate.match(/^(?:[\s\S]*\n)?(.+)\?\s*$/);
  if (!lineMatch) return null;
  const line = lineMatch[1]!.trim();
  if (line.split(/\s+/).length > 20) return null;
  const orIdx = lastTopLevelOrIndex(line);
  if (orIdx < 0) return null;
  let left = line.slice(0, orIdx).trim();
  const right = line
    .slice(orIdx + 2)
    .trim()
    .replace(/[?.!]+$/, "")
    .trim();
  if (!left || !right) return null;
  // Conservative: reject if left or right contains a nested "or" (e.g. parenthetical options).
  if (/\bor\b/i.test(left) || /\bor\b/i.test(right)) return null;
  if (left.split(/\s+/).length >= 2) left = lastChoiceLabel(left);
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
