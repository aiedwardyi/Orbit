// The agents proxy's ask_user: a question pinned for the user that never
// pauses the bot. It lands as a bot options card marked `askUser` (so the
// client can tell it from the first-run quiz, which has no requestId either)
// and buzzes the same "has a question" alert as a provider's own ask. The
// answer is simply the user's next message, so nothing here waits and the
// bot's activity is never set to waiting-on-you.
import { z } from "zod";

import type { BotRecord, Message } from "./store.ts";

export const ASK_USER_TITLE = "Your bot has a question";
export const ASK_USER_QUESTION_MAX = 2_000;
export const ASK_USER_MAX_CHOICES = 5;
const CHOICE_MAX = 200;

/** Anything malformed reads as empty, so the handler answers with a 4xx. */
export const askUserRequestSchema = z
  .object({
    fromBotId: z.string().catch(""),
    fromThreadId: z.string().catch(""),
    question: z.string().catch(""),
    choices: z.array(z.string().catch("")).catch([]),
  })
  .catch({ fromBotId: "", fromThreadId: "", question: "", choices: [] });
export type AskUserRequest = z.infer<typeof askUserRequestSchema>;

/** What a room may persist on a member's ask_user card. */
export const askUserCardPatchSchema = z
  .object({
    answered: z.string().optional().catch(undefined),
    dismissed: z.literal(true).optional().catch(undefined),
  })
  .catch({});

/** Trimmed, deduped, non-empty choices, at most five. */
export function askUserChoices(raw: readonly string[]): string[] {
  const choices: string[] = [];
  for (const value of raw) {
    const choice = value.trim().slice(0, CHOICE_MAX);
    if (!choice || choices.includes(choice)) continue;
    choices.push(choice);
    if (choices.length === ASK_USER_MAX_CHOICES) break;
  }
  return choices;
}

type Sender = Pick<BotRecord, "id" | "name" | "color">;

export interface AskUserDeps<B extends Sender> {
  bot(id: string): B | null | undefined;
  /** The sender's own 1:1 task or a room it belongs to; null otherwise. */
  conversation(botId: string, threadId: string): { group?: object } | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  /** Sends the desktop alert; the caller picks the thread it opens. */
  notifyQuestion(bot: B, threadId: string, question: string): void;
}

export interface AskUserResult {
  status: number;
  body: { error: string } | { messageId: string };
}

export function postAskUser<B extends Sender>(deps: AskUserDeps<B>, request: AskUserRequest): AskUserResult {
  const from = deps.bot(request.fromBotId);
  if (!from) return { status: 403, body: { error: "unknown sender" } };
  if (!request.fromThreadId) return { status: 400, body: { error: "no active thread" } };
  const owner = deps.conversation(from.id, request.fromThreadId);
  if (!owner) return { status: 403, body: { error: "source thread does not belong to sender" } };
  const question = request.question.trim().slice(0, ASK_USER_QUESTION_MAX);
  if (!question) return { status: 400, body: { error: "question required" } };
  const message: Omit<Message, "id" | "at"> = {
    role: "bot",
    kind: "options",
    card: { title: ASK_USER_TITLE, subtitle: question, options: askUserChoices(request.choices), askUser: true },
  };
  // rooms attribute the question to the member who asked, like show_image
  if (owner.group) message.from = { botId: from.id, name: from.name, color: from.color };
  const posted = deps.appendMessage(request.fromThreadId, message);
  deps.notifyQuestion(from, request.fromThreadId, question);
  return { status: 201, body: { messageId: posted.id } };
}
