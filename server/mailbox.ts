import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { z } from "zod";

export const MAILBOX_GRANT_PREFIX = "orbit-mailbox-v1";
export const MAILBOX_NOTE_MAX_CHARS = 8000;
export const MAILBOX_BODY_MAX_BYTES = 16 * 1024;
export const MAILBOX_BODY_TIMEOUT_MS = 10_000;

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

const mailboxScopeSchema = z.object({ pane: id, bot: id, teacher: id });

export const mailboxPostSchema = z.object({ text: z.string() });

export function mailboxGrant(token: string, pane: string, bot: string, teacher: string): string {
  return createHmac("sha256", token).update(`${MAILBOX_GRANT_PREFIX}:${pane}:${bot}:${teacher}`).digest("base64url");
}

export function mailboxGrantMatches(header: string | string[] | undefined, token: string, pane: string, bot: string, teacher: string): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- HTTP authorization is untyped request input.
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice(7));
  const expected = Buffer.from(mailboxGrant(token, pane, bot, teacher));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Scope rides in headers so the grant is checked before any body byte is read. */
export function mailboxScope(headers: IncomingHttpHeaders, token: string) {
  const scope = mailboxScopeSchema.safeParse({ pane: headers["x-orbit-pane"], bot: headers["x-orbit-bot"], teacher: headers["x-orbit-teacher"] });
  if (!scope.success) return null;
  const { pane, bot, teacher } = scope.data;
  return mailboxGrantMatches(headers.authorization, token, pane, bot, teacher) ? scope.data : null;
}

type MailboxBody = { ok: true; value: unknown } | { ok: false; status: number; error: string };

/** Oversized bodies drain without being kept; a stalled one is destroyed at the deadline. */
export function readMailboxBody(req: IncomingMessage, maxBytes = MAILBOX_BODY_MAX_BYTES, timeoutMs = MAILBOX_BODY_TIMEOUT_MS): Promise<MailboxBody> {
  return new Promise((resolve) => {
    const tooLarge = { ok: false, status: 413, error: "body too large" } as const;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => req.destroy(), timeoutMs);
    if (Number(req.headers["content-length"]) > maxBytes) resolve(tooLarge);
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      if (bytes > maxBytes) return resolve(tooLarge);
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ ok: false, status: 400, error: "invalid JSON body" });
      }
    });
    req.on("close", () => {
      clearTimeout(timer);
      resolve({ ok: false, status: 408, error: "body timeout" });
    });
  });
}

/** Pane text is untrusted: strip escapes and controls, cap it, tag it. Null when nothing is left. */
export function mailboxNoteText(pane: string, text: string): string | null {
  const clean = text
    .replace(/\r\n?/g, "\n")
    // oxlint-disable-next-line no-control-regex -- terminal output carries ANSI escapes
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])/g, "")
    // oxlint-disable-next-line no-control-regex -- keep only tab and newline
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .trim();
  if (!clean) return null;
  const capped = clean.length > MAILBOX_NOTE_MAX_CHARS ? `${clean.slice(0, MAILBOX_NOTE_MAX_CHARS)}\n[truncated]` : clean;
  return `[pane ${pane.slice(0, 8)}] ${capped}`;
}
