// Phone ping: ntfy delivery for the moments Orbit needs a human while its page is closed.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { summarize, type Notification } from "./notify.ts";
import { redactSecretsInText } from "./redact.ts";

export const PHONE_PING_FILE = "phone-ping.json";
export const PHONE_PING_TIMEOUT_MS = 5_000;
export const PHONE_PING_DONE_MIN_MS = 60_000;
export const PHONE_PING_REPEAT_MS = 10_000;
const NTFY_BASE = "https://ntfy.sh";
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const phonePingBodySchema = z.object({ topic: z.string() });

export type PhonePingTarget = { base: string; topic: string };
export type PhonePing = { title: string; message: string; tags?: string[]; priority?: number };
export type PhonePingResult = { ok: true } | { ok: false; error: string };

/** Bare topic → ntfy.sh; a full https URL keeps its host. Empty is off (target null). */
export function parsePhonePingTopic(raw: string): { ok: true; target: PhonePingTarget | null } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) return { ok: true, target: null };
  if (TOPIC_RE.test(value)) return { ok: true, target: { base: NTFY_BASE, topic: value } };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "Use a topic (letters, digits, - or _) or an https URL" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "The URL must be https" };
  if (url.username || url.password || url.search || url.hash) return { ok: false, error: "Use a plain https://host/topic URL" };
  const segments = url.pathname.split("/").filter(Boolean);
  const topic = segments.pop() ?? "";
  if (!TOPIC_RE.test(topic)) return { ok: false, error: "The URL must end in a topic (letters, digits, - or _)" };
  const prefix = segments.length ? `/${segments.join("/")}` : "";
  return { ok: true, target: { base: `${url.origin}${prefix}`, topic } };
}

export function loadPhonePingTopic(dataDir: string): string {
  try {
    const parsed = phonePingBodySchema.safeParse(JSON.parse(readFileSync(join(dataDir, PHONE_PING_FILE), "utf8")));
    return parsed.success && parsePhonePingTopic(parsed.data.topic).ok ? parsed.data.topic.trim() : "";
  } catch {
    return "";
  }
}

export function savePhonePingTopic(dataDir: string, topic: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, PHONE_PING_FILE), JSON.stringify({ topic: topic.trim() }, null, 2), { mode: 0o600 });
}

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

/** JSON publish so UTF-8 titles survive. Never throws. Redacts title/message
 * here so every caller's credentials are scrubbed before they leave the process. */
export async function sendPhonePing(
  target: PhonePingTarget,
  ping: PhonePing,
  fetchImpl: typeof fetch = fetch,
  warn: (line: string) => void = console.warn,
): Promise<PhonePingResult> {
  try {
    const safe = { ...ping, title: redactSecretsInText(ping.title), message: redactSecretsInText(ping.message) };
    const res = await fetchImpl(target.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: target.topic, ...safe }),
      signal: AbortSignal.timeout(PHONE_PING_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const error = `ntfy answered ${res.status}`;
    warn(`phone-ping: ${error}`);
    return { ok: false, error };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    warn(`phone-ping: ${error}`);
    return { ok: false, error };
  }
}
