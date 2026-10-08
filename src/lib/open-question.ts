// A bot's ask_user question stays open until the person replies in that chat
// (typing anything, or tapping a choice) or dismisses it. Nothing extra is
// stored: the state is derived from the transcript, so the sidebar glow, the
// pin over the composer and the inline record can never disagree.
import type { Message } from "@/state/store";

/** A non-blocking ask_user card (never the first-run quiz, never a live ask). */
export function isAskUserCard(message: Message): boolean {
  return message.kind === "options" && Boolean(message.card?.askUser) && !message.card?.requestId;
}

/** Only what the person sent closes a question: not pane notes, peers or bots. */
export function isSentByPerson(message: Message): boolean {
  return message.role === "user" && message.kind === "text" && !message.from;
}

/** A live approval or engine-native question still waiting on the person. */
function isOpenRequest(message: Message): boolean {
  return message.kind === "options" && Boolean(message.card?.requestId) && !message.card?.answered && !message.card?.dismissed;
}

export interface NeedsYou {
  /** The chat's open ask_user card, if any. */
  question: Message | null;
  /** An approval or engine question card is still open. */
  request: boolean;
}

const NONE: NeedsYou = { question: null, request: false };
const cache = new WeakMap<readonly Message[], NeedsYou>();

function scanQuestion(messages: readonly Message[]): Message | null {
  // The open question is always after the last sent message, and only the
  // newest marked card can be open (a newer one supersedes it).
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isSentByPerson(message)) return null;
    if (isAskUserCard(message)) return message.card!.dismissed || message.card!.answered ? null : message;
  }
  return null;
}

/** What in this chat is waiting on the person, memoized per message array. */
export function needsYou(messages: readonly Message[]): NeedsYou {
  if (!messages.length) return NONE;
  const cached = cache.get(messages);
  if (cached) return cached;
  const question = scanQuestion(messages);
  const request = messages.some(isOpenRequest);
  const result = question || request ? { question, request } : NONE;
  cache.set(messages, result);
  return result;
}

export function openQuestion(messages: readonly Message[]): Message | null {
  return needsYou(messages).question;
}

/** True when a sidebar row for this chat should glow. */
export function chatNeedsYou(messages: readonly Message[]): boolean {
  const state = needsYou(messages);
  return Boolean(state.question) || state.request;
}

export type AskUserStatus =
  | { state: "waiting" }
  | { state: "answered"; reply: string }
  | { state: "dismissed" }
  | { state: "superseded" };

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

/** How a marked card reads in the transcript. */
export function askUserStatus(messages: readonly Message[], message: Message): AskUserStatus {
  const card = message.card;
  if (card?.answered) return { state: "answered", reply: firstLine(card.answered) };
  if (card?.dismissed) return { state: "dismissed" };
  const index = messages.findIndex((entry) => entry.id === message.id);
  for (let i = index < 0 ? messages.length : index + 1; i < messages.length; i++) {
    const later = messages[i];
    if (isSentByPerson(later)) return { state: "answered", reply: firstLine(later.text ?? "") };
    if (isAskUserCard(later)) return { state: "superseded" };
  }
  return { state: "waiting" };
}

/** For the control hiding the rows (drawer button, collapsed sidebar or
 * section): does any chat other than the open one need the person? */
export function anyChatNeedsYou(
  chats: Iterable<{ id: string; hidden?: boolean; messages: readonly Message[] }>,
  exceptId?: string,
): boolean {
  for (const chat of chats) {
    if (chat.id !== exceptId && !chat.hidden && chatNeedsYou(chat.messages)) return true;
  }
  return false;
}
