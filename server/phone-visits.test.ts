import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as atomic from "./atomic.ts";
import { PHONE_VISIT_TTL_MS, PHONE_VISITS_FILE, PhoneVisits, phoneKind } from "./phone-visits.ts";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const ID = "0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const START = 1_800_000_000_000;

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function visits(dir = mkdtempSync(join(tmpdir(), "wink-phone-visits-"))) {
  dirs.push(dir);
  const clock = { at: START };
  return { dir, clock, visits: new PhoneVisits(dir, () => clock.at) };
}

const stored = (dir: string) => JSON.parse(readFileSync(join(dir, PHONE_VISITS_FILE), "utf8"));

describe("phoneKind", () => {
  it.each([
    [ANDROID, "android"],
    [ANDROID_TABLET, "phone"],
    [IPHONE, "iphone"],
    [IPAD, "ipad"],
    ["", "phone"],
    [undefined, "phone"],
    [WINDOWS, null],
    [MAC, null],
    [LINUX, null],
  ])("reads %s", (ua, kind) => {
    expect(phoneKind(ua)).toBe(kind);
  });
});

describe("PhoneVisits", () => {
  it("records a phone in its own file", () => {
    const { dir, visits: phones } = visits();
    phones.seen(ID, ANDROID);
    expect(phones.list()).toEqual([{ id: ID, kind: "android", lastSeen: START }]);
    expect(stored(dir)).toEqual({ phones: [{ id: ID, kind: "android", lastSeen: START }] });
    expect(new PhoneVisits(dir).list()).toEqual([{ id: ID, kind: "android", lastSeen: START }]);
  });

  it("ignores desktop browsers and bad ids", () => {
    const { dir, visits: phones } = visits();
    phones.seen(ID, WINDOWS);
    phones.seen("short", ANDROID);
    phones.seen("../../escape-attempt", ANDROID);
    expect(phones.list()).toEqual([]);
    expect(existsSync(join(dir, PHONE_VISITS_FILE))).toBe(false);
  });

  it("writes each phone at most once a minute but keeps lastSeen fresh", () => {
    const { dir, clock, visits: phones } = visits();
    const write = vi.spyOn(atomic, "writeFileAtomic");
    phones.seen(ID, ANDROID);
    clock.at += 30_000;
    phones.seen(ID, ANDROID);
    expect(write).toHaveBeenCalledTimes(1);
    expect(phones.list()[0]!.lastSeen).toBe(START + 30_000);
    phones.seen(OTHER, IPHONE);
    expect(write).toHaveBeenCalledTimes(2);
    clock.at += 30_000;
    phones.seen(ID, ANDROID);
    expect(write).toHaveBeenCalledTimes(3);
    expect(stored(dir).phones).toEqual([
      { id: ID, kind: "android", lastSeen: START + 60_000 },
      { id: OTHER, kind: "iphone", lastSeen: START + 30_000 },
    ]);
  });

  it("drops a phone not seen for 30 days", () => {
    const { dir, clock, visits: phones } = visits();
    phones.seen(ID, ANDROID);
    clock.at += PHONE_VISIT_TTL_MS - 1;
    expect(phones.list()).toHaveLength(1);
    phones.seen(OTHER, IPHONE);
    clock.at += 1;
    expect(phones.list().map((phone) => phone.id)).toEqual([OTHER]);
    clock.at += 60_000;
    phones.seen(OTHER, IPHONE);
    expect(stored(dir).phones.map((phone: { id: string }) => phone.id)).toEqual([OTHER]);
  });

  it("keeps working when the file is damaged or the write fails", () => {
    const { dir } = visits();
    writeFileSync(join(dir, PHONE_VISITS_FILE), JSON.stringify({ phones: [{ id: ID, kind: "fridge", lastSeen: START }, { id: OTHER, kind: "ipad", lastSeen: START }] }));
    const phones = new PhoneVisits(dir, () => START);
    expect(phones.list()).toEqual([{ id: OTHER, kind: "ipad", lastSeen: START }]);
    writeFileSync(join(dir, PHONE_VISITS_FILE), "{not json");
    expect(new PhoneVisits(dir).list()).toEqual([]);
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => phones.seen(ID, ANDROID)).not.toThrow();
    expect(phones.list()).toHaveLength(2);
  });
});
