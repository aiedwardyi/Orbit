import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as atomic from "./atomic.ts";
import {
  COOKIE_REFRESH_MS,
  MAX_PHONES,
  PAIRING_TTL_MS,
  PHONE_IDLE_MS,
  PHONES_FILE,
  PhoneDevices,
} from "./phone-devices.ts";
import { FakeClock } from "./phone-relay/testing/fake-clock.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wink-phones-"));
  dirs.push(dir);
  return dir;
}

function registry(dir = freshDir(), clock = new FakeClock(1_800_000_000_000)) {
  return { dir, clock, phones: new PhoneDevices(dir, clock) };
}

function pairOne(phones: PhoneDevices, name = "Pixel") {
  const window = phones.openPairing();
  const result = phones.redeem(window.token, name, undefined);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("phone devices", () => {
  it("pairs once with the QR token and keeps only its digest", () => {
    const { dir, phones } = registry();
    const window = phones.openPairing();
    expect(window.token).toMatch(/^wkp_[A-Za-z0-9_-]{43}$/);
    expect(window.code).toMatch(/^\d{6}$/);
    const result = phones.redeem(window.token, "Pixel 9", undefined);
    if (!result.ok) throw new Error(result.error);
    expect(result.token).toMatch(/^wkd_[A-Za-z0-9_-]{43}$/);
    expect(result.phone.name).toBe("Pixel 9");
    const text = readFileSync(join(dir, PHONES_FILE), "utf8");
    expect(text).not.toContain(result.token);
    expect(text).not.toContain(window.token);
    expect(text).toContain(createHash("sha256").update(result.token).digest("hex"));
    expect(phones.authenticate(result.token)?.phone.id).toBe(result.phone.id);
    expect(phones.redeem(window.token, "again", undefined)).toEqual({ ok: false, error: "no-pairing" });
    expect(phones.redeem(window.code, "again", undefined)).toEqual({ ok: false, error: "no-pairing" });
  });

  it("pairs with the 6 digit code", () => {
    const { phones } = registry();
    const window = phones.openPairing();
    const result = phones.redeem(window.code, "iPhone", undefined);
    expect(result.ok).toBe(true);
  });

  it("expires the window at exactly 120 seconds", () => {
    const { phones, clock } = registry();
    const window = phones.openPairing();
    clock.advance(PAIRING_TTL_MS);
    expect(phones.redeem(window.code, "x", undefined)).toEqual({ ok: false, error: "no-pairing" });
  });

  it("keeps a window usable until its last millisecond", () => {
    const { phones, clock } = registry();
    const window = phones.openPairing();
    clock.advance(PAIRING_TTL_MS - 1);
    expect(phones.redeem(window.token, "x", undefined).ok).toBe(true);
  });

  it("burns the window on the fifth wrong guess", () => {
    const { phones } = registry();
    const window = phones.openPairing();
    const wrong = window.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect(phones.redeem(wrong, "x", undefined)).toEqual({ ok: false, error: "wrong-credential" });
    expect(phones.redeem(wrong, "x", undefined)).toEqual({ ok: false, error: "too-many-attempts" });
    expect(phones.redeem(window.code, "x", undefined)).toEqual({ ok: false, error: "no-pairing" });
    expect(phones.list()).toEqual([]);
  });

  it("counts an empty or oversized credential as a guess", () => {
    const { phones } = registry();
    const window = phones.openPairing();
    for (const value of ["", "x".repeat(10_000), `${window.token}x`, window.code.slice(1)]) {
      expect(phones.redeem(value, "x", undefined)).toEqual({ ok: false, error: "wrong-credential" });
    }
    expect(phones.redeem(`${window.code} `, "x", undefined)).toEqual({ ok: false, error: "too-many-attempts" });
    expect(phones.redeem(window.token, "x", undefined)).toEqual({ ok: false, error: "no-pairing" });
  });

  it("keeps control characters out of phone names", () => {
    const { phones } = registry();
    const result = phones.redeem(phones.openPairing().code, "Pixel\u0000\u001b[31m 9\u0085", undefined);
    expect(result.ok && result.phone.name).toBe("Pixel  [31m 9");
  });

  it("replays one redemption for the same request id until the window would have expired", () => {
    const { phones, clock } = registry();
    const window = phones.openPairing();
    const requestId = "req-0123456789abcdef";
    const first = phones.redeem(window.token, "Pixel", requestId);
    if (!first.ok) throw new Error(first.error);
    expect(phones.redeem(window.token, "Pixel", requestId)).toEqual(first);
    expect(phones.redeem(window.token, "Pixel", "req-other-0123456789")).toEqual({ ok: false, error: "no-pairing" });
    expect(phones.redeem(window.code, "Pixel", requestId)).toEqual({ ok: false, error: "no-pairing" });
    expect(phones.list()).toHaveLength(1);
    clock.advance(PAIRING_TTL_MS);
    expect(phones.redeem(window.token, "Pixel", requestId)).toEqual({ ok: false, error: "no-pairing" });
  });

  it("forgets the replayed token when the window ends even if nobody asks again", () => {
    const { phones, clock } = registry();
    const window = phones.openPairing();
    phones.redeem(window.token, "Pixel", "req-0123456789abcdef");
    expect(clock.pending).toBe(1);
    clock.advance(PAIRING_TTL_MS);
    expect(clock.pending).toBe(0);
  });

  it("ignores a request id that is not a plain id", () => {
    const { phones } = registry();
    const window = phones.openPairing();
    const first = phones.redeem(window.token, "Pixel", "short");
    expect(first.ok).toBe(true);
    expect(phones.redeem(window.token, "Pixel", "short")).toEqual({ ok: false, error: "no-pairing" });
  });

  it("refuses a 21st phone without spending a guess and keeps the window", () => {
    const { phones } = registry();
    const paired = Array.from({ length: MAX_PHONES }, (_, i) => pairOne(phones, `phone ${i}`));
    const window = phones.openPairing();
    expect(phones.redeem(window.code, "extra", undefined)).toEqual({ ok: false, error: "too-many-phones" });
    expect(phones.revoke(paired[0]!.phone.id)).toBe(true);
    expect(phones.redeem(window.code, "extra", undefined).ok).toBe(true);
  });

  it("keeps phones across a restart but not the pairing window", () => {
    const { dir, phones, clock } = registry();
    const paired = pairOne(phones);
    const window = phones.openPairing();
    const restarted = new PhoneDevices(dir, clock);
    expect(restarted.authenticate(paired.token)?.phone.id).toBe(paired.phone.id);
    expect(restarted.redeem(window.code, "x", undefined)).toEqual({ ok: false, error: "no-pairing" });
  });

  it("starts empty from a missing, corrupt or hand-edited file", () => {
    const dir = freshDir();
    expect(new PhoneDevices(dir).list()).toEqual([]);
    writeFileSync(join(dir, PHONES_FILE), "{nope");
    expect(new PhoneDevices(dir).list()).toEqual([]);
    writeFileSync(join(dir, PHONES_FILE), JSON.stringify({ phones: [{ id: "a" }, { id: "b", tokenHash: "f".repeat(64), name: "\u0007" }] }));
    const list = new PhoneDevices(dir).list();
    expect(list.map((phone) => [phone.id, phone.name])).toEqual([["b", "Phone"]]);
  });

  it("signs out a phone idle for 90 days", () => {
    const { phones, clock } = registry();
    const paired = pairOne(phones);
    clock.advance(PHONE_IDLE_MS - 1);
    expect(phones.authenticate(paired.token)).not.toBeNull();
    clock.advance(PHONE_IDLE_MS);
    expect(phones.authenticate(paired.token)).toBeNull();
    expect(phones.list()).toEqual([]);
  });

  it("asks for a fresh cookie once a week", () => {
    const { phones, clock } = registry();
    const paired = pairOne(phones);
    expect(phones.authenticate(paired.token)?.refreshCookie).toBe(false);
    clock.advance(COOKIE_REFRESH_MS - 1);
    expect(phones.authenticate(paired.token)?.refreshCookie).toBe(false);
    clock.advance(1);
    expect(phones.authenticate(paired.token)?.refreshCookie).toBe(true);
    expect(phones.authenticate(paired.token)?.refreshCookie).toBe(false);
  });

  it("revokes one phone and leaves the others", () => {
    const { phones } = registry();
    const a = pairOne(phones, "a");
    const b = pairOne(phones, "b");
    expect(phones.revoke(a.phone.id)).toBe(true);
    expect(phones.revoke(a.phone.id)).toBe(false);
    expect(phones.authenticate(a.token)).toBeNull();
    expect(phones.authenticate(b.token)?.phone.name).toBe("b");
    expect(phones.authenticate(null)).toBeNull();
    expect(phones.authenticate("wkd_unknown")).toBeNull();
  });

  it("keeps a failed removal listed and refused until a write drops it", () => {
    const { dir, clock, phones } = registry();
    const lost = pairOne(phones, "lost");
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => {
      throw new Error("disk busy");
    });
    expect(() => phones.revoke(lost.phone.id)).toThrow("disk busy");
    expect(phones.list().map((phone) => phone.name)).toEqual(["lost"]);
    expect(phones.authenticate(lost.token)).toBeNull();
    pairOne(phones, "next");
    expect(phones.list().map((phone) => phone.name)).toEqual(["next"]);
    expect(new PhoneDevices(dir, clock).authenticate(lost.token)).toBeNull();
  });

  it("issues exactly one phone to concurrent redemptions", async () => {
    const { phones } = registry();
    const window = phones.openPairing();
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => phones.redeem(i % 2 ? window.code : window.token, `p${i}`, undefined)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(phones.list()).toHaveLength(1);
  });

  it("rolls back a phone it could not save", () => {
    const parent = freshDir();
    const blocker = join(parent, "file");
    writeFileSync(blocker, "");
    const phones = new PhoneDevices(join(blocker, "data"), new FakeClock());
    const window = phones.openPairing();
    expect(phones.redeem(window.token, "x", undefined)).toEqual({ ok: false, error: "save-failed" });
    expect(phones.list()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("writes the file owner-only", () => {
    const { dir, phones } = registry();
    pairOne(phones);
    expect(statSync(join(dir, PHONES_FILE)).mode & 0o777).toBe(0o600);
  });
});
