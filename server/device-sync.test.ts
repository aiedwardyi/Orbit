import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEVICE_DIR, DEVICE_STALE_MS, listDevices, writeDeviceRecord } from "./device-sync.ts";

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
});
