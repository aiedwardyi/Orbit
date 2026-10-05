// Per-PC presence records in the sync folder so a phone can jump between PCs.
// Records carry only a name, a public tailnet host and a timestamp: never the remote key or cookie.
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

export const DEVICE_DIR = "devices";
export const DEVICE_HEARTBEAT_MS = 5 * 60_000;
export const DEVICE_STALE_MS = 15 * 60_000;
export const DEVICE_NAME_FILE = "device-name.json";
const MAX_DEVICE_FILES = 64;

export const deviceNameSchema = z.string().trim().min(1).max(64);

const deviceSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
  name: deviceNameSchema,
  host: z.string().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
  lastSeen: z.number().int().nonnegative(),
  laptop: z.boolean().optional(),
  chatSync: z.literal(2).optional(),
});

export type DeviceRecord = z.infer<typeof deviceSchema>;
export type DeviceListItem = DeviceRecord & { current: boolean; offline: boolean };

export function writeDeviceRecord(folder: string, record: Omit<DeviceRecord, "lastSeen">, now: number): void {
  const parsed = deviceSchema.parse({ deviceId: record.deviceId, name: record.name, host: record.host, lastSeen: now, laptop: record.laptop, chatSync: record.chatSync });
  const directory = join(folder, DEVICE_DIR);
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(join(directory, `${parsed.deviceId}.json`), `${JSON.stringify(parsed, null, 2)}\n`);
}

/** A battery means a laptop, so the picker can show the right icon. */
export function detectLaptop(): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      return Promise.resolve(readdirSync("/sys/class/power_supply").some((name) => name.startsWith("BAT")));
    } catch {
      return Promise.resolve(false);
    }
  }
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "@(Get-CimInstance Win32_Battery).Count"],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => resolve(!error && Number(stdout.trim()) > 0),
    );
  });
}

/** This PC's saved name, local only; null when unset or invalid. */
export function loadDeviceName(dataDir: string): string | null {
  try {
    const parsed = deviceNameSchema.safeParse(JSON.parse(readFileSync(join(dataDir, DEVICE_NAME_FILE), "utf8")).name);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveDeviceName(dataDir: string, name: string): string {
  const parsed = deviceNameSchema.parse(name);
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, DEVICE_NAME_FILE), `${JSON.stringify({ name: parsed }, null, 2)}
`);
  return parsed;
}

export function deviceDisplayName(saved: string | null, envName: string | undefined, hostname: string): string {
  return saved || envName?.trim() || hostname;
}

/** Valid records by name; corrupt files are skipped. */
export function listDevices(folder: string, currentId: string, now: number, limit = MAX_DEVICE_FILES): DeviceListItem[] {
  const directory = join(folder, DEVICE_DIR);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const items: DeviceListItem[] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort().slice(0, limit)) {
    try {
      const parsed = deviceSchema.safeParse(JSON.parse(readFileSync(join(directory, basename(name)), "utf8")));
      if (!parsed.success) continue;
      items.push({ ...parsed.data, current: parsed.data.deviceId === currentId, offline: now - parsed.data.lastSeen > DEVICE_STALE_MS });
    } catch {}
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export interface DeviceScan {
  rootError: boolean;
  dirError: "absent" | "unreadable" | null;
  records: DeviceRecord[];
  unreadable: { stem: string; mtimeMs: number | null }[];
}

/** Presence scan for cutover. Read failures stay visible; the phone picker still uses listDevices. */
export function scanDevices(folder: string): DeviceScan {
  const empty = { records: [], unreadable: [] };
  try {
    if (!statSync(folder).isDirectory()) return { rootError: true, dirError: null, ...empty };
  } catch {
    return { rootError: true, dirError: null, ...empty };
  }
  let names: string[];
  try {
    names = readdirSync(join(folder, DEVICE_DIR));
  } catch (error) {
    // SAFETY: Filesystem failures expose Node's errno code.
    const code = (error as NodeJS.ErrnoException).code;
    return { rootError: false, dirError: code === "ENOENT" ? "absent" : "unreadable", ...empty };
  }
  const records: DeviceRecord[] = [];
  const unreadable: DeviceScan["unreadable"] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const path = join(folder, DEVICE_DIR, basename(name));
    let mtimeMs: number | null;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    try {
      const parsed = deviceSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) unreadable.push({ stem: basename(name, ".json"), mtimeMs });
      else records.push(parsed.data);
    } catch {
      unreadable.push({ stem: basename(name, ".json"), mtimeMs });
    }
  }
  return { rootError: false, dirError: null, records, unreadable };
}
