import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { Message } from "./store.ts";

export const THREAD_SYNC_FORMAT = "orbit.thread-sync" as const;
export const THREAD_SYNC_VERSION = 1 as const;
export const THREAD_SYNC_DIR = "threads";
const LEDGER_FILE = "thread-sync.json";

const ID = z.string().trim().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
// No dots, so `<threadId>.conflict-...json` can never parse as a thread file.
const THREAD_ID = z.string().min(1).max(96).regex(/^[A-Za-z0-9_-]+$/);
const THREAD_FILE = /^([A-Za-z0-9_-]{1,96})\.json$/;

const messageSchema = z.object({
  id: z.string().min(1).max(200),
  role: z.enum(["bot", "user"]),
  kind: z.string().min(1).max(40),
  at: z.number(),
}).passthrough();

const fileSchema = z.object({
  format: z.literal(THREAD_SYNC_FORMAT),
  version: z.literal(THREAD_SYNC_VERSION),
  revision: z.number().int().positive(),
  writerDeviceId: ID,
  updatedAt: z.number().int().positive(),
  task: z.object({
    threadId: THREAD_ID,
    title: z.string().max(200),
    createdAt: z.number().int().nonnegative(),
  }).strict(),
  activeLeafId: z.string().max(200).nullable(),
  messages: z.array(messageSchema),
}).strict();

const ledgerEntrySchema = z.object({
  syncedRevision: z.number().int().nonnegative(),
  syncedWriter: ID.optional(),
  dirty: z.boolean(),
}).strict();

export interface SyncedThreadFile {
  format: typeof THREAD_SYNC_FORMAT;
  version: typeof THREAD_SYNC_VERSION;
  revision: number;
  writerDeviceId: string;
  updatedAt: number;
  task: { threadId: string; title: string; createdAt: number };
  activeLeafId: string | null;
  messages: Message[];
}

export interface ThreadSyncEntry {
  syncedRevision: number;
  /** Writer of the copy this PC last wrote or imported; equal revisions from another writer diverged. */
  syncedWriter?: string;
  dirty: boolean;
}

export type ThreadSyncLedger = Record<string, ThreadSyncEntry>;

export interface LocalThread {
  title: string;
  createdAt: number;
  messages: Message[];
  activeLeafId: string | null;
}

export interface ThreadSyncHost {
  folder: string;
  deviceId: string;
  ledger: ThreadSyncLedger;
  saveLedger(): void;
  local(threadId: string): LocalThread | null;
  running(threadId: string): boolean;
  adopt(botId: string, file: SyncedThreadFile): void;
  conflicted(threadId: string): void;
  now?(): number;
}

export type ThreadSyncResult = "written" | "imported" | "current" | "conflict" | "running" | "skipped";

export const CONFLICT_NOTICE = "This chat also changed on another PC. The other PC's copy was saved as a conflict file.";

export function loadThreadSyncLedger(dataDir: string): ThreadSyncLedger {
  const ledger: ThreadSyncLedger = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, LEDGER_FILE), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ledger;
    for (const [threadId, value] of Object.entries(raw)) {
      const entry = ledgerEntrySchema.safeParse(value);
      if (THREAD_ID.safeParse(threadId).success && entry.success) ledger[threadId] = entry.data;
    }
  } catch {}
  return ledger;
}

export function saveThreadSyncLedger(dataDir: string, ledger: ThreadSyncLedger): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
}

/** Only threads already synced need the flag; a never-synced thread counts as dirty once it has messages. */
export function markThreadDirty(ledger: ThreadSyncLedger, threadId: string): boolean {
  const entry = ledger[threadId];
  if (!entry || entry.dirty) return false;
  entry.dirty = true;
  return true;
}

export function chatSyncBotId(
  settings: { syncChats: boolean; folder: string | null; botMap: Record<string, string> },
  botId: string,
): string | null {
  if (!settings.syncChats || !settings.folder) return null;
  return settings.botMap[botId] ?? null;
}

export function threadSyncDir(folder: string, botSyncId: string): string {
  return join(folder, THREAD_SYNC_DIR, ID.parse(botSyncId));
}

const readCache = new Map<string, { mtimeMs: number; size: number; file: SyncedThreadFile | null }>();

