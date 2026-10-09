// Phone ping: which moments Orbit needs a human while its page is closed.
import { summarize, type Notification } from "./notify.ts";
import { parsePaneNote } from "../shared/pane-note.ts";
import { redactSecretsInText } from "./redact.ts";

export const PHONE_PING_DONE_MIN_MS = 60_000;
export const PHONE_PING_REPEAT_MS = 10_000;

export type PhonePing = { title: string; message: string; tags?: string[]; priority?: number };

/** Short done replies stay quiet; everything that blocks on a person pings. */
export function pingForNotification(notification: Notification, turnMs?: number): PhonePing | null {
  if (notification.kind === "done" && !(turnMs !== undefined && turnMs >= PHONE_PING_DONE_MIN_MS)) return null;
  const ping: PhonePing = { title: notification.title, message: notification.body };
  if (notification.kind === "approval" || notification.kind === "question" || notification.kind === "takeover") ping.priority = 4;
  return ping;
}

const PING_STATUS = { failed: "failed", blocked: "needs an answer" } as const;

/** Worker FAIL / BLOCKED reports ping; DONE and plain notes do not. */
export function pingForMailbox(botName: string, text: string): PhonePing | null {
  const note = parsePaneNote(redactSecretsInText(text).trimStart());
  if (note.status !== "failed" && note.status !== "blocked") return null;
  const status = PING_STATUS[note.status];
  const sentence = note.body.split(/(?<=[.!?])\s|\n/, 1)[0]?.trim();
  return { title: `${botName}: worker ${status}`, message: summarize(sentence ? `${note.nick} ${status}: ${sentence}` : `${note.nick} ${status}.`), tags: ["warning"] };
}

/** True when this bot/title/message triple has not pinged within the window,
 * so distinct events (two different FAIL reports) both get through while an
 * exact repeat still collapses. */
export function createPingLimiter(windowMs = PHONE_PING_REPEAT_MS, now: () => number = Date.now) {
  const last = new Map<string, number>();
  return (botId: string, title: string, message: string): boolean => {
    const at = now();
    for (const [key, sent] of last) if (at - sent >= windowMs) last.delete(key);
    const key = `${botId}\n${title}\n${message}`;
    if (last.has(key)) return false;
    last.set(key, at);
    return true;
  };
}
