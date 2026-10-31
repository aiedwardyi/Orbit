import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  SNAG_DETAIL_CHARS,
  SNAG_EVENTS,
  SNAG_ID_RE,
  SNAG_MAX_BYTES,
  SNAG_NOTES_MAX,
  SNAG_TAIL_CHARS,
  SNAG_TAIL_LINES,
  type PhoneRelayStatus,
  type TeamSnag,
} from "../shared/relay-protocol.ts";
import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";

/** Under userData; Electron writes here too, only while it exists. */
export const SNAG_SPOOL_DIR = "team-snags";
// Outside the spool, so deleting the queue never resets the daily cap.
const SENT_FILE = "team-snags-sent.json";
const DAY_CAP = 10;
const QUEUE_CAP = 20;
const KEEP_MS = 3 * 24 * 60 * 60_000;
const REPEAT_MS = 60 * 60_000;

/** One spooled report before scrubbing. `key` is the pane or bot it repeats on. */
export const spooledSnagSchema = z.object({
  id: z.string().regex(SNAG_ID_RE),
  at: z.int().nonnegative(),
  event: z.enum(SNAG_EVENTS),
  key: z.string().max(200),
  bot: z.string().max(200).optional(),
  worker: z.string().max(200).optional(),
  pane: z.string().max(200).optional(),
  label: z.string().max(200).optional(),
  minutes: z.int().min(0).max(100_000).optional(),
  notes: z.array(z.tuple([z.string().max(200), z.int().min(0).max(100_000)])).max(100).optional(),
  detail: z.string().max(4000).optional(),
  tail: z.string().max(64_000).optional(),
});
export type SpooledSnag = z.infer<typeof spooledSnagSchema>;

export interface ScrubContext {
  home: string;
  user: string;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// oxlint-disable-next-line no-control-regex -- pane tails carry terminal escapes
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
// oxlint-disable-next-line no-control-regex -- keeps tab and newline
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#'"<>`)\]]+)([^\s'"<>`)\]]*)/gi;
const HEX = /\b[0-9a-fA-F]{32,}\b/g;
const BASE64 = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const marker = (chars: number) => `«redacted ${chars} chars»`;

export function scrubSnagText(text: string, ctx: ScrubContext): string {
  let out = text.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(CONTROLS, "");
  out = redactSecretsInText(out);
  const home = ctx.home.split(/[\\/]+/).filter(Boolean).map(escape);
  if (home.length) out = out.replace(new RegExp(`${/^[\\/]/.test(ctx.home) ? "[\\\\/]" : ""}${home.join("[\\\\/]+")}`, "gi"), "~");
  if (ctx.user.length >= 2) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escape(ctx.user)}(?![A-Za-z0-9])`, "gi"), "«user»");
  // URLs before emails, or user:pw@host reads as an email.
  out = out.replace(URL_RE, (_m, scheme: string, host: string, rest: string) => `${scheme}://${host.slice(host.lastIndexOf("@") + 1)}${rest ? "/…" : ""}`);
  out = out.replace(EMAIL, "«email»");
  out = out.replace(HEX, (m) => marker(m.length));
  return out.replace(BASE64, (m) => (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? marker(m.length) : m));
}

const lastLines = (text: string) => text.split("\n").slice(-SNAG_TAIL_LINES).join("\n").slice(-SNAG_TAIL_CHARS);
const frameBytes = (snag: TeamSnag) => Buffer.byteLength(JSON.stringify({ type: "snag", data: snag }));

export function buildTeamSnag(raw: SpooledSnag, ctx: ScrubContext & { build: string; os: string; teacher: string }): TeamSnag {
  const scrub = (value: string | undefined) => scrubSnagText(value ?? "", ctx);
  const snag: TeamSnag = {
    id: raw.id,
    at: raw.at,
    event: raw.event,
    build: ctx.build.slice(0, 40),
    os: ctx.os.slice(0, 20),
    teacher: ctx.teacher.slice(0, 120),
    worker: (raw.worker ?? "").slice(0, 20),
    pane8: (raw.pane ?? "").replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 8),
    label: scrub(raw.label).slice(0, 40),
    minutes: raw.minutes ?? 0,
    notes: (raw.notes ?? []).slice(-SNAG_NOTES_MAX).map(([kind, minutes]) => [kind.slice(0, 20), minutes]),
    detail: scrub(raw.detail).slice(0, SNAG_DETAIL_CHARS),
    tail: lastLines(scrub(raw.tail)),
  };
  while (snag.tail && frameBytes(snag) > SNAG_MAX_BYTES) snag.tail = lastLines(snag.tail.slice(Math.ceil(snag.tail.length / 8)));
  return snag;
}

