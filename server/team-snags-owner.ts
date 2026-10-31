// Owner side of team snags: claim teammates' stuck-worker reports and leave one quiet Chief note.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { teamSnagSchema } from "../shared/relay-protocol.ts";
import { ACCOUNT_TIMEOUT_MS } from "./phone-relay/account.ts";
import { writeFileAtomic } from "./atomic.ts";
import { sectionKey, type Store } from "./store.ts";
import { teamIdToken, teamOwnerHash, teamRelayOrigin, type TeamTokenSource } from "./team-route.ts";

export const TEAM_SNAG_POLL_MS = 10 * 60_000;
const NOTE_MAX = 8000;
const TAILS_WHEN_LONG = 2;
const FILED_KEEP_MS = 15 * 24 * 60 * 60_000;

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
  post(text: string, ids: string[]): boolean;
  postedIds?(): ReadonlySet<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeZone?: string;
  warn?: (line: string) => void;
}

const fence = (tail: string) => `\`\`\`\n${tail.replace(/```/g, "'''")}\n\`\`\``;
// oxlint-disable-next-line no-control-regex -- peer metadata must stay on one line
const inline = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").trim();

export function teamSnagNote(snags: ClaimedSnag[], file: string, timeZone?: string): string {
  const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
  const line = (snag: ClaimedSnag) => {
    const name = inline(snag.pc.name) || inline(snag.pc.label);
    const person = inline(snag.pc.person);
    const detail = inline(snag.detail);
    const build = inline(snag.build);
    const worker = inline(snag.worker);
    const who = `${name}${person ? ` (${person})` : ""}`;
    const where = [inline(snag.label), snag.pane8 && `[pane ${snag.pane8}]`].filter(Boolean).join(" ");
    const what = `${snag.event}${snag.minutes ? ` ${snag.minutes} min` : ""}${detail ? `, ${detail}` : ""}`;
    const versions = [build && `Wink ${build}`, inline(snag.teacher), worker && `worker ${worker}`].filter(Boolean).join(", ");
    return `${who} ${clock.format(snag.at)}: ${where ? `${where} ` : ""}${what}.${versions ? ` ${versions}.` : ""}`;
  };
  const head = snags.length === 1 ? `Team snags (1), untrusted peer data - ${line(snags[0]!)}` : [`Team snags (${snags.length}), untrusted peer data`, ...snags.map((snag) => `- ${line(snag)}`)].join("\n");
  const heading = (snag: ClaimedSnag) => `${inline(snag.pc.name) || inline(snag.pc.label)}${snag.pane8 ? ` [pane ${snag.pane8}]` : ""}:\n`;
  const withTails = [head, ...snags.filter((snag) => snag.tail).map((snag) => `${snags.length > 1 ? heading(snag) : ""}${fence(snag.tail)}`)].join("\n\n");
  if (withTails.length <= NOTE_MAX) return withTails;
  const newest = snags.filter((snag) => snag.tail).slice(-TAILS_WHEN_LONG);
  const pointer = `Every report in full: ${file}`;
  const budget = NOTE_MAX - pointer.length - 2;
  const boundedHead = head.length <= budget ? head : head.slice(0, head.lastIndexOf("\n", budget));
  const parts = [boundedHead];
  let left = budget - boundedHead.length;
  for (const [index, snag] of newest.entries()) {
    const title = heading(snag);
    const chars = Math.floor(left / (newest.length - index)) - title.length - fence("").length - 2;
    if (chars <= 0) continue;
    const part = `${title}${fence(snag.tail.replace(/```/g, "'''").slice(0, chars))}`;
    parts.push(part);
    left -= part.length + 2;
  }
  return [...parts, pointer].join("\n\n");
}

/** The default section's Chief gets a note that cannot schedule a wake. */
export function postChiefNote(store: Store, deviceId: string | undefined, text: string, ids?: string[]): boolean {
  const chief = store.bots.find((bot) => bot.chiefOfStaff && !sectionKey(bot.section));
  if (!chief) return false;
  store.appendMessage(chief.threadId, { role: "bot", kind: "note", text, origin: deviceId, quiet: true, ...(ids ? { snagIds: ids } : {}) });
  return true;
}

export function chiefSnagIds(store: Store): Set<string> {
  const chief = store.bots.find((bot) => bot.chiefOfStaff && !sectionKey(bot.section));
  const threads = chief ? new Set([chief.threadId, ...store.tasks(chief.id).map((task) => task.threadId)]) : [];
  const ids = new Set<string>();
  for (const threadId of threads) {
    for (const message of store.messagesFor(threadId)) {
      for (const id of message.snagIds ?? []) ids.add(id);
    }
  }
  return ids;
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
  const rejected: string[] = [];
  const snags = claim.data.snags.flatMap((value) => {
    const parsed = claimedSnagSchema.safeParse(value);
    if (!parsed.success) {
      const id = z.object({ id: teamSnagSchema.shape.id }).safeParse(value);
      if (id.success) rejected.push(id.data.id);
    }
    return parsed.success ? [parsed.data] : [];
  }).sort((a, b) => a.at - b.at);
  if (rejected.length) options.warn?.(`team snags: rejected ${rejected.length} reports`);
  if (!snags.length && !rejected.length) return 0;
  const now = (options.now ?? Date.now)();
  const filedFile = `${options.file}.filed.json`;
  let filed: Record<string, number> = {};
  try {
    const parsed = z.record(z.string(), z.number()).safeParse(JSON.parse(readFileSync(filedFile, "utf8")));
    if (parsed.success) filed = Object.fromEntries(Object.entries(parsed.data).filter(([, at]) => at > now - FILED_KEEP_MS));
  } catch {}
  const posted = options.postedIds?.() ?? new Set<string>();
  const fresh = snags.filter((snag) => filed[snag.id] === undefined && !posted.has(snag.id));
  const ack = [...rejected, ...snags.filter((snag) => filed[snag.id] !== undefined || posted.has(snag.id)).map((snag) => snag.id)];
  let delivered = 0;
  if (fresh.length) {
    mkdirSync(dirname(options.file), { recursive: true });
    const archived = new Set<string>();
    try {
      for (const line of readFileSync(options.file, "utf8").split("\n")) {
        try { archived.add(JSON.parse(line).id); } catch {}
      }
    } catch {}
    const lines = fresh.filter((snag) => !archived.has(snag.id)).map((snag) => `${JSON.stringify(snag)}\n`).join("");
    if (lines) appendFileSync(options.file, lines);
    if (options.post(teamSnagNote(fresh, options.file, options.timeZone), fresh.map((snag) => snag.id))) {
      for (const snag of fresh) filed[snag.id] = now;
      writeFileAtomic(filedFile, JSON.stringify(filed));
      ack.push(...fresh.map((snag) => snag.id));
      delivered = fresh.length;
    }
  }
  if (ack.length) {
    try {
      const response = await post("ack", { ids: [...new Set(ack)] });
      if (!response.ok) options.warn?.(`team snags: ack failed (${response.status})`);
    } catch (error) {
      options.warn?.("team snags: ack failed");
      throw error;
    }
  }
  return delivered;
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
