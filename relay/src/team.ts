// Team usage for the owner's /v1/team: when each PC's control channel is up
// and when phones are spliced to it. Labels, times and PC names only, kept 90
// days. Closed spans go to an append-only journal; open ones are checkpointed
// with their last-seen time, so a crash closes them there on the next boot.

import { createHash } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LABEL_RE } from "../../shared/relay-protocol.ts";
import { silentLogger, type Logger } from "./log.ts";

const JOURNAL = "team-sessions";
const CHECKPOINT = "team-open";
const DAY_MS = 24 * 60 * 60 * 1000;
export const TEAM_KEEP_MS = 90 * DAY_MS;
export const TEAM_DAYS = 14;
export const CHECKPOINT_MS = 60_000;
/** Phone joins closer than this count as one phone session. */
export const PHONE_GAP_MS = 2 * 60_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SPANS = 500_000;
const SPAN_RE = /^(pc|phone) ([a-z2-7]{16}) (\d{1,15}) (\d{1,15})$/;
const NAME_RE = /^name ([a-z2-7]{16}) ([A-Za-z0-9_-]{0,400})$/;
const ACCT_RE = /^acct ([a-z2-7]{16}) ([A-Za-z0-9_-]{43})$/;
const WHO_RE = /^who ([a-z2-7]{16}) ([A-Za-z0-9_-]{0,400})$/;
const TEST_RE = /^test ([a-z2-7]{16}) (\d{1,15})$/;

type Kind = "pc" | "phone";

const time = z.int().nonnegative();
const label = z.string().regex(LABEL_RE);
const checkpointSchema = z.strictObject({
  at: time,
  pc: z.array(z.tuple([label, time, time])),
  phone: z.array(z.tuple([label, time])),
});

interface Span {
  kind: Kind;
  label: string;
  start: number;
  end: number;
}

type Checkpoint = z.infer<typeof checkpointSchema>;

export interface TeamPc {
  label: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  firstSeen: number | null;
  /** Hours online per day, oldest first. */
  hours: number[];
  phone: { count: number; minutes: number }[];
}

export interface TeamPersonPc {
  label: string;
  name: string;
  online: boolean;
}

export interface TeamPerson {
  /** Opaque id. Never the account hash. */
  id: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  pcs: TeamPersonPc[];
  /** Hours online per day, union of this person's PCs, oldest first. */
  hours: number[];
  phone: { count: number; minutes: number }[];
}

export interface TeamStats {
  now: number;
  /** Local dates (YYYY-MM-DD) of the TEAM_DAYS columns, oldest first. */
  days: string[];
  pcs: TeamPc[];
  people: TeamPerson[];
}

