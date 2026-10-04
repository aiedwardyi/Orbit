import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { isMemoryTopicName, MEMORY_SEED } from "./workspace.ts";

// each PC writes only its own snapshot here; builds before it share one copy per file under "memory" and never read this folder
export const MEMORY_SYNC_DIR = "memory-v2";
const FORMAT = "orbit.memory-sync";
const LEDGER_FILE = "memory-sync-v2.json";
const LEGACY_LEDGER_FILE = "memory-sync.json";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const DEVICE = /^[0-9a-f]{12}$/;
const SNAPSHOT_FILE = /^([0-9a-f]{12})\.json$/;
const PARKED_FILE = /^memory\/(.+)\.conflict-[0-9a-f]{8}\.md$/;
const PARKED_NOTE = "<!-- memory sync:";
const MEMORY_FILE = "MEMORY.md";

const isSyncedFile = (file: string) =>
  file === MEMORY_FILE || (file.startsWith("memory/") && isMemoryTopicName(file.slice("memory/".length)));

/** Device id -> the newest edit from that PC a copy includes. */
const versionsSchema = z.record(z.string().regex(DEVICE), z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
type Versions = z.infer<typeof versionsSchema>;
// epoch ms a Date can hold
const time = z.number().int().nonnegative().max(8.64e15);

const snapshotSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(1),
  device: z.string().regex(DEVICE),
  // when the user last messaged this bot on that PC
  talkedAt: time,
  files: z.record(z.string().refine(isSyncedFile), z.object({ vv: versionsSchema, at: time, text: z.string().nullable() })),
});
type Snapshot = z.infer<typeof snapshotSchema>;

const ledgerSchema = z.object({
  device: z.string().regex(DEVICE).optional(),
  host: z.string().optional(),
  clock: z.number().int().nonnegative().optional(),
  talked: z.record(z.string(), time).optional(),
  bots: z.record(
    z.string(),
    z.object({
      published: z.string().optional(),
      // per file: the versions this PC holds, the hash of the text they describe, and when that text was edited
      files: z.record(z.string(), z.object({ vv: versionsSchema, hash: z.string().nullable(), at: time })),
    }),
  ),
});
export type MemorySyncLedger = z.infer<typeof ledgerSchema>;
type FileState = MemorySyncLedger["bots"][string]["files"][string];

/** The older build's ledger: `<botSyncId>/<file>` -> the hash it last agreed on; `~<botSyncId>/<file>` -> the other PC's hash its copy builds on. */
export type LegacyMemoryLedger = Record<string, string>;

export type MemorySyncResult = "pushed" | "pulled" | "conflict" | "current" | "skipped";

export function loadMemorySyncLedger(dataDir: string): MemorySyncLedger {
  try {
    return ledgerSchema.parse(JSON.parse(readFileSync(join(dataDir, LEDGER_FILE), "utf8")));
  } catch {
    return { bots: {} };
  }
}

export function saveMemorySyncLedger(dataDir: string, ledger: MemorySyncLedger): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
}

export function loadLegacyMemoryLedger(dataDir: string): LegacyMemoryLedger {
  try {
    return z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(join(dataDir, LEGACY_LEDGER_FILE), "utf8")));
  } catch {
    return {};
  }
}

export function memorySyncDir(folder: string, botSyncId: string): string {
  if (!ID.test(botSyncId)) throw new Error("Invalid bot sync id");
  return join(folder, MEMORY_SYNC_DIR, botSyncId);
}

/** The user messaged this bot on this PC, so this PC's copy wins a tie. */
export function markTalked(ledger: MemorySyncLedger, botSyncId: string, now = Date.now()): void {
  (ledger.talked ??= {})[botSyncId] = now;
}

const hash = (text: string | null) => (text === null ? null : createHash("sha256").update(text).digest("hex"));

// null = absent; undefined = unreadable (a Drive placeholder), left alone until a later pass
function readText(path: string, file: string): string | null | undefined {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    return file === MEMORY_FILE && (!text.trim() || text === MEMORY_SEED) ? null : text;
  } catch {
    return undefined;
  }
}

function writeText(path: string, text: string | null): void {
  if (text === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, text, { mode: 0o600 });
}

// MEMORY.md plus memory/<topic>.md; undefined when the topic folder exists but cannot be listed
function memoryFiles(root: string): string[] | undefined {
  if (!existsSync(join(root, "memory"))) return [MEMORY_FILE];
  try {
    return [MEMORY_FILE, ...readdirSync(join(root, "memory")).filter(isMemoryTopicName).map((name) => `memory/${name}`)];
  } catch {
    return undefined;
  }
}

