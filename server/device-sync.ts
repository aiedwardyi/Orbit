// Per-PC presence records in the sync folder so a phone can jump between PCs.
// Records carry only a name, a public tailnet host and a timestamp: never the remote key or cookie.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

export const DEVICE_DIR = "devices";
export const DEVICE_HEARTBEAT_MS = 5 * 60_000;
export const DEVICE_STALE_MS = 15 * 60_000;
const MAX_DEVICE_FILES = 64;

const deviceSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
  name: z.string().trim().min(1).max(64),
  host: z.string().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
  lastSeen: z.number().int().nonnegative(),
});

export type DeviceRecord = z.infer<typeof deviceSchema>;
export type DeviceListItem = DeviceRecord & { current: boolean; offline: boolean };

export function writeDeviceRecord(folder: string, record: Omit<DeviceRecord, "lastSeen">, now: number): void {
  const parsed = deviceSchema.parse({ deviceId: record.deviceId, name: record.name, host: record.host, lastSeen: now });
  const directory = join(folder, DEVICE_DIR);
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(join(directory, `${parsed.deviceId}.json`), `${JSON.stringify(parsed, null, 2)}\n`);
}

/** Valid records by name; corrupt files are skipped. */
export function listDevices(folder: string, currentId: string, now: number): DeviceListItem[] {
  const directory = join(folder, DEVICE_DIR);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const items: DeviceListItem[] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort().slice(0, MAX_DEVICE_FILES)) {
    try {
      const parsed = deviceSchema.safeParse(JSON.parse(readFileSync(join(directory, basename(name)), "utf8")));
      if (!parsed.success) continue;
      items.push({ ...parsed.data, current: parsed.data.deviceId === currentId, offline: now - parsed.data.lastSeen > DEVICE_STALE_MS });
    } catch {}
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}
