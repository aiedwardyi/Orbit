import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { MEMORY_SAVE_TOOL } from "./memory-save.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message, Store, StoreChange } from "./store.ts";
import { MEMORY_MAX_BYTES, MEMORY_MAX_LINES, MEMORY_SEED, memoryFileRaw, readMemoryFile, saveMemoryFile } from "./workspace.ts";

const IDLE_MS = 3 * 60_000;
const BATCH_MESSAGES = 8;
const MAX_PASSES = 2;
const PASS_TIMEOUT_MS = 120_000;
const SAVE_DELAY_MS = 1_000;
const MAX_PENDING = 200;
const QUOTE_MAX = 120;
const FACT_MAX = 200;
const SUMMARY_MAX = 120;
const STATE_FILE = "memory-pass.json";

const factsSchema = z.array(z.object({ fact: z.string(), quote: z.string() })).max(20);
const stateSchema = z.object({ threads: z.record(z.string(), z.array(z.string())) });

export type NoteGenerator = (prompt: string, signal: AbortSignal) => Promise<string>;

export interface MemoryPassDeps {
  store: Pick<Store, "onChange" | "messagesFor" | "groupByThread" | "botByThread" | "appendMessage">;
  /** The Claude one-shot call, whatever engine the bot runs; null when no Claude CLI is set up. */
  generate(): NoteGenerator | null;
  busy(botId: string, threadId: string): boolean;
  dataDir: string;
  now?(): number;
}

export interface MemoryPass {
  /** Call when a 1:1 turn settles. */
  onSettled(botId: string, threadId: string): void;
  /** Resolves once no pass is running. */
  idle(): Promise<void>;
  dispose(): void;
}

/** A user row typed on this PC into the chat, not a bot, routine, peer, draft or attachment. */
export function eligibleRow(message: Message | undefined): message is Message & { text: string } {
  return Boolean(
    message && message.role === "user" && message.kind === "text" && message.text !== undefined &&
      !message.from && !message.origin && !message.comm && !message.queued && !message.image && !message.hasImage,
  );
}

/** The user's own typing: pastes, attachments, code, quotes and long blocks cut, secrets masked. */
export function userTyping(text: string): string {
  const unwrapped = text
    .replace(/<pasted-text\b[^>]*>[\s\S]*?<\/pasted-text>/gi, "")
    .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/gi, "")
    .replace(/<attached-(?:image|file)\b[^>]*\/>/gi, "")
    .replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)/g, "$1")
    .replace(/"[^"\n]{81,}"|“[^”\n]{81,}”|'[^'\n]{81,}'/g, "");
  const kept = unwrapped
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.length <= 400 && paragraph.split("\n").length <= 6)
    .map((paragraph) => paragraph.split("\n").filter((line) => !line.trimStart().startsWith(">")).join("\n").trim())
    .filter(Boolean);
  return redactSecretsInText(kept.join("\n\n"));
}

export function notePrompt(notes: string, lines: string[]): string {
  return [
    "You pick durable facts about the user out of their own chat messages, for their notes file.",
    "",
    "Rules:",
    "- Use only USER LINES. Never guess, infer or add anything they did not say.",
    "- Keep facts that stay true: who they are, their age, languages, tools they use, likes and dislikes, how they want things done.",
    "- Skip one-off requests, questions, task details, and anything CURRENT NOTES already says.",
    "- Never record passwords, PINs, codes, keys, tokens, account numbers or one-time codes.",
    "- fact: one short plain line about the user, for example \"38 years old\" or \"Can't read Korean\".",
    `- quote: the user's exact words that state the fact, copied verbatim, ${QUOTE_MAX} characters max.`,
    "",
    "Reply with JSON only: [{\"fact\": \"...\", \"quote\": \"...\"}], or [] when nothing qualifies.",
    "",
    "CURRENT NOTES:",
    "<notes>",
    notes.trim() || "(empty)",
    "</notes>",
    "",
    "USER LINES:",
    "<user_lines>",
    lines.join("\n\n"),
    "</user_lines>",
  ].join("\n");
}