// undefined when the folder cannot be listed; a snapshot Drive has not finished delivering is skipped until it parses
function readSnapshots(dir: string): Snapshot[] | undefined {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  return names.sort().flatMap((name) => {
    const device = SNAPSHOT_FILE.exec(name)?.[1];
    try {
      const parsed = device ? snapshotSchema.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8"))) : undefined;
      return parsed?.success && parsed.data.device === device ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

let machineId: string | undefined;

function machine(): string {
  if (machineId) return machineId;
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    user = "";
  }
  machineId = createHash("sha256").update([hostname(), user, homedir()].join("\0")).digest("hex");
  return machineId;
}

// a ledger copied or restored onto another PC must not keep writing as the PC it came from
function deviceId(ledger: MemorySyncLedger, host: string): string {
  if (!ledger.device || ledger.host !== host) {
    ledger.device = randomBytes(6).toString("hex");
    ledger.host = host;
  }
  return ledger.device;
}

function tick(ledger: MemorySyncLedger): number {
  ledger.clock = (ledger.clock ?? 0) + 1;
  return ledger.clock;
}

// a includes every edit b does
const covers = (a: Versions, b: Versions) => Object.entries(b).every(([device, count]) => (a[device] ?? 0) >= count);

function joined(a: Versions, b: Versions): Versions {
  const out = { ...a };
  for (const [device, count] of Object.entries(b)) out[device] = Math.max(out[device] ?? 0, count);
  return out;
}

type Side = { talkedAt: number; at: number; device: string };

// a tie goes to the PC where the user last messaged the bot, then to the later edit; device order makes every PC pick the same one
function wins(a: Side, b: Side): boolean {
  if (a.talkedAt !== b.talkedAt) return a.talkedAt > b.talkedAt;
  if (a.at !== b.at) return a.at > b.at;
  return a.device > b.device;
}

// the older build agreed on this copy by pulling it from another PC, so it holds nothing that PC lacks
function settled(legacy: LegacyMemoryLedger | undefined, botSyncId: string, file: string, localHash: string | null): boolean {
  const base = legacy?.[`${botSyncId}/${file}`];
  return localHash !== null && base === localHash && legacy?.[`~${botSyncId}/${file}`] === base;
}

function editedAt(path: string, now: number): number {
  try {
    return Math.round(statSync(path).mtimeMs);
  } catch {
    return now;
  }
}

// named by its contents, so two PCs setting aside the same copy write the same file
function park(workspace: string, file: string, text: string, at: number) {
  const stem = file === MEMORY_FILE ? "MEMORY" : file.slice("memory/".length, -".md".length);
  const when = at ? `, last edited ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  const body = `${PARKED_NOTE} a copy of ${file} set aside when two PCs changed it at once${when} -->\n${text}`;
  const name = `memory/${stem.slice(0, 170)}.conflict-${hash(body)!.slice(0, 8)}.md`;
  if (!existsSync(join(workspace, name))) writeText(join(workspace, name), body);
  return { name, body };
}

// a set-aside copy whose every line is already in its file has nothing left to merge
function dropMergedCopies(workspace: string, files: Iterable<string>): string[] {
  const dropped: string[] = [];
  for (const file of files) {
    const stem = PARKED_FILE.exec(file)?.[1];
    const parked = stem ? readText(join(workspace, file), file) : null;
    if (!stem || !parked) continue;
    const source = stem === "MEMORY" ? MEMORY_FILE : `memory/${stem}.md`;
    const main = readText(join(workspace, source), source);
    if (!main) continue;
    const lines = new Set(main.split("\n"));
    const body = parked.startsWith(PARKED_NOTE) ? parked.slice(parked.indexOf("\n") + 1) : parked;
    if (!body.split("\n").every((line) => !line.trim() || lines.has(line))) continue;
    rmSync(join(workspace, file), { force: true });
    dropped.push(file);
  }
  return dropped;
}

export type MemorySyncOptions = { now?: number; legacy?: LegacyMemoryLedger; host?: string };

/** Syncs one bot's memory through one snapshot per PC: a copy is replaced only by one that includes it, and a tie sets the losing copy aside. */
export function syncBotMemory(
  folder: string,
  botSyncId: string,
  workspace: string,
  ledger: MemorySyncLedger,
  { now = Date.now(), legacy, host = machine() }: MemorySyncOptions = {},
): Record<string, MemorySyncResult> {
  const dir = memorySyncDir(folder, botSyncId);
  const snapshots = readSnapshots(dir);
  const localFiles = memoryFiles(workspace);
  if (!snapshots || !localFiles) return {};
  const me = deviceId(ledger, host);
  const firstSync = !ledger.bots[botSyncId];
  const bot = (ledger.bots[botSyncId] ??= { files: {} });
  // a wiped or never-created workspace has nothing to publish; forgetting it pulls instead of deleting everywhere
  if (!existsSync(workspace)) bot.files = {};
  // a restored ledger must not hand out counts this PC already published
  for (const entry of snapshots.flatMap((snapshot) => Object.values(snapshot.files))) {
    ledger.clock = Math.max(ledger.clock ?? 0, entry.vv[me] ?? 0);
  }
  const own = snapshots.find((snapshot) => snapshot.device === me);
  const remotes = snapshots.filter((snapshot) => snapshot !== own);
  const talkedAt = ledger.talked?.[botSyncId] ?? 0;
  const files = [...new Set([...localFiles, ...Object.keys(bot.files), ...remotes.flatMap((snapshot) => Object.keys(snapshot.files))])].sort();
  const results: Record<string, MemorySyncResult> = {};
  const texts = new Map<string, string | null>();
  for (const file of files) {
    const path = join(workspace, file);
    let text = readText(path, file);
    if (text === undefined) {
      results[file] = "skipped";
      continue;
    }
    let state: FileState | undefined = bot.files[file];
    let result: MemorySyncResult = "current";
    const localHash = hash(text);
    if (state ? state.hash !== localHash : localHash !== null) {
      const vv = !state && firstSync && settled(legacy, botSyncId, file, localHash) ? {} : { ...state?.vv, [me]: tick(ledger) };
      state = bot.files[file] = { vv, hash: localHash, at: editedAt(path, now) };
      result = "pushed";
    }
    for (const snapshot of remotes) {
      const entry = snapshot.files[file];
      if (!entry) continue;
      const theirs = hash(entry.text);
      if (!state || theirs === state.hash) {
        // nothing here yet, or the same text: take what it knows
        if (!state && theirs !== null) {
          writeText(path, entry.text);
          text = entry.text;
          result = "pulled";
        }
        state = bot.files[file] = state ? { ...state, vv: joined(state.vv, entry.vv) } : { vv: entry.vv, hash: theirs, at: entry.at };
        continue;
      }
      const newer = covers(entry.vv, state.vv);
      const older = covers(state.vv, entry.vv);
      if (older && !newer) continue;
      if (newer && !older) {
        writeText(path, entry.text);
        text = entry.text;
        state = bot.files[file] = { vv: entry.vv, hash: theirs, at: entry.at };
        result = "pulled";
        continue;
      }
      // changed on two PCs at once, or the same versions with different text from a copied ledger
      const keep = wins({ talkedAt, at: state.at, device: me }, { talkedAt: snapshot.talkedAt, at: entry.at, device: snapshot.device });
      const vv = joined(state.vv, entry.vv);
      const lost = keep ? entry.text : text;
      const lostAt = keep ? entry.at : state.at;
      const parked = lost === null ? null : park(workspace, file, lost, lostAt);
      // both PCs park the same copy under the same versions, so either bot deleting it deletes it everywhere
      if (parked && !bot.files[parked.name]) {
        bot.files[parked.name] = { vv, hash: hash(parked.body), at: lostAt };
        texts.set(parked.name, parked.body);
      }
      if (!keep) {
        writeText(path, entry.text);
        text = entry.text;
      }
      state = bot.files[file] = keep ? { ...state, vv } : { vv, hash: theirs, at: entry.at };
      result = "conflict";
      console.warn(
        `memory sync: ${botSyncId}/${file} changed on two PCs; kept ${keep ? "this" : "the other"} PC's copy${parked ? `, set the other aside as ${parked.name}` : ""}`,
      );
    }
    results[file] = result;
    texts.set(file, text);
  }
  for (const file of dropMergedCopies(workspace, texts.keys())) {
    const state = bot.files[file];
    texts.set(file, null);
    if (state?.hash) bot.files[file] = { vv: { ...state.vv, [me]: tick(ledger) }, hash: null, at: now };
    results[file] = "pushed";
  }
  const published: Snapshot["files"] = {};
  for (const [file, state] of Object.entries(bot.files)) {
    const text = texts.get(file);
    // unreadable this pass: keep what this PC last published rather than claim a delete
    const entry = text === undefined ? own?.files[file] : { vv: state.vv, at: state.at, text };
    if (entry) published[file] = entry;
  }
  const body = `${JSON.stringify({ format: FORMAT, version: 1, device: me, talkedAt, files: published })}\n`;
  const path = join(dir, `${me}.json`);
  const digest = hash(body)!;
  if (bot.published !== digest || !existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(path, body, { mode: 0o600 });
    bot.published = digest;
  }
  return results;
}
