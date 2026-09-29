// Phone ping: which moments Orbit needs a human while its page is closed.
import { summarize, type Notification } from "./notify.ts";
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

/** Worker FAIL / BLOCKED reports ping; DONE and plain notes do not. */
export function pingForMailbox(botName: string, text: string): PhonePing | null {
  const first = redactSecretsInText(text).trimStart().split(/\r?\n/, 1)[0] ?? "";
  const status = /^(FAIL|BLOCKED) /.exec(first)?.[1];
  if (!status) return null;
  return { title: `${botName}: worker ${status}`, message: summarize(first), tags: ["warning"] };
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
