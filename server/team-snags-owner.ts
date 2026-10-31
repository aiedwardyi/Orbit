// Owner side of team snags: claim teammates' stuck-worker reports and leave one quiet Chief note.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { teamSnagSchema } from "../shared/relay-protocol.ts";
import { ACCOUNT_TIMEOUT_MS } from "./phone-relay/account.ts";
import { sectionKey, type Store } from "./store.ts";
import { teamIdToken, teamOwnerHash, teamRelayOrigin, type TeamTokenSource } from "./team-route.ts";

export const TEAM_SNAG_POLL_MS = 10 * 60_000;
const NOTE_MAX = 8000;
const TAILS_WHEN_LONG = 2;

const claimedSnagSchema = teamSnagSchema.extend({
  pc: z.object({ label: z.string().max(64), name: z.string().max(200), person: z.string().max(200) }),
});
export type ClaimedSnag = z.infer<typeof claimedSnagSchema>;
const claimSchema = z.object({ snags: z.array(z.unknown()) });

export interface TeamSnagOwnerOptions {
  enrolledBase(): string | null;
  baked: string | null;
  ownerHash: string | null;
  email(): string | null;
  tokens: TeamTokenSource;
  /** Full JSON lines, for the Chief to read on request. */
  file: string;
  post(text: string): void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeZone?: string;
  warn?: (line: string) => void;
}

const fence = (tail: string) => `\`\`\`\n${tail.replace(/```/g, "'''")}\n\`\`\``;

export function teamSnagNote(snags: ClaimedSnag[], file: string, timeZone?: string): string {
  const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
  const line = (snag: ClaimedSnag) => {
    const who = `${snag.pc.name || snag.pc.label}${snag.pc.person ? ` (${snag.pc.person})` : ""}`;
    const where = [snag.label, snag.pane8 && `[pane ${snag.pane8}]`].filter(Boolean).join(" ");
    const what = `${snag.event}${snag.minutes ? ` ${snag.minutes} min` : ""}${snag.detail ? `, ${snag.detail}` : ""}`;
    const versions = [snag.build && `Wink ${snag.build}`, snag.teacher, snag.worker && `worker ${snag.worker}`].filter(Boolean).join(", ");
    return `${who} ${clock.format(snag.at)}: ${where ? `${where} ` : ""}${what}.${versions ? ` ${versions}.` : ""}`;
  };
  const head = snags.length === 1 ? `Team snags (1) - ${line(snags[0]!)}` : [`Team snags (${snags.length})`, ...snags.map((snag) => `- ${line(snag)}`)].join("\n");
  const withTails = [head, ...snags.filter((snag) => snag.tail).map((snag) => `${snags.length > 1 ? `${snag.pc.name || snag.pc.label} [pane ${snag.pane8}]:\n` : ""}${fence(snag.tail)}`)].join("\n\n");
  if (withTails.length <= NOTE_MAX) return withTails;
  const newest = snags.filter((snag) => snag.tail).slice(-TAILS_WHEN_LONG);
  return [head, ...newest.map((snag) => `${snag.pc.name || snag.pc.label} [pane ${snag.pane8}]:\n${fence(snag.tail)}`), `Every report in full: ${file}`].join("\n\n").slice(0, NOTE_MAX);
}

/** The default section's Chief gets the note; the skip marker keeps it from waking the Chief. */
export function postChiefNote(store: Store, deviceId: string | undefined, text: string): boolean {
  const chief = store.bots.find((bot) => bot.chiefOfStaff && !sectionKey(bot.section));
  if (!chief) return false;
  const message = store.appendMessage(chief.threadId, { role: "bot", kind: "note", text, origin: deviceId });
  store.markPaneNotesSkipped(chief.id, chief.threadId, message.id);
  return true;
}

/** One claim: owner-gated like /api/team. Returns how many reports it took. */
export async function claimTeamSnags(options: TeamSnagOwnerOptions): Promise<number> {
  const origin = teamRelayOrigin(options.enrolledBase(), options.baked);
  const email = (options.email() ?? "").trim();
  const owner = (options.ownerHash ?? "").trim().toLowerCase();
  if (!origin || !owner || !email || teamOwnerHash(email) !== owner) return 0;
  const token = await teamIdToken(options.tokens, options.now);
  if (!token) return 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  const post = (path: string, body?: { ids: string[] }) => {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (body) headers.set("content-type", "application/json");
    return fetchImpl(`${origin}/v1/team/snags/${path}`, {
      method: "POST", headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
    });
  };
  const response = await post("claim");
  if (!response.ok) return 0;
  const claim = claimSchema.safeParse(await response.json());
  if (!claim.success) return 0;
  const snags = claim.data.snags.flatMap((value) => {
    const parsed = claimedSnagSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  }).sort((a, b) => a.at - b.at);
  if (!snags.length) return 0;
  mkdirSync(dirname(options.file), { recursive: true });
  appendFileSync(options.file, snags.map((snag) => `${JSON.stringify(snag)}\n`).join(""));
  options.post(teamSnagNote(snags, options.file, options.timeZone));
  await post("ack", { ids: snags.map((snag) => snag.id) });
  return snags.length;
}

export function startTeamSnagOwner(options: TeamSnagOwnerOptions): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void claimTeamSnags(options)
      .catch((error) => options.warn?.(`team snags: claim failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, TEAM_SNAG_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
