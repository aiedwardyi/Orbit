import { resolve } from "node:path";

import type { DriveFile } from "./drive-client.ts";
import { drivePathRule } from "./drive-mirror.ts";
import type { DriveOwnIds } from "./drive-own-ids.ts";
import { withMessageTransaction } from "./message-db.ts";
import type { SyncApplyResult, SyncScope } from "./thread-sync-v2.ts";

const HOLD_MS = 10_000;
const folderKey = (folder: string) => process.platform === "win32" ? resolve(folder).toLowerCase() : resolve(folder);
const threadFor = (path: string) => /^threads-v2(?: \([1-9]\d*\))?\/[^/]+\/([^/]+)\/[^/]+\/head\.json$/.exec(path)?.[1];

interface WaitingSend {
  messageId: string;
  threadId: string;
  syncUntil?: number;
}

const pending = new Map<string, Map<string, string>>();
const applied = new Map<string, Map<string, string>>();
const google = new Map<string, boolean>();
const delivered = new Map<string, { folder: string; behind: boolean }>();
const peers = new Map<string, Map<string, { feed?: string; pull?: string }>>();
const released = new Set<string>();
const expired = new Set<string>();
let waiting: WaitingSend[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let drain = () => {};
let enabled = () => true;
let waking = false;

function behind(threadId: string): boolean | undefined {
  if (!enabled()) return false;
  for (const heads of pending.values()) {
    if ([...heads.keys()].some((path) => threadFor(path) === threadId)) return true;
  }
  const local = delivered.get(threadId);
  return local ? google.get(local.folder) === false ? false : local.behind : undefined;
}

function notePeer(threadId: string, path: string, source: "feed" | "pull", hash: string): void {
  expire();
  const heads = peers.get(threadId) ?? new Map<string, { feed?: string; pull?: string }>();
  const state = heads.get(path) ?? {};
  if (state.feed !== hash && state.pull !== hash) released.delete(threadId);
  state[source] = hash;
  heads.set(path, state);
  peers.set(threadId, heads);
}

function release(threadId: string): void {
  if (behind(threadId) === true) released.add(threadId);
}

function expire(): void {
  for (const item of waiting) {
    if (item.syncUntil! > Date.now() || expired.has(item.messageId)) continue;
    expired.add(item.messageId);
    release(item.threadId);
  }
}

function schedule(): void {
  clearTimeout(timer);
  timer = undefined;
  const next = Math.min(...waiting.flatMap((item) => item.syncUntil! > Date.now() ? [item.syncUntil!] : []));
  if (Number.isFinite(next)) {
    timer = setTimeout(wake, Math.max(0, next - Date.now()));
    timer.unref?.();
  }
}

function wake(): void {
  expire();
  schedule();
  if (!waiting.length || waking) return;
  waking = true;
  queueMicrotask(() => {
    waking = false;
    drain();
  });
}

export const syncHold = {
  initialize(onDrain: () => void, isEnabled = () => true): void {
    drain = onDrain;
    enabled = isEnabled;
  },
  watch(entries: Array<{ threadId: string; items: Array<{ messageId: string; syncUntil?: number }> }>): void {
    waiting = entries.flatMap((entry) => entry.items.filter((item) => item.syncUntil !== undefined)
      .map((item) => ({ messageId: item.messageId, threadId: entry.threadId, syncUntil: item.syncUntil })));
    schedule();
  },
  google(folder: string): void {
    const key = folderKey(folder);
    google.set(key, false);
    pending.delete(key);
    wake();
  },
  feed(folder: string, files: ReadonlyMap<string, readonly DriveFile[]> | null, ids: DriveOwnIds): void {
    const key = folderKey(folder);
    if (!files) return this.google(folder);
    google.set(key, true);
    const heads = pending.get(key) ?? new Map<string, string>();
    let cleared = false;
    for (const [path, copies] of files) {
      const threadId = threadFor(path);
      if (!threadId || drivePathRule(path, ids) !== "peer") continue;
      const file = [...copies].sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime) || Date.parse(b.createdTime) - Date.parse(a.createdTime) || a.id.localeCompare(b.id))[0];
      if (!file?.md5Checksum) continue;
      notePeer(threadId, `${key}/${path}`, "feed", file.md5Checksum);
      if (applied.get(key)?.get(path) === file.md5Checksum) cleared = heads.delete(path) || cleared;
      else heads.set(path, file.md5Checksum);
    }
    pending.set(key, heads);
    if (cleared) wake();
  },
  pulled(folder: string, scope: SyncScope, heads: SyncApplyResult["heads"] = []): void {
    const key = folderKey(folder);
    const hashes = applied.get(key) ?? new Map<string, string>();
    const seen = withMessageTransaction((db) => new Map(db.prepare("SELECT writer, seq FROM sync_v2_progress WHERE thread = ?")
      .all(scope.threadId).map((row) => [String(row.writer), Number(row.seq)])));
    let ahead = false;
    for (const head of heads) {
      notePeer(scope.threadId, `${key}/${head.path}`, "pull", head.hash);
      const unmet = head.lastSeq > (seen.get(head.writer) ?? 0)
        || Object.entries(head.seen).some(([peer, seq]) => seq > (seen.get(peer) ?? 0));
      if (unmet) { ahead = true; continue; }
      hashes.set(head.path, head.hash);
      if (pending.get(key)?.get(head.path) === head.hash) pending.get(key)!.delete(head.path);
    }
    applied.set(key, hashes);
    delivered.set(scope.threadId, { folder: key, behind: ahead });
    wake();
  },
  until(threadId: string): number | undefined {
    expire();
    return !released.has(threadId) && behind(threadId) === true ? Date.now() + HOLD_MS : undefined;
  },
  release,
  waiting(threadId: string, until?: number): boolean {
    expire();
    return !released.has(threadId) && until !== undefined && until > Date.now() && behind(threadId) !== false;
  },
  reset(): void {
    clearTimeout(timer);
    waiting = [];
    pending.clear();
    applied.clear();
    delivered.clear();
    google.clear();
    peers.clear();
    released.clear();
    expired.clear();
    drain = () => {};
    enabled = () => true;
  },
};