async function readText(path: string): Promise<string> {
  try {
    const handle = await open(path, "r");
    try {
      if ((await handle.stat()).size > MAX_FILE_BYTES) throw new Error(`${path} is too large`);
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    // SAFETY: fs rejects with Node errno errors.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  if (process.platform !== "win32") {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}

function parseCheckpoint(text: string): Checkpoint | null {
  try {
    const parsed = checkpointSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Sorted, merged copies of the spans; spans closer than `gap` join. */
function merge(spans: { start: number; end: number }[], gap: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && span.start - last.end <= gap) last.end = Math.max(last.end, span.end);
    else out.push({ start: span.start, end: span.end });
  }
  return out;
}

const overlap = (span: { start: number; end: number }, from: number, to: number) =>
  Math.max(0, Math.min(span.end, to) - Math.max(span.start, from));

export class TeamLog {
  private spans: Span[] = [];
  private readonly names = new Map<string, string>();
  private readonly accounts = new Map<string, string>();
  private readonly whos = new Map<string, string>();
  /** Operator test PCs, by when they were marked. Kept off stats. */
  private readonly tests = new Map<string, number>();
  private readonly openPc = new Map<string, { start: number; seen: number }>();
  private readonly openPhones = new Map<number, { label: string; start: number }>();
  private nextPhone = 0;
  private writes: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private checkpointed = false;
  private prunedAt = 0;
  private readonly journal: string;
  private readonly checkpointFile: string;

  private constructor(
    dir: string,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {
    this.journal = join(dir, JOURNAL);
    this.checkpointFile = join(dir, CHECKPOINT);
  }

  /** Loads the journal, closes spans a crash left open at their last-seen time, and drops spans past 90 days. */
  static async open(dir: string, now: () => number = Date.now, log: Logger = silentLogger): Promise<TeamLog> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const team = new TeamLog(dir, now, log);
    for (const line of (await readText(team.journal)).split("\n")) {
      const span = SPAN_RE.exec(line);
      if (span) {
        team.add({ kind: span[1] === "pc" ? "pc" : "phone", label: span[2], start: Number(span[3]), end: Number(span[4]) });
        continue;
      }
      const name = NAME_RE.exec(line);
      if (name) {
        team.names.set(name[1], Buffer.from(name[2], "base64url").toString("utf8"));
        continue;
      }
      const acct = ACCT_RE.exec(line);
      if (acct) {
        team.accounts.set(acct[1], acct[2]);
        continue;
      }
      const test = TEST_RE.exec(line);
      if (test) {
        team.tests.set(test[1], Math.max(team.tests.get(test[1]) ?? 0, Number(test[2])));
        continue;
      }
      const who = WHO_RE.exec(line);
      if (who) team.noteWho(who[1], Buffer.from(who[2], "base64url").toString("utf8"));
    }
    const cp = parseCheckpoint(await readText(team.checkpointFile));
    for (const [label, start, seen] of cp?.pc ?? []) team.add({ kind: "pc", label, start, end: seen });
    for (const [label, start] of cp?.phone ?? []) team.add({ kind: "phone", label, start, end: cp!.at });
    team.prune();
    await team.compact();
    await writeAtomic(team.checkpointFile, team.serializeCheckpoint());
    team.timer = setInterval(() => team.checkpoint(), CHECKPOINT_MS);
    team.timer.unref();
    return team;
  }

  pcUp(label: string): void {
    const at = this.now();
    this.openPc.set(label, { start: at, seen: at });
  }

  pcSeen(label: string): void {
    const open = this.openPc.get(label);
    if (open) open.seen = this.now();
  }

  pcDown(label: string): void {
    const open = this.openPc.get(label);
    if (!open) return;
    this.openPc.delete(label);
    this.record({ kind: "pc", label, start: open.start, end: this.now() });
  }

  setName(label: string, name: string): void {
    if (!name || this.names.get(label) === name) return;
    this.names.set(label, name);
    this.append(`name ${label} ${Buffer.from(name, "utf8").toString("base64url")}\n`);
  }

  /** Records the account hash and Wink name. Appends only when either changed. */
  setAccount(label: string, subHash: string, person: string): void {
    if (!LABEL_RE.test(label) || !ACCT_RE.test(`acct ${label} ${subHash}`)) return;
    if (this.accounts.get(label) !== subHash) {
      this.accounts.set(label, subHash);
      this.append(`acct ${label} ${subHash}\n`);
    }
    if (this.whos.get(label) === person) return;
    if (!this.whos.has(label) && person === "") return;
    this.noteWho(label, person);
    this.append(`who ${label} ${Buffer.from(person, "utf8").toString("base64url")}\n`);
  }

  /** Marks a PC enrolled with an operator test invite. */
  markTest(label: string): void {
    if (!LABEL_RE.test(label)) return;
    const at = this.now();
    this.tests.set(label, at);
    this.append(`test ${label} ${at}\n`);
  }

  phoneStart(label: string): number {
    const id = this.nextPhone++;
    this.openPhones.set(id, { label, start: this.now() });
    return id;
  }

  phoneEnd(id: number): void {
    const open = this.openPhones.get(id);
    if (!open) return;
    this.openPhones.delete(id);
    this.record({ kind: "phone", label: open.label, start: open.start, end: this.now() });
  }

  /** Persists open spans with their last-seen time. Runs every minute; also drops spans past 90 days hourly. */
  checkpoint(): Promise<void> {
    if (this.now() - this.prunedAt >= 60 * 60_000 && this.prune()) void this.compact();
    const live = this.openPc.size > 0 || this.openPhones.size > 0;
    if (!live && !this.checkpointed) return this.writes;
    this.checkpointed = live;
    const text = this.serializeCheckpoint();
    return this.queue(() => writeAtomic(this.checkpointFile, text));
  }

  /** Stops the checkpoint timer and waits for pending writes. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.checkpoint();
    await this.writes;
  }

  stats(tzOffsetMin: number): TeamStats {
    const now = this.now();
    const shift = tzOffsetMin * 60_000;
    const today = Math.floor((now + shift) / DAY_MS) * DAY_MS - shift;
    const starts = Array.from({ length: TEAM_DAYS }, (_, i) => today - (TEAM_DAYS - 1 - i) * DAY_MS);
    const byLabel = new Map<string, { pc: { start: number; end: number }[]; phone: { start: number; end: number }[] }>();
    const bucket = (label: string) => {
      let entry = byLabel.get(label);
      if (!entry) byLabel.set(label, (entry = { pc: [], phone: [] }));
      return entry;
    };
    for (const span of this.spans) bucket(span.label)[span.kind].push(span);
    for (const [label, open] of this.openPc) bucket(label).pc.push({ start: open.start, end: now });
    for (const open of this.openPhones.values()) bucket(open.label).phone.push({ start: open.start, end: now });
    for (const label of this.tests.keys()) byLabel.delete(label);

    const pcs: TeamPc[] = [];
    for (const [label, entry] of byLabel) {
      const pc = merge(entry.pc, 0);
      const phone = merge(entry.phone, PHONE_GAP_MS);
      const online = this.openPc.has(label);
      const all = [...pc, ...phone];
      pcs.push({
        label,
        name: this.names.get(label)?.trim() || label,
        online,
        lastSeen: online ? now : pc.length > 0 ? Math.max(...pc.map((s) => s.end)) : null,
        firstSeen: all.length > 0 ? Math.min(...all.map((s) => s.start)) : null,
        hours: starts.map((from) => Math.round(pc.reduce((sum, s) => sum + overlap(s, from, from + DAY_MS), 0) / 36_000) / 100),
        phone: starts.map((from) => ({
          count: phone.filter((s) => s.start >= from && s.start < from + DAY_MS).length,
          minutes: Math.round(phone.reduce((sum, s) => sum + overlap(s, from, from + DAY_MS), 0) / 60_000),
        })),
      });
    }
    pcs.sort((a, b) => a.name.localeCompare(b.name) || (a.label < b.label ? -1 : 1));
    const days = starts.map((from) => new Date(from + shift).toISOString().slice(0, 10));
    return { now, days, pcs, people: this.people(byLabel, pcs, starts, now) };
  }

  private record(span: Span): void {
    this.add(span);
    this.append(`${span.kind} ${span.label} ${span.start} ${span.end}
`);
  }

  private add(span: Span): void {
    if (span.end < span.start) return;
    this.spans.push(span);
    if (this.spans.length > MAX_SPANS) this.spans.splice(0, this.spans.length - MAX_SPANS);
  }

  /** Drops spans that ended over 90 days ago, names no span still uses, and test marks past both. True when anything went. */
  private prune(): boolean {
    this.prunedAt = this.now();
    const cutoff = this.prunedAt - TEAM_KEEP_MS;
    const before = this.spans.length;
    this.spans = this.spans.filter((span) => span.end >= cutoff);
    const used = new Set([...this.spans.map((s) => s.label), ...this.openPc.keys()]);
    let dropped = before !== this.spans.length;
    for (const label of new Set([...this.names.keys(), ...this.accounts.keys(), ...this.whos.keys()])) {
      if (used.has(label)) continue;
      this.names.delete(label);
      this.accounts.delete(label);
      this.whos.delete(label);
      dropped = true;
    }
    for (const [label, at] of this.tests) {
      if (used.has(label) || at >= cutoff) continue;
      this.tests.delete(label);
      dropped = true;
    }
    return dropped;
  }

  private serializeCheckpoint(): string {
    const cp: Checkpoint = {
      at: this.now(),
      pc: [...this.openPc].map(([label, open]) => [label, open.start, open.seen]),
      phone: [...this.openPhones.values()].map((open) => [open.label, open.start]),
    };
    return `${JSON.stringify(cp)}\n`;
  }

  /** Snapshots the journal now, so spans recorded after this call append behind the rewrite. */
  private compact(): Promise<void> {
    let text = "";
    for (const [label, name] of this.names) text += `name ${label} ${Buffer.from(name, "utf8").toString("base64url")}
`;
    for (const [label, subHash] of this.accounts) text += `acct ${label} ${subHash}
`;
    for (const [label, person] of this.whos) text += `who ${label} ${Buffer.from(person, "utf8").toString("base64url")}
`;
    for (const [label, at] of this.tests) text += `test ${label} ${at}\n`;
    for (const span of this.spans) text += `${span.kind} ${span.label} ${span.start} ${span.end}
`;
    return this.queue(() => writeAtomic(this.journal, text));
  }

  private append(line: string): void {
    void this.queue(async () => {
      const handle = await open(this.journal, "a", 0o600);
      try {
        await handle.appendFile(line, "utf8");
      } finally {
        await handle.close();
      }
    });
  }

  /** Latest write stays last in the map, so a compact reload keeps that order. */
  private noteWho(label: string, person: string): void {
    this.whos.delete(label);
    this.whos.set(label, person);
  }

  private people(
    byLabel: Map<string, { pc: { start: number; end: number }[]; phone: { start: number; end: number }[] }>,
    pcs: TeamPc[],
    starts: number[],
    now: number,
  ): TeamPerson[] {
    const pcByLabel = new Map(pcs.map((pc) => [pc.label, pc]));
    const groups = new Map<string, string[]>();
    for (const label of byLabel.keys()) {
      const key = this.accounts.get(label) ?? `pc:${label}`;
      const list = groups.get(key);
      if (list) list.push(label);
      else groups.set(key, [label]);
    }
    const people: TeamPerson[] = [];
    for (const [key, labels] of groups) {
      const members = labels.flatMap((label) => {
        const pc = pcByLabel.get(label);
        return pc ? [pc] : [];
      });
      const merged = merge(labels.flatMap((label) => byLabel.get(label)?.pc ?? []), 0);
      let wink = "";
      let seq = -1;
      for (const label of labels) {
        const written = (this.whos.get(label) ?? "").trim();
        const at = this.whoAt(label);
        if (written && at >= seq) {
          seq = at;
          wink = written;
        }
      }
      const named = members.slice().sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || a.name.localeCompare(b.name));
      const online = members.some((pc) => pc.online);
      people.push({
        id: createHash("sha256").update(`wink-team-person/1\0${key}`, "utf8").digest("base64url"),
        name: wink || named[0]?.name || labels[0] || key,
        online,
        lastSeen: online ? now : named.reduce<number | null>((max, pc) => (pc.lastSeen == null ? max : max == null ? pc.lastSeen : Math.max(max, pc.lastSeen)), null),
        pcs: members
          .map((pc) => ({ label: pc.label, name: pc.name, online: pc.online }))
          .sort((a, b) => a.name.localeCompare(b.name) || (a.label < b.label ? -1 : 1)),
        hours: starts.map((from) => Math.round(merged.reduce((sum, span) => sum + overlap(span, from, from + DAY_MS), 0) / 36_000) / 100),
        phone: starts.map((_, index) => ({
          count: members.reduce((sum, pc) => sum + (pc.phone[index]?.count ?? 0), 0),
          minutes: members.reduce((sum, pc) => sum + (pc.phone[index]?.minutes ?? 0), 0),
        })),
      });
    }
    people.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
    return people;
  }

  /** Position in who-write order. Map iteration order is that order. */
  private whoAt(label: string): number {
    if (!this.whos.has(label)) return -1;
    let at = 0;
    for (const key of this.whos.keys()) {
      if (key === label) return at;
      at += 1;
    }
    return -1;
  }

  private queue(task: () => Promise<void>): Promise<void> {
    const write = this.writes.then(task);
    this.writes = write.catch(() => this.log.log("team-write-failed", {}));
    return this.writes;
  }
}
