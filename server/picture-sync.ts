// Chat pictures stay out of the thread JSON. Each PC copies a local attachment
// into <sync folder>/pictures/<name> once, and pulls that file back only when
// /api/attachments misses. The ledger is local, so a PC deletes only what it wrote.
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { PROFILE_SYNC_ASSETS_DIR, validateSyncFolder } from "./profile-sync.ts";

export const PICTURES_DIR = "pictures";
export const PICTURE_MAX_BYTES = 10 * 1024 * 1024;
export const PICTURE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const LEDGER_FILE = "picture-sync.json";
const PICTURE_NAME = /^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/;
const ATTACHED_IMAGE = /<attached-image\s+path="([^"]*)"\s*\/?>/g;

export interface PictureMessage {
  image?: string;
  text?: string;
  at: number;
}

function syncRoot(folder: string): string | null {
  try {
    return validateSyncFolder(folder);
  } catch {
    return null;
  }
}

function ledgerPath(dataDir: string): string {
  return join(dataDir, LEDGER_FILE);
}

const ledgerFileSchema = z.record(z.string(), z.unknown());
const nestedLedgerSchema = z.object({
  pictures: z.record(z.string(), z.unknown()),
  scanned: z.array(z.string()).optional(),
  pending: z.record(z.string(), z.string()).optional(),
}).strict();
const writtenAtSchema = z.number().int().positive().safe();
const THREAD_KEY = /^[A-Za-z0-9_-]{1,96}$/;

interface PictureLedger {
  pictures: Map<string, number>;
  scanned: Set<string>;
  pending: Map<string, string>;
}

function emptyLedger(): PictureLedger {
  return { pictures: new Map(), scanned: new Set(), pending: new Map() };
}

function loadLedger(dataDir: string): PictureLedger {
  const ledger = emptyLedger();
  try {
    const raw = ledgerFileSchema.parse(JSON.parse(readFileSync(ledgerPath(dataDir), "utf8")));
    const nested = nestedLedgerSchema.safeParse(raw);
    const pictureMap = nested.success ? nested.data.pictures : raw;
    for (const [name, at] of Object.entries(pictureMap)) {
      const writtenAt = writtenAtSchema.safeParse(at);
      if (PICTURE_NAME.test(name) && writtenAt.success) ledger.pictures.set(name, writtenAt.data);
    }
    if (!nested.success) return ledger;
    for (const id of nested.data.scanned ?? []) {
      if (THREAD_KEY.test(id)) ledger.scanned.add(id);
    }
    for (const [name, source] of Object.entries(nested.data.pending ?? {})) {
      if (PICTURE_NAME.test(name) && source) ledger.pending.set(name, source);
    }
  } catch {
    // missing or unreadable ledger
  }
  return ledger;
}

