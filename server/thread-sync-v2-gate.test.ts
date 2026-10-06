import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { writeDeviceRecord } from "./device-sync.ts";
import { createThreadSyncV2Gate } from "./thread-sync-v2-gate.ts";

const temp = () => mkdtempSync(join(tmpdir(), "sync-v2-gate-"));
const now = 1_800_000_000_000;
const record = (deviceId: string) => ({ deviceId, name: deviceId, host: `${deviceId}.example.com` });

describe("chat sync cutover", () => {
  it("waits for fresh old builds, ignores stale records and never reverts", () => {
    const folder = temp();
    const dataDir = temp();
    const gate = createThreadSyncV2Gate(dataDir, "");
    writeDeviceRecord(folder, { ...record("a"), chatSync: 2 }, now);
    writeDeviceRecord(folder, record("b"), now);
    writeDeviceRecord(folder, record("c"), now - 4 * 86400_000);
    expect(gate.check(folder, now)).toBe(false);
    expect(existsSync(join(folder, "threads-v2"))).toBe(true);
    expect(gate.waitingFor).toEqual(["b"]);
    writeDeviceRecord(folder, { ...record("b"), chatSync: 2 }, now);
    expect(gate.check(folder, now)).toBe(true);
    writeDeviceRecord(folder, record("b"), now);
    expect(createThreadSyncV2Gate(dataDir, "").check(folder, now)).toBe(true);
    expect(createThreadSyncV2Gate(dataDir, "0").check(folder, now)).toBe(false);
  });

  it("forces v2 and checks records beyond the device picker limit", () => {
    const folder = temp();
    for (let i = 0; i < 65; i++) writeDeviceRecord(folder, { ...record(`a${i}`), chatSync: 2 }, now);
    writeDeviceRecord(folder, record("z-old"), now);
    expect(createThreadSyncV2Gate(temp(), "").check(folder, now)).toBe(false);
    expect(createThreadSyncV2Gate(temp(), "1").check(folder, now)).toBe(true);
  });

  it("retains compatibility with old records that strip unknown fields", () => {
    const folder = temp();
    writeDeviceRecord(folder, { ...record("a"), chatSync: 2 }, now);
    const path = join(folder, "devices", "a.json");
    const { chatSync: _capability, ...old } = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(old));
    expect(createThreadSyncV2Gate(temp(), "").check(folder, now)).toBe(false);
  });

  it("keeps cutover blocked while a fresh record cannot be read", () => {
    const folder = temp();
    const dataDir = temp();
    const gate = createThreadSyncV2Gate(dataDir, "");
    writeDeviceRecord(folder, { ...record("a"), chatSync: 2 }, now);
    writeDeviceRecord(folder, record("b"), now);
    expect(gate.check(folder, now)).toBe(false);
    const path = join(folder, "devices", "b.json");
    writeFileSync(path, "{truncated");
    utimesSync(path, new Date(now), new Date(now));
    expect(gate.check(folder, now)).toBe(false);
    expect(gate.waitingFor).toEqual(["b"]);
    expect(createThreadSyncV2Gate(dataDir, "").check(folder, now)).toBe(false);
    writeDeviceRecord(folder, record("b"), now);
    expect(gate.check(folder, now)).toBe(false);
    expect(createThreadSyncV2Gate(dataDir, "").check(folder, now)).toBe(false);
  });

  it("does not let an unreadable record older than 3 days block cutover", () => {
    const folder = temp();
    writeDeviceRecord(folder, { ...record("a"), chatSync: 2 }, now);
    writeDeviceRecord(folder, record("b"), now);
    const path = join(folder, "devices", "b.json");
    writeFileSync(path, "{truncated");
    const stale = new Date(now - 3 * 24 * 60 * 60_000 - 86_400_000);
    utimesSync(path, stale, stale);
    expect(createThreadSyncV2Gate(temp(), "").check(folder, now)).toBe(true);
  });

  it("never cuts over a missing sync root and still cuts over a root without devices", () => {
    const check = (folder: string) => createThreadSyncV2Gate(temp(), "").check(folder, now);
    expect(check(join(temp(), "missing"))).toBe(false);
    expect(check(temp())).toBe(true);
    const blocked = temp();
    writeFileSync(join(blocked, "devices"), "not-a-directory");
    expect(check(blocked)).toBe(false);
  });

  it("treats a present invalid journal as cut over without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const bytes of ["{truncated", "null", '{"version":1,"cutoverAt":1}']) {
        const dataDir = temp();
        writeFileSync(join(dataDir, "thread-sync-v2-cutover.json"), bytes);
        warn.mockClear();
        expect(createThreadSyncV2Gate(dataDir, "").enabled).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockClear();
        expect(createThreadSyncV2Gate(dataDir, "0").enabled).toBe(false);
        expect(warn).not.toHaveBeenCalled();
      }
    } finally {
      warn.mockRestore();
    }
  });
});