export function parseFacts(output: string): Array<{ fact: string; quote: string }> {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const parsed = factsSchema.safeParse(JSON.parse(output.slice(start, end + 1)));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const SECRET_WORDS =
  /\b(?:passwords?|passcodes?|passwd|pins?|otp|2fa|mfa|one[- ]time|verification codes?|security codes?|api[ _-]?keys?|secret|tokens?|private keys?|credentials?|account numbers?|card numbers?|routing numbers?|cvv|ssn|social security)\b/i;
const TOKEN_PATTERNS = [
  /«redacted/i,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|xox[abposr])[_-][A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/,
  /\b(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{24,}/,
];

export function secretLike(text: string): boolean {
  return redactSecretsInText(text) !== text || SECRET_WORDS.test(text) || TOKEN_PATTERNS.some((pattern) => pattern.test(text));
}

const STOP_WORDS = new Set(["the", "and", "but", "for", "with", "are", "was", "that", "this", "you", "your", "can", "can't", "cant", "don't", "dont", "just", "have", "has", "not", "i'm", "it's", "its", "really"]);

function quoteWords(quote: string): string[] {
  return (quote.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(
    (word) => (word.length >= 3 || /\d/.test(word)) && !STOP_WORDS.has(word),
  );
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Facts that quote the user verbatim, carry no secret, and are not already noted. */
export function acceptFacts(facts: Array<{ fact: string; quote: string }>, userText: string, notes: string) {
  const source = squash(userText);
  const noted = notes.split("\n").map((line) => line.toLowerCase());
  const seen = new Set<string>();
  return facts.flatMap(({ fact, quote }) => {
    const line = fact.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim();
    const said = quote.trim();
    if (!line || line.length > FACT_MAX || !said || said.length > QUOTE_MAX) return [];
    if (!source.includes(squash(said))) return [];
    if (secretLike(line) || secretLike(said)) return [];
    const words = quoteWords(said);
    if (words.length && noted.some((note) => words.every((word) => note.includes(word)))) return [];
    const key = squash(line);
    if (seen.has(key) || noted.some((note) => note.includes(key))) return [];
    seen.add(key);
    return [line];
  });
}

function day(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** MEMORY.md with the facts appended, or null when it would pass the load budget. */
export function appendNotes(raw: string, facts: string[], now: number): string | null {
  const base = raw.trim() ? raw : MEMORY_SEED;
  const stamp = day(now);
  const text = `${base.endsWith("\n") ? base : `${base}\n`}${facts.map((fact) => `- ${fact} (noted ${stamp})\n`).join("")}`;
  if (text.split("\n").length > MEMORY_MAX_LINES || Buffer.byteLength(text, "utf8") > MEMORY_MAX_BYTES) return null;
  return text;
}

export function noteSummary(facts: string[]): string {
  const joined = facts.join(", ");
  return joined.length > SUMMARY_MAX ? `${joined.slice(0, SUMMARY_MAX - 3).trimEnd()}...` : joined;
}

const UNAVAILABLE = /ENOENT|not logged in|log ?in|login|sign ?in|authenticat|api key/i;

interface PassLog {
  botId: string;
  threadId: string;
  lines?: number;
  facts?: number;
  ms: number;
  result: "saved" | "none" | "busy" | "too-large" | "conflict" | "error";
}

/** Notes passing facts from new user lines into MEMORY.md once a 1:1 chat goes quiet. Never on the reply path. */
export function createMemoryPass(deps: MemoryPassDeps): MemoryPass {
  const now = deps.now ?? Date.now;
  const statePath = join(deps.dataDir, STATE_FILE);
  const pending = new Map<string, string[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queue: Array<{ botId: string; threadId: string }> = [];
  const running = new Map<string, { botId: string; done: Promise<void>; controller: AbortController }>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let warned = false;
  let disposed = false;

  try {
    for (const [threadId, ids] of Object.entries(stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8"))).threads)) {
      if (ids.length) pending.set(threadId, ids);
    }
  } catch {
    // first run or unreadable: start empty
  }

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    try {
      writeFileAtomic(statePath, `${JSON.stringify({ threads: Object.fromEntries(pending) })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`[memory-pass] state save failed (${error instanceof Error ? error.name : "error"})`);
    }
  };
  const saveSoon = () => {
    if (saveTimer || disposed) return;
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
    saveTimer.unref?.();
  };

  const arm = (botId: string, threadId: string) => {
    clearTimeout(timers.get(threadId));
    const timer = setTimeout(() => {
      timers.delete(threadId);
      enqueue(botId, threadId);
    }, IDLE_MS);
    timer.unref?.();
    timers.set(threadId, timer);
  };

  const enqueue = (botId: string, threadId: string) => {
    if (disposed || running.has(threadId) || queue.some((item) => item.threadId === threadId)) return;
    clearTimeout(timers.get(threadId));
    timers.delete(threadId);
    queue.push({ botId, threadId });
    pump();
  };

  const warnOnce = (reason: string) => {
    if (warned) return;
    warned = true;
    console.warn(`[memory-pass] skipping note passes: ${reason}`);
  };

  const log = (fields: PassLog) => console.info(`[memory-pass] ${JSON.stringify(fields)}`);

  const done = (threadId: string, ids: string[]) => {
    const taken = new Set(ids);
    const rest = (pending.get(threadId) ?? []).filter((id) => !taken.has(id));
    if (rest.length) pending.set(threadId, rest);
    else pending.delete(threadId);
    save();
  };

  const run = async (botId: string, threadId: string, signal: AbortSignal) => {
    const ids = [...(pending.get(threadId) ?? [])];
    if (!ids.length) return;
    const byId = new Map(deps.store.messagesFor(threadId).map((message) => [message.id, message]));
    const lines = ids.flatMap((id) => {
      const row = byId.get(id);
      const text = eligibleRow(row) ? userTyping(row.text) : "";
      return text ? [text] : [];
    });
    if (!lines.length) return done(threadId, ids);
    const generate = deps.generate();
    if (!generate) return warnOnce("no Claude CLI instance");
    const memory = readMemoryFile(botId);
    const raw = memoryFileRaw(botId);
    const started = now();
    let output: string;
    try {
      output = await generate(notePrompt(memory.text, lines), signal);
    } catch (error) {
      if (UNAVAILABLE.test(error instanceof Error ? error.message : String(error))) {
        return warnOnce("Claude CLI missing or signed out");
      }
      log({ botId, threadId, lines: lines.length, ms: now() - started, result: "error" });
      return;
    }
    if (disposed) return;
    const ms = now() - started;
    const facts = acceptFacts(parseFacts(output), lines.join("\n\n"), memory.text);
    if (!facts.length) {
      log({ botId, threadId, lines: lines.length, facts: 0, ms, result: "none" });
      return done(threadId, ids);
    }
    // a turn may be writing MEMORY.md and its own save chip; retry after it
    if (deps.busy(botId, threadId)) {
      log({ botId, threadId, facts: facts.length, ms, result: "busy" });
      return arm(botId, threadId);
    }
    const text = appendNotes(raw, facts, now());
    if (!text) {
      log({ botId, threadId, facts: facts.length, ms, result: "too-large" });
      return done(threadId, ids);
    }
    if (saveMemoryFile(botId, text, memory.revision).conflict) {
      log({ botId, threadId, facts: facts.length, ms, result: "conflict" });
      return arm(botId, threadId);
    }
    deps.store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: MEMORY_SAVE_TOOL, ok: true, spoken: noteSummary(facts) },
    });
    log({ botId, threadId, lines: lines.length, facts: facts.length, ms, result: "saved" });
    done(threadId, ids);
  };

  const pump = () => {
    for (let i = 0; i < queue.length && running.size < MAX_PASSES; ) {
      const { botId, threadId } = queue[i]!;
      if ([...running.values()].some((pass) => pass.botId === botId)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      if (deps.busy(botId, threadId)) {
        arm(botId, threadId);
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PASS_TIMEOUT_MS);
      timer.unref?.();
      const pass = { botId, controller, done: Promise.resolve() };
      running.set(threadId, pass);
      pass.done = run(botId, threadId, controller.signal)
        .catch((error) => console.warn(`[memory-pass] pass failed (${error instanceof Error ? error.name : "error"})`))
        .finally(() => {
          clearTimeout(timer);
          running.delete(threadId);
          pump();
        });
    }
  };

  const unsubscribe = deps.store.onChange((change: StoreChange) => {
    if (change.type !== "message" || change.imported || disposed) return;
    const { message, threadId } = change;
    if (message.role !== "user" || message.kind !== "text" || deps.store.groupByThread(threadId)) return;
    const ids = pending.get(threadId) ?? [];
    if (!ids.includes(message.id)) ids.push(message.id);
    pending.set(threadId, ids.slice(-MAX_PENDING));
    clearTimeout(timers.get(threadId));
    timers.delete(threadId);
    saveSoon();
  });

  for (const threadId of pending.keys()) {
    const bot = deps.store.botByThread(threadId);
    if (bot) arm(bot.id, threadId);
  }

  return {
    onSettled(botId, threadId) {
      const count = pending.get(threadId)?.length ?? 0;
      if (disposed || !count) return;
      if (count >= BATCH_MESSAGES) enqueue(botId, threadId);
      else arm(botId, threadId);
    },
    async idle() {
      while (running.size) await Promise.all([...running.values()].map((pass) => pass.done));
    },
    dispose() {
      disposed = true;
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      queue.length = 0;
      for (const pass of running.values()) pass.controller.abort();
      if (saveTimer) save();
    },
  };
}
