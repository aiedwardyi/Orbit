import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const MAILBOX_GRANT_PREFIX = "orbit-mailbox-v1";
export const MAILBOX_NOTE_MAX_CHARS = 8000;

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

export const mailboxPostSchema = z.object({
  pane: id,
  bot: id,
  teacher: id,
  text: z.string().max(200_000),
});

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
