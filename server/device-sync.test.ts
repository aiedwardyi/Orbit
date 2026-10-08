import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DEVICE_DIR,
  DEVICE_STALE_MS,
  deviceDisplayName,
  listDevices,
  loadDeviceName,
  pickerDevices,
  saveDeviceName,
  scanDevices,
  writeDeviceRecord,
} from "./device-sync.ts";

const NOW = 1_800_000_000_000;
const freshDir = () => mkdtempSync(join(tmpdir(), "orbit-devices-"));
const rec = (id: string, host = `${id}.tail396477.ts.net`) => ({ deviceId: id, name: id, host });

describe("device sync", () => {
  it("writes name, host and time only, never a secret", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), key: "a".repeat(64), cookie: "orbit_remote=x" } as never, NOW);
    const text = readFileSync(join(folder, DEVICE_DIR, "home.json"), "utf8");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["deviceId", "host", "lastSeen", "name"]);
    expect(text).not.toMatch(/key|cookie|orbit_remote|a{64}/);
  });

  it("keeps the laptop flag", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("laptop"), laptop: true }, NOW);
    writeDeviceRecord(folder, rec("home"), NOW);
    expect(listDevices(folder, "home", NOW).map((d) => [d.deviceId, d.laptop])).toEqual([["home", undefined], ["laptop", true]]);
  });

  it("rejects a host that is not a plain hostname", () => {
    expect(() => writeDeviceRecord(freshDir(), rec("home", "evil.com/x?y"), NOW)).toThrow();
  });

  it("ignores corrupt, invalid and non-json files", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, rec("home"), NOW);
    const dir = join(folder, DEVICE_DIR);
    writeFileSync(join(dir, "bad.json"), "{nope");
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ deviceId: "x", name: "x", host: "https://evil.com", lastSeen: NOW }));
    writeFileSync(join(dir, "notes.txt"), "hi");
    expect(listDevices(folder, "home", NOW).map((d) => d.deviceId)).toEqual(["home"]);
    expect(readdirSync(dir)).toHaveLength(4);
  });

  it("returns nothing when the folder has no records", () => {
    const folder = freshDir();
    expect(listDevices(folder, "home", NOW)).toEqual([]);
    mkdirSync(join(folder, DEVICE_DIR));
    expect(listDevices(folder, "home", NOW)).toEqual([]);
  });

  it("marks the current device", () => {
    const folder = freshDir();
    for (const id of ["home", "work", "laptop"]) writeDeviceRecord(folder, rec(id), NOW);
    const list = listDevices(folder, "work", NOW);
    expect(list.map((d) => [d.deviceId, d.current])).toEqual([["home", false], ["laptop", false], ["work", true]]);
  });

  it("marks a device offline once its record is stale", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, rec("home"), NOW - DEVICE_STALE_MS - 1);
    writeDeviceRecord(folder, rec("work"), NOW - DEVICE_STALE_MS);
    const byId = Object.fromEntries(listDevices(folder, "x", NOW).map((d) => [d.deviceId, d.offline]));
    expect(byId).toEqual({ home: true, work: false });
  });

  it("saves a trimmed name that a fresh load reads back", () => {
    const dataDir = freshDir();
    expect(loadDeviceName(dataDir)).toBeNull();
    expect(saveDeviceName(dataDir, "  Home  ")).toBe("Home");
    expect(loadDeviceName(dataDir)).toBe("Home");
  });

  it("rejects an empty or over-64 name", () => {
    const dataDir = freshDir();
    expect(() => saveDeviceName(dataDir, "   ")).toThrow();
    expect(() => saveDeviceName(dataDir, "x".repeat(65))).toThrow();
    expect(saveDeviceName(dataDir, "x".repeat(64))).toHaveLength(64);
  });

  it("ignores a corrupt name file", () => {
    const dataDir = freshDir();
    writeFileSync(join(dataDir, "device-name.json"), "{nope");
    expect(loadDeviceName(dataDir)).toBeNull();
  });

  it("reports an unreadable root, a missing device directory, and bad records", () => {
    expect(scanDevices(join(freshDir(), "missing"))).toMatchObject({ rootError: true, records: [], unreadable: [] });
    const empty = freshDir();
    expect(scanDevices(empty)).toMatchObject({ rootError: false, dirError: "absent", records: [] });
    const folder = freshDir();
    writeDeviceRecord(folder, rec("home"), NOW);
    writeFileSync(join(folder, DEVICE_DIR, "work.json"), "{nope");
    writeFileSync(join(folder, DEVICE_DIR, "notes.txt"), "hi");
    const scan = scanDevices(folder);
    expect(scan.dirError).toBeNull();
    expect(scan.records.map((item) => item.deviceId)).toEqual(["home"]);
    expect(scan.unreadable.map((item) => item.stem)).toEqual(["work"]);
    expect(scan.unreadable[0]?.mtimeMs).toBeGreaterThan(0);
    expect(listDevices(folder, "home", NOW).map((item) => item.deviceId)).toEqual(["home"]);
  });

  it("prefers the saved name, then the env name, then the hostname", () => {
    expect(deviceDisplayName("Home", "Env", "EDWARD-PC")).toBe("Home");
    expect(deviceDisplayName(null, " Env ", "EDWARD-PC")).toBe("Env");
    expect(deviceDisplayName(null, "  ", "EDWARD-PC")).toBe("EDWARD-PC");
    expect(deviceDisplayName(null, undefined, "EDWARD-PC")).toBe("EDWARD-PC");
  });
});

