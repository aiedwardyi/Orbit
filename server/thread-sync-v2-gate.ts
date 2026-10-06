import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { scanDevices } from "./device-sync.ts";

const journalSchema = z.object({ version: z.literal(2), cutoverAt: z.number() });
const ACTIVE_MS = 3 * 24 * 60 * 60_000;

function readCutover(path: string): boolean {
  try {
    if (journalSchema.safeParse(JSON.parse(readFileSync(path, "utf8"))).success) return true;
  } catch {
    // Truncated or not JSON. The file only exists after a cutover.
  }
  console.warn("chat sync v2: invalid cutover journal; staying cut over");
  return true;
}

export function createThreadSyncV2Gate(dataDir: string, override = process.env.OMB_THREAD_SYNC_V2) {
  const path = join(dataDir, "thread-sync-v2-cutover.json");
  let cutover = override !== "0" && existsSync(path) && readCutover(path);
  let waitingFor: string[] = [];
  let started = false;
  return {
    get enabled() { return override !== "0" && (override === "1" || cutover); },
    get waitingFor() { return waitingFor; },
    get started() { return started; },
    check(folder: string | null, now = Date.now()): boolean {
      if (override === "0") return false;
      waitingFor = [];
      let blocked = false;
      if (folder) {
        const scan = scanDevices(folder);
        blocked = scan.rootError || scan.dirError === "unreadable";
        if (!blocked) {
          try {
            mkdirSync(join(folder, "threads-v2"), { recursive: true });
          } catch {
            blocked = true;
          }
          const names: string[] = [];
          for (const record of scan.records) {
            if (now - record.lastSeen <= ACTIVE_MS && record.chatSync !== 2) names.push(record.name);
          }
          for (const file of scan.unreadable) {
            // No mtime means we cannot prove the PC is idle.
            if (file.mtimeMs === null || now - file.mtimeMs <= ACTIVE_MS) names.push(file.stem);
          }
          waitingFor = [...new Set(names)].sort((a, b) => a.localeCompare(b));
        }
      }
      if (!cutover && folder && !blocked && (override === "1" || !waitingFor.length)) {
        writeFileAtomic(path, `${JSON.stringify({ version: 2, cutoverAt: now })}\n`, { mode: 0o600 });
        cutover = true;
        started = true;
      }
      if (this.enabled) waitingFor = [];
      return this.enabled;
    },
  };
}
