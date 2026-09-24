import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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

const ledgerSchema = z.record(THREAD_ID, z.object({
  syncedRevision: z.number().int().nonnegative(),
  dirty: z.boolean(),
  conflictRevision: z.number().int().positive().optional(),
  conflictFile: z.string().max(260).optional(),
}).strict());

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
  dirty: boolean;
  conflictRevision?: number;
  conflictFile?: string;
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

export const CONFLICT_NOTICE = "This chat also changed on another PC. Your copy was saved as a conflict file.";

export function loadThreadSyncLedger(dataDir: string): ThreadSyncLedger {
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(join(dataDir, LEDGER_FILE), "utf8")));
    if (parsed.success) return parsed.data;
  } catch {}
  return {};
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

export function readSyncedThread(path: string): SyncedThreadFile | null {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data as SyncedThreadFile : null;
  } catch {
    return null;
  }
}

function isDirty(host: ThreadSyncHost, threadId: string, local: LocalThread | null): boolean {
  const entry = host.ledger[threadId];
  if (!local) return false;
  return entry ? entry.dirty : local.messages.length > 0;
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
    // screen pixels are attachments in all but name; message JSON only
    messages: local.messages.map((message) => {
      if (message.kind !== "screen" || !message.png) return message;
      const { png: _png, mime: _mime, ...rest } = message;
      return rest;
    }),
  };
}

function writeThreadFile(path: string, file: SyncedThreadFile): void {
  writeFileAtomic(path, `${JSON.stringify(file)}\n`, { mode: 0o600 });
}

function keepConflict(
  host: ThreadSyncHost,
  dir: string,
  threadId: string,
  local: LocalThread,
  remote: SyncedThreadFile,
): ThreadSyncResult {
  const entry = host.ledger[threadId] ?? { syncedRevision: 0, dirty: true };
  const repeat = entry.conflictRevision === remote.revision && Boolean(entry.conflictFile);
  const name = repeat
    ? entry.conflictFile!
    : `${threadId}.conflict-${host.deviceId.replace(/[^A-Za-z0-9_-]/g, "_")}-${host.now?.() ?? Date.now()}.json`;
  writeThreadFile(join(dir, name), toFile(host, threadId, local, entry.syncedRevision + 1));
  host.ledger[threadId] = { ...entry, dirty: true, conflictRevision: remote.revision, conflictFile: name };
  host.saveLedger();
  if (!repeat) host.conflicted(threadId);
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
  const remote = exists ? readSyncedThread(path) : null;
  // a half-synced Drive file reads as garbage; retry later rather than clobber it
  if (exists && !remote) return "skipped";
  const synced = host.ledger[threadId]?.syncedRevision ?? 0;
  if (remote && remote.revision > synced) return keepConflict(host, dir, threadId, local, remote);
  const revision = Math.max(synced, remote?.revision ?? 0) + 1;
  mkdirSync(dir, { recursive: true });
  writeThreadFile(path, toFile(host, threadId, local, revision));
  host.ledger[threadId] = { syncedRevision: revision, dirty: false };
  host.saveLedger();
  return "written";
}

export function pullThread(host: ThreadSyncHost, botId: string, botSyncId: string, threadId: string): ThreadSyncResult {
  if (!THREAD_ID.safeParse(threadId).success) return "skipped";
  const dir = threadSyncDir(host.folder, botSyncId);
  const remote = readSyncedThread(join(dir, `${threadId}.json`));
  if (!remote || remote.task.threadId !== threadId) return "skipped";
  if (remote.revision <= (host.ledger[threadId]?.syncedRevision ?? 0)) return "current";
  if (host.running(threadId)) return "running";
  const local = host.local(threadId);
  if (isDirty(host, threadId, local)) return keepConflict(host, dir, threadId, local!, remote);
  host.adopt(botId, remote);
  host.ledger[threadId] = { syncedRevision: remote.revision, dirty: false };
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