/** Cached by mtime and size unless `fresh`; callers must not mutate the result. */
export function readSyncedThread(path: string, fresh = false): SyncedThreadFile | null {
  try {
    const { mtimeMs, size } = statSync(path);
    const cached = readCache.get(path);
    if (!fresh && cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.file;
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    const file = parsed.success ? parsed.data as SyncedThreadFile : null;
    readCache.set(path, { mtimeMs, size, file });
    return file;
  } catch {
    readCache.delete(path);
    return null;
  }
}

/** Newer, or the same revision from a writer this PC never synced with. */
function isForeign(entry: ThreadSyncEntry | undefined, remote: SyncedThreadFile): boolean {
  const synced = entry?.syncedRevision ?? 0;
  if (remote.revision !== synced) return remote.revision > synced;
  return entry?.syncedWriter !== undefined && remote.writerDeviceId !== entry.syncedWriter;
}

/** A turn is live or starting on THIS thread; a bot busy elsewhere must not block its other threads. */
export function threadTurnRunning(
  threadId: string,
  turn: { live: boolean; startingThreadId: string | undefined; busy: boolean; activeThreadId: string | undefined },
): boolean {
  return turn.live || turn.startingThreadId === threadId || (turn.busy && turn.activeThreadId === threadId);
}

function isDirty(host: ThreadSyncHost, threadId: string, local: LocalThread | null): boolean {
  const entry = host.ledger[threadId];
  if (!local) return false;
  return entry ? entry.dirty : local.messages.length > 0;
}

// screen pixels are attachments in all but name; message JSON only
function persisted(message: Message): Message {
  if (message.kind !== "screen" || !message.png) return message;
  const { png: _png, mime: _mime, ...rest } = message;
  return rest;
}

/** Key order differs between parsed files and in-memory messages. */
function canonical(message: Message): string {
  return JSON.stringify(message, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value);
}

/** Every local message, content included, is in the remote or a parked conflict copy; a higher revision alone does not prove ancestry. */
function preserved(dir: string, threadId: string, local: LocalThread, remote: SyncedThreadFile): boolean {
  const kept = new Set(remote.messages.map(canonical));
  let missing = local.messages.map((message) => canonical(persisted(message))).filter((key) => !kept.has(key));
  for (const name of missing.length ? readdirSync(dir) : []) {
    if (!name.startsWith(`${threadId}.conflict-`)) continue;
    const parked = new Set(readSyncedThread(join(dir, name), true)?.messages.map(canonical));
    missing = missing.filter((key) => !parked.has(key));
    if (!missing.length) break;
  }
  return !missing.length;
}

function toFile(host: ThreadSyncHost, threadId: string, local: LocalThread, revision: number): SyncedThreadFile {
  return {
    format: THREAD_SYNC_FORMAT,
    version: THREAD_SYNC_VERSION,
    revision,
    writerDeviceId: host.deviceId,
    updatedAt: host.now?.() ?? Date.now(),
    task: { threadId, title: local.title, createdAt: local.createdAt },
    activeLeafId: local.activeLeafId,
    messages: local.messages.map(persisted),
  };
}

function writeThreadFile(path: string, file: SyncedThreadFile): void {
  writeFileAtomic(path, `${JSON.stringify(file)}\n`, { mode: 0o600 });
}

/** Parks the remote copy beside the thread file, then rebases on it so the next upload publishes ours. */
function keepConflict(host: ThreadSyncHost, dir: string, threadId: string, remote: SyncedThreadFile): ThreadSyncResult {
  const name = `${threadId}.conflict-${remote.writerDeviceId.replace(/[^A-Za-z0-9_-]/g, "_")}-${host.now?.() ?? Date.now()}.json`;
  writeThreadFile(join(dir, name), remote);
  host.conflicted(threadId);
  host.ledger[threadId] = { syncedRevision: remote.revision, syncedWriter: remote.writerDeviceId, dirty: true };
  host.saveLedger();
  return "conflict";
}

export function uploadThread(host: ThreadSyncHost, botSyncId: string, threadId: string): ThreadSyncResult {
  if (!THREAD_ID.safeParse(threadId).success) return "skipped";
  if (host.running(threadId)) return "running";
  const local = host.local(threadId);
  if (!local || local.messages.length === 0) return "skipped";
  if (!isDirty(host, threadId, local)) return "current";
  const dir = threadSyncDir(host.folder, botSyncId);
  const path = join(dir, `${threadId}.json`);
  const exists = existsSync(path);
  const remote = exists ? readSyncedThread(path, true) : null;
  // a half-synced Drive file reads as garbage; retry later rather than clobber it
  if (exists && !remote) return "skipped";
  if (remote && isForeign(host.ledger[threadId], remote)) return keepConflict(host, dir, threadId, remote);
  const revision = Math.max(host.ledger[threadId]?.syncedRevision ?? 0, remote?.revision ?? 0) + 1;
  mkdirSync(dir, { recursive: true });
  writeThreadFile(path, toFile(host, threadId, local, revision));
  host.ledger[threadId] = { syncedRevision: revision, syncedWriter: host.deviceId, dirty: false };
  host.saveLedger();
  return "written";
}

export function pullThread(host: ThreadSyncHost, botId: string, botSyncId: string, threadId: string): ThreadSyncResult {
  if (!THREAD_ID.safeParse(threadId).success) return "skipped";
  const dir = threadSyncDir(host.folder, botSyncId);
  const path = join(dir, `${threadId}.json`);
  const cached = readSyncedThread(path);
  if (!cached || cached.task.threadId !== threadId) return "skipped";
  if (!isForeign(host.ledger[threadId], cached)) return "current";
  if (host.running(threadId)) return "running";
  // Drive can swap in another revision at the same size and mtime; act only on bytes read now
  const remote = readSyncedThread(path, true);
  if (!remote || remote.task.threadId !== threadId) return "skipped";
  const entry = host.ledger[threadId];
  if (!isForeign(entry, remote)) return "current";
  const local = host.local(threadId);
  // an equal revision here is a sibling of our own copy, so even a clean thread holds unsynced messages
  const diverged = remote.revision === entry?.syncedRevision;
  if (local && (diverged || isDirty(host, threadId, local) || !preserved(dir, threadId, local, remote))) {
    return keepConflict(host, dir, threadId, remote);
  }
  host.adopt(botId, structuredClone(remote));
  host.ledger[threadId] = { syncedRevision: remote.revision, syncedWriter: remote.writerDeviceId, dirty: false };
  host.saveLedger();
  return "imported";
}

export function pullBotThreads(host: ThreadSyncHost, botId: string, botSyncId: string): Record<string, ThreadSyncResult> {
  let names: string[];
  try {
    names = readdirSync(threadSyncDir(host.folder, botSyncId));
  } catch {
    return {};
  }
  const results: Record<string, ThreadSyncResult> = {};
  for (const name of names.sort()) {
    const threadId = THREAD_FILE.exec(name)?.[1];
    if (threadId) results[threadId] = pullThread(host, botId, botSyncId, threadId);
  }
  return results;
}