describe("relay presence", () => {
  const BASE = "wink.test";
  const relay = (label: string) => `${label.padEnd(16, "a")}.${BASE}`;
  // The record schema shipped before relay presence, as older PCs still read it.
  const oldReader = z.object({
    deviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
    name: z.string().trim().min(1).max(64),
    host: z.string().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
    lastSeen: z.number().int().nonnegative(),
    laptop: z.boolean().optional(),
    chatSync: z.literal(2).optional(),
  });

  it("keeps a relay host next to the tailnet host", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), relayHost: relay("home"), chatSync: 2 }, NOW);
    expect(listDevices(folder, "home", NOW)[0]).toMatchObject({ host: "home.tail396477.ts.net", relayHost: relay("home") });
  });

  it("stays readable by older PCs, including a relay-only record", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), relayHost: relay("home"), chatSync: 2 }, NOW);
    writeDeviceRecord(folder, { ...rec("cafe", relay("cafe")), relayHost: relay("cafe"), chatSync: 2 }, NOW);
    for (const id of ["home", "cafe"]) {
      expect(oldReader.safeParse(JSON.parse(readFileSync(join(folder, DEVICE_DIR, `${id}.json`), "utf8"))).success).toBe(true);
    }
    expect(scanDevices(folder).unreadable).toEqual([]);
  });

  it("reads old records and drops a relay host that is not a relay label", () => {
    const folder = freshDir();
    const dir = join(folder, DEVICE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.json"), JSON.stringify({ deviceId: "old", name: "Old", host: "old.tail396477.ts.net", lastSeen: NOW }));
    for (const [id, bad] of [["a", "evil.example"], ["b", "https://abcdefghijklmnop.wink.test"], ["c", "ABCDEFGHIJKLMNOP.wink.test"], ["d", 42]]) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ deviceId: id, name: id, host: `${id}.tail396477.ts.net`, relayHost: bad, lastSeen: NOW }));
    }
    const list = listDevices(folder, "old", NOW);
    expect(list.map((d) => [d.deviceId, d.relayHost])).toEqual([["a", undefined], ["b", undefined], ["c", undefined], ["d", undefined], ["old", undefined]]);
    expect(scanDevices(folder).unreadable).toEqual([]);
  });

  it("sends a relay phone only to relay hosts under this base", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), relayHost: relay("home") }, NOW);
    writeDeviceRecord(folder, { ...rec("cafe", relay("cafe")), relayHost: relay("cafe") }, NOW);
    writeDeviceRecord(folder, rec("work"), NOW);
    writeDeviceRecord(folder, { ...rec("lab"), relayHost: `${"l".padEnd(16, "a")}.other.test` }, NOW);
    const picked = pickerDevices(listDevices(folder, "home", NOW), BASE);
    expect(picked.map((d) => [d.deviceId, d.host, d.current])).toEqual([
      ["cafe", relay("cafe"), false],
      ["home", relay("home"), true],
    ]);
    expect(JSON.stringify(picked)).not.toContain("ts.net");
    expect(JSON.stringify(picked)).not.toContain("relayHost");
  });

  it("keeps the tailnet picker exactly as before", () => {
    const folder = freshDir();
    writeDeviceRecord(folder, { ...rec("home"), relayHost: relay("home") }, NOW);
    writeDeviceRecord(folder, { ...rec("cafe", relay("cafe")), relayHost: relay("cafe") }, NOW);
    writeDeviceRecord(folder, rec("work"), NOW);
    const picked = pickerDevices(listDevices(folder, "home", NOW), null);
    expect(picked).toEqual([
      { deviceId: "home", name: "home", host: "home.tail396477.ts.net", lastSeen: NOW, current: true, offline: false },
      { deviceId: "work", name: "work", host: "work.tail396477.ts.net", lastSeen: NOW, current: false, offline: false },
    ]);
  });
});
