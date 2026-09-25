import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { isMemoryTopicName, MEMORY_SEED } from "./workspace.ts";

export const MEMORY_SYNC_DIR = "memory";
const LEDGER_FILE = "memory-sync.json";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const MEMORY_FILE = "MEMORY.md";

/** `<botSyncId>/<file>` -> hash of the copy this PC and the folder last agreed on. */
export type MemorySyncLedger = Record<string, string>;

export type MemorySyncResult = "pushed" | "pulled" | "conflict" | "current" | "skipped";

export function loadMemorySyncLedger(dataDir: string): MemorySyncLedger {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, LEDGER_FILE), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, hash]) => typeof hash === "string"));
  } catch {
    return {};
  }
}

export function saveMemorySyncLedger(dataDir: string, ledger: MemorySyncLedger): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
}

export function memorySyncDir(folder: string, botSyncId: string): string {
  if (!ID.test(botSyncId)) throw new Error("Invalid bot sync id");
  return join(folder, MEMORY_SYNC_DIR, botSyncId);
}

const hash = (text: string | null) => (text === null ? null : createHash("sha256").update(text).digest("hex"));

// null = absent; undefined = unreadable (a Drive placeholder), left alone until a later pass
function readText(path: string, file: string): string | null | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return file === MEMORY_FILE && (!text.trim() || text === MEMORY_SEED) ? null : text;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : undefined;
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
  try {
    return [MEMORY_FILE, ...readdirSync(join(root, "memory")).filter(isMemoryTopicName).map((name) => `memory/${name}`)];
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? [MEMORY_FILE] : undefined;
  }
}

function conflictName(file: string, remoteHash: string): string {
  const stem = file === MEMORY_FILE ? "MEMORY" : file.slice("memory/".length, -".md".length);
  return `memory/${stem.slice(0, 170)}.conflict-${remoteHash.slice(0, 8)}.md`;
}

/** Hash-based three-way sync of one bot's memory files; a side whose folder is gone re-seeds from the other, never deletes it. */
export function syncBotMemory(
  folder: string,
  botSyncId: string,
  workspace: string,
  ledger: MemorySyncLedger,
): Record<string, MemorySyncResult> {
  const remoteRoot = memorySyncDir(folder, botSyncId);
  const prefix = `${botSyncId}/`;
  if (!existsSync(remoteRoot) || !existsSync(workspace)) {
    for (const key of Object.keys(ledger)) if (key.startsWith(prefix)) delete ledger[key];
  }
  const localFiles = memoryFiles(workspace);
  const remoteFiles = memoryFiles(remoteRoot);
  if (!localFiles || !remoteFiles) return {};
  const files = new Set([
    ...localFiles,
    ...remoteFiles,
    ...Object.keys(ledger).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
  ]);
  const results: Record<string, MemorySyncResult> = {};
  const agree = (file: string, text: string | null) => {
    const value = hash(text);
    if (value === null) delete ledger[prefix + file];
    else ledger[prefix + file] = value;
  };
  for (const file of files) {
    const local = readText(join(workspace, file), file);
    const remote = readText(join(remoteRoot, file), file);
    if (local === undefined || remote === undefined) {
      results[file] = "skipped";
      continue;
    }
    const base = ledger[prefix + file] ?? null;
    const localHash = hash(local);
    const remoteHash = hash(remote);
    if (localHash === remoteHash) {
      results[file] = "current";
    } else if (localHash === base || (local === null && remoteHash !== base)) {
      writeText(join(workspace, file), remote);
      results[file] = "pulled";
    } else if (remoteHash === base || remote === null) {
      writeText(join(remoteRoot, file), local);
      results[file] = "pushed";
    } else {
      // changed on both PCs: local stays the file, the other copy becomes a topic file on both sides
      const parked = conflictName(file, remoteHash!);
      writeText(join(workspace, parked), remote);
      writeText(join(remoteRoot, parked), remote);
      agree(parked, remote);
      writeText(join(remoteRoot, file), local);
      console.warn(`memory sync: ${botSyncId}/${file} changed on two PCs; kept the other copy as ${parked}`);
      results[file] = "conflict";
    }
    agree(file, results[file] === "pulled" ? remote : local);
  }
  return results;
}