function saveLedger(dataDir: string, ledger: PictureLedger): void {
  mkdirSync(dataDir, { recursive: true });
  const body = {
    pictures: Object.fromEntries(ledger.pictures),
    scanned: [...ledger.scanned],
    pending: Object.fromEntries(ledger.pending),
  };
  writeFileAtomic(ledgerPath(dataDir), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

function unescapeAttr(raw: string): string {
  return raw.replaceAll("&quot;", "\"").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function fileInDir(root: string, candidate: string, name: string): { path: string; size: number } | null {
  if (!PICTURE_NAME.test(name)) return null;
  try {
    const real = realpathSync(candidate);
    const stat = statSync(real);
    if (!stat.isFile() || relative(root, real) !== name) return null;
    return { path: real, size: stat.size };
  } catch {
    return null;
  }
}

function picturesDir(root: string): string | null {
  const dir = join(root, PICTURES_DIR);
  mkdirSync(dir, { recursive: true });
  try {
    const real = realpathSync(dir);
    const rel = relative(root, real);
    // A link named pictures must not land in the profile assets directory.
    if (rel === PROFILE_SYNC_ASSETS_DIR || rel !== PICTURES_DIR) return null;
    return real;
  } catch {
    return null;
  }
}

// wx so a file another PC already published is left alone, ledger included.
function copyOnce(source: string, dest: string): boolean {
  let fd: number;
  try {
    fd = openSync(dest, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, readFileSync(source));
    closeSync(fd);
    return true;
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(dest); } catch { /* partial copy */ }
    throw error;
  }
}

function localPictures(messages: readonly PictureMessage[], attachmentsRoot: string): Map<string, string> {
  const found = new Map<string, string>();
  const consider = (name: string, candidate: string) => {
    if (found.has(name)) return;
    const file = fileInDir(attachmentsRoot, candidate, name);
    if (!file || file.size === 0 || file.size > PICTURE_MAX_BYTES) return;
    found.set(name, file.path);
  };
  for (const message of messages) {
    if (message.image) consider(message.image, join(attachmentsRoot, message.image));
    const text = message.text ?? "";
    for (const match of text.matchAll(ATTACHED_IMAGE)) {
      const path = unescapeAttr(match[1] ?? "");
      const name = path.split(/[\\/]/).pop() ?? "";
      if (path) consider(name, path);
    }
  }
  return found;
}

function freshMessages(messages: readonly PictureMessage[], now: number): PictureMessage[] {
  return messages.filter((message) => now - message.at < PICTURE_MAX_AGE_MS);
}

function tryCopy(root: string, name: string, source: string): "copied" | "kept" | "failed" {
  try {
    const dir = picturesDir(root);
    if (!dir) return "failed";
    const dest = join(dir, name);
    if (relative(dir, dest) !== name) return "failed";
    return copyOnce(source, dest) ? "copied" : "kept";
  } catch (error) {
    console.warn("picture sync: skipped", name, error);
    return "failed";
  }
}

/** Deletes this PC's pictures once they are 30 days old. Other PCs' files are not in the ledger. */
export function pruneSyncedPictures(folder: string, dataDir: string, now = Date.now()): void {
  const ledger = loadLedger(dataDir);
  if (!ledger.pictures.size) return;
  const root = syncRoot(folder);
  if (!root) return;
  let pictures: string | null = null;
  try {
    const real = realpathSync(join(root, PICTURES_DIR));
    const rel = relative(root, real);
    if (rel === PROFILE_SYNC_ASSETS_DIR || rel !== PICTURES_DIR) return;
    pictures = real;
  } catch {
    pictures = null;
  }
  let changed = false;
  for (const [name, at] of ledger.pictures) {
    if (now - at < PICTURE_MAX_AGE_MS) continue;
    if (pictures) {
      const dest = join(pictures, name);
      if (relative(pictures, dest) !== name) continue;
      try { unlinkSync(dest); } catch { /* already gone */ }
    }
    ledger.pictures.delete(name);
    changed = true;
  }
  if (changed) saveLedger(dataDir, ledger);
}

/** Copies local attachment pictures referenced by a synced chat. The thread file is not touched. */
export function publishThreadPictures(input: {
  folder: string;
  dataDir: string;
  messages: readonly PictureMessage[];
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  pruneSyncedPictures(input.folder, input.dataDir, now);
  const root = syncRoot(input.folder);
  if (!root) return;
  let attachmentsRoot: string;
  try {
    attachmentsRoot = realpathSync(join(input.dataDir, "attachments"));
  } catch {
    return;
  }
  const found = localPictures(freshMessages(input.messages, now), attachmentsRoot);
  if (!found.size) return;
  const ledger = loadLedger(input.dataDir);
  let changed = false;
  for (const [name, source] of found) {
    const result = tryCopy(root, name, source);
    if (result === "kept") continue;
    if (result === "copied") {
      ledger.pictures.set(name, now);
      ledger.pending.delete(name);
    } else ledger.pending.set(name, source);
    changed = true;
  }
  if (changed) saveLedger(input.dataDir, ledger);
}

function retryPending(root: string, attachmentsRoot: string, ledger: PictureLedger, now: number): boolean {
  let changed = false;
  for (const [name, source] of Array.from(ledger.pending)) {
    const file = fileInDir(attachmentsRoot, source, name);
    if (!file) {
      ledger.pending.delete(name);
      changed = true;
      continue;
    }
    const result = tryCopy(root, name, file.path);
    if (result === "failed") continue;
    ledger.pending.delete(name);
    if (result === "copied") ledger.pictures.set(name, now);
    changed = true;
  }
  return changed;
}

/** Publishes pictures a clean thread never copied, then retries names that failed. Each thread is scanned once. */
export function publishUnsyncedPictures(input: {
  folder: string;
  dataDir: string;
  threadIds: readonly string[];
  messagesFor(threadId: string): readonly PictureMessage[];
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const root = syncRoot(input.folder);
  if (!root) return;
  let attachmentsRoot: string;
  try {
    attachmentsRoot = realpathSync(join(input.dataDir, "attachments"));
  } catch {
    return;
  }
  const ledger = loadLedger(input.dataDir);
  let changed = retryPending(root, attachmentsRoot, ledger, now);
  for (const threadId of input.threadIds) {
    if (!THREAD_KEY.test(threadId) || ledger.scanned.has(threadId)) continue;
    let messages: readonly PictureMessage[];
    try {
      messages = input.messagesFor(threadId);
    } catch (error) {
      console.warn("picture sync: skipped thread", threadId, error);
      continue;
    }
    const found = localPictures(freshMessages(messages, now), attachmentsRoot);
    for (const [name, source] of found) {
      if (ledger.pictures.has(name)) continue;
      const result = tryCopy(root, name, source);
      if (result === "copied") {
        ledger.pictures.set(name, now);
        ledger.pending.delete(name);
        changed = true;
      } else if (result === "failed") {
        ledger.pending.set(name, source);
        changed = true;
      }
    }
    ledger.scanned.add(threadId);
    changed = true;
  }
  if (changed) saveLedger(input.dataDir, ledger);
}

/** Copies one pictures/<name> into the local attachments folder. Looks up that name only. */
export function pullSyncedPicture(folder: string, attachmentsDir: string, name: string): boolean {
  if (!PICTURE_NAME.test(name)) return false;
  const root = syncRoot(folder);
  if (!root) return false;
  let source: string;
  let size: number;
  try {
    const pictures = realpathSync(join(root, PICTURES_DIR));
    if (relative(root, pictures) !== PICTURES_DIR) return false;
    source = realpathSync(join(pictures, name));
    if (relative(pictures, source) !== name) return false;
    const stat = statSync(source);
    if (!stat.isFile()) return false;
    size = stat.size;
  } catch {
    return false;
  }
  if (size === 0 || size > PICTURE_MAX_BYTES) return false;
  mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 });
  let attachmentsRoot: string;
  try {
    attachmentsRoot = realpathSync(attachmentsDir);
  } catch {
    return false;
  }
  const dest = join(attachmentsRoot, name);
  if (relative(attachmentsRoot, dest) !== name) return false;
  try {
    if (statSync(dest).isFile()) return true;
  } catch { /* local miss */ }
  try {
    return copyOnce(source, dest);
  } catch {
    return false;
  }
}