export interface TeamSnagsOptions {
  userData: string;
  status(): PhoneRelayStatus;
  send(snag: TeamSnag): Promise<boolean>;
  /** The error-report switch: reports follow it. */
  consent(): boolean;
  teacher(botId: string | undefined): string;
  build: string;
  os: string;
  scrub: ScrubContext;
  now?: () => number;
  warn?: (line: string) => void;
}

/** `recent` maps `event key` to when its last report went. */
const sentStateSchema = z.object({ day: z.string(), count: z.int().nonnegative(), recent: z.record(z.string(), z.number()) });
type SentState = z.infer<typeof sentStateSchema>;

export function readErrorReportConsent(userData: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(userData, "error-report-consent.json"), "utf8"));
    return value?.schema === 1 && value.enabled === true;
  } catch {
    return false;
  }
}

export class TeamSnags {
  private readonly options: TeamSnagsOptions;
  private readonly dir: string;
  private readonly sentFile: string;
  private readonly now: () => number;
  private flushing: Promise<void> | null = null;

  constructor(options: TeamSnagsOptions) {
    this.options = options;
    this.dir = join(options.userData, SNAG_SPOOL_DIR);
    this.sentFile = join(options.userData, SENT_FILE);
    this.now = options.now ?? Date.now;
  }

  /** Opens or deletes the queue to match Phone Access, the relay and the switch, then sends. */
  async sync(): Promise<void> {
    const status = this.options.status();
    try {
      if (status.state === "off" || (status.state === "connected" && !status.snags) || !this.options.consent()) {
        rmSync(this.dir, { recursive: true, force: true });
        return;
      }
      if (!status.snags) return;
      mkdirSync(this.dir, { recursive: true });
      await this.flush();
    } catch (error) {
      this.options.warn?.(`team snags: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Spools a server-side event; dropped while the queue is closed. */
  record(input: Omit<SpooledSnag, "id" | "at">): void {
    try {
      if (!this.options.consent()) return;
      const snag: SpooledSnag = { ...input, ...(input.detail !== undefined ? { detail: input.detail.slice(0, 4000) } : {}), id: randomBytes(16).toString("hex"), at: this.now() };
      writeFileAtomic(join(this.dir, `${snag.at}-${snag.id}.json`), JSON.stringify(snag));
      void this.sync();
    } catch {}
  }

  private flush(): Promise<void> {
    return (this.flushing ??= this.drain().finally(() => { this.flushing = null; }));
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (!this.options.consent()) {
        rmSync(this.dir, { recursive: true, force: true });
        return;
      }
      const next = this.next();
      if (!next) return;
      const snag = buildTeamSnag(next.snag, { ...this.options.scrub, build: this.options.build, os: this.options.os, teacher: this.options.teacher(next.snag.bot) });
      if (!(await this.options.send(snag))) return;
      rmSync(next.file, { force: true });
      const state = this.sent();
      state.count += 1;
      state.recent[`${next.snag.event} ${next.snag.key}`] = next.snag.at;
      this.saveSent(state);
    }
  }

  /** Oldest sendable report; expires, caps and deduplicates the queue on the way. */
  private next(): { file: string; snag: SpooledSnag } | null {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return null;
    }
    const now = this.now();
    const queue: { file: string; snag: SpooledSnag }[] = [];
    for (const name of names) {
      const file = join(this.dir, name);
      let snag: SpooledSnag | null = null;
      try {
        const parsed = spooledSnagSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success) snag = parsed.data;
      } catch {}
      if (!snag || now - snag.at > KEEP_MS) rmSync(file, { force: true });
      else queue.push({ file, snag });
    }
    queue.sort((a, b) => a.snag.at - b.snag.at);
    for (const old of queue.splice(0, Math.max(0, queue.length - QUEUE_CAP))) rmSync(old.file, { force: true });
    const state = this.sent();
    if (state.count >= DAY_CAP) return null;
    const last = new Map(Object.entries(state.recent));
    for (const item of queue) {
      const key = `${item.snag.event} ${item.snag.key}`;
      const before = last.get(key);
      if (before !== undefined && Math.abs(item.snag.at - before) < REPEAT_MS) {
        rmSync(item.file, { force: true });
        continue;
      }
      return item;
    }
    return null;
  }

  private sent(): SentState {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const cutoff = this.now() - KEEP_MS - REPEAT_MS;
    let value: SentState | undefined;
    try {
      value = sentStateSchema.safeParse(JSON.parse(readFileSync(this.sentFile, "utf8"))).data;
    } catch {}
    const recent = Object.fromEntries(Object.entries(value?.recent ?? {}).filter(([, at]) => at > cutoff));
    return { day, count: value?.day === day ? value.count : 0, recent };
  }

  private saveSent(state: SentState): void {
    try {
      writeFileAtomic(this.sentFile, JSON.stringify(state));
    } catch (error) {
      this.options.warn?.(`team snags: could not save the send count: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
