// Phones paired for relay access (docs/phone-relay-design.md section 8),
// ported from the companion's DeviceRegistry. Tokens live on disk only as
// SHA-256 digests; every check runs synchronously, so concurrent requests
// cannot redeem one window twice or race a guess counter.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { realClock, type Cancel, type Clock } from "./phone-relay/clock.ts";
import { parseJson } from "./schema.ts";

export const PHONES_FILE = "phone-devices.json";
export const PAIRING_TTL_MS = 120_000;
export const MAX_PAIRING_ATTEMPTS = 5;
export const MAX_PHONES = 20;
const DAY_MS = 24 * 60 * 60_000;
export const PHONE_IDLE_MS = 90 * DAY_MS;
export const COOKIE_REFRESH_MS = 7 * DAY_MS;
/** lastSeen is a Settings nicety, not an audit log. */
const LAST_SEEN_WRITE_MS = 60_000;
const PAIRING_PREFIX = "wkp_";
const TOKEN_PREFIX = "wkd_";
const MAX_CREDENTIAL_LENGTH = 128;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{16,128}$/;

const storedTime = z.number().positive().optional().catch(undefined);
/** Only id and tokenHash decide whether a stored record is a phone; the rest is display and gets defaults. */
const storedPhoneSchema = z.object({
  id: z.string().min(1),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().optional().catch(undefined),
  createdAt: storedTime,
  lastSeenAt: storedTime,
  cookieAt: storedTime,
});
const phonesFileSchema = z.object({ phones: z.array(z.unknown()) });

interface PhoneRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  cookieAt: number;
  /** Refused, but kept until a write leaves it out, so a failed removal can be retried. */
  revoked?: boolean;
}

export interface PublicPhone {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface PairingWindow {
  code: string;
  token: string;
  expiresAt: number;
}

export type PairError = "no-pairing" | "wrong-credential" | "too-many-attempts" | "too-many-phones" | "save-failed";
export type PairResult = { ok: true; phone: PublicPhone; token: string } | { ok: false; error: PairError };

interface Replay {
  requestId: string;
  credentialHash: string;
  expiresAt: number;
  result: PairResult;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Phone-supplied display text: no control characters, bounded. */
export function cleanPhoneName(raw: string | undefined): string {
  const name = (raw ?? "").replace(/\p{Cc}/gu, " ").trim().slice(0, 60);
  return name || "Phone";
}

function storedPhone(entry: z.infer<typeof storedPhoneSchema>, now: number): PhoneRecord {
  const createdAt = entry.createdAt ?? now;
  return {
    id: entry.id,
    name: cleanPhoneName(entry.name),
    tokenHash: entry.tokenHash,
    createdAt,
    lastSeenAt: entry.lastSeenAt ?? createdAt,
    cookieAt: entry.cookieAt ?? createdAt,
  };
}

const publicPhone = ({ id, name, createdAt, lastSeenAt }: PhoneRecord): PublicPhone => ({ id, name, createdAt, lastSeenAt });

export class PhoneDevices {
  private readonly dataDir: string;
  private readonly clock: Clock;
  private phones: PhoneRecord[] = [];
  private window: (PairingWindow & { attemptsLeft: number }) | null = null;
  private replay: Replay | null = null;
  private replayTimer: Cancel | null = null;
  private readonly lastSeenWrites = new Map<string, number>();

  constructor(dataDir: string, clock: Clock = realClock) {
    this.dataDir = dataDir;
    this.clock = clock;
    try {
      const file = phonesFileSchema.safeParse(parseJson(readFileSync(join(dataDir, PHONES_FILE), "utf8")));
      const now = clock.now();
      for (const entry of file.success ? file.data.phones : []) {
        const parsed = storedPhoneSchema.safeParse(entry);
        if (parsed.success) this.phones.push(storedPhone(parsed.data, now));
      }
    } catch {
      // First run, or unreadable: no paired phones.
    }
  }

  private persist(): void {
    const phones = this.phones.filter((phone) => !phone.revoked);
    mkdirSync(this.dataDir, { recursive: true });
    writeFileAtomic(join(this.dataDir, PHONES_FILE), `${JSON.stringify({ phones }, null, 2)}\n`, { mode: 0o600 });
    this.phones = phones;
  }

  list(): PublicPhone[] {
    return this.phones.map(publicPhone);
  }

  /** Opens a fresh window, replacing any open one. */
  openPairing(): PairingWindow {
    this.clearReplay();
    const window = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      token: `${PAIRING_PREFIX}${randomBytes(32).toString("base64url")}`,
      expiresAt: this.clock.now() + PAIRING_TTL_MS,
      attemptsLeft: MAX_PAIRING_ATTEMPTS,
    };
    this.window = window;
    return { code: window.code, token: window.token, expiresAt: window.expiresAt };
  }

  closePairing(): void {
    this.window = null;
    this.clearReplay();
  }

  private clearReplay(): void {
    this.replay = null;
    this.replayTimer?.();
    this.replayTimer = null;
  }

  /** Redeems the QR token or the 6 digit code. A repeat with the same request id and credential gets the same phone. */
  redeem(credential: string, name: string | undefined, requestId: string | undefined): PairResult {
    const now = this.clock.now();
    const presented = credential.length <= MAX_CREDENTIAL_LENGTH ? credential : "";
    const id = requestId !== undefined && REQUEST_ID_RE.test(requestId) ? requestId : null;
    if (this.replay && this.replay.expiresAt <= now) this.clearReplay();
    if (id && this.replay && sameText(this.replay.requestId, id) && sameText(this.replay.credentialHash, sha256(presented))) {
      return this.replay.result;
    }
    const window = this.window && this.window.expiresAt > now ? this.window : null;
    if (!window) {
      this.window = null;
      return { ok: false, error: "no-pairing" };
    }
    if (!presented || (!sameText(window.code, presented) && !sameText(window.token, presented))) {
      window.attemptsLeft -= 1;
      if (window.attemptsLeft > 0) return { ok: false, error: "wrong-credential" };
      this.closePairing();
      return { ok: false, error: "too-many-attempts" };
    }
    // After the guess check, so a full list tells a guesser nothing and the window survives a removal.
    if (this.phones.length >= MAX_PHONES) return { ok: false, error: "too-many-phones" };
    this.window = null;
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const record: PhoneRecord = {
      id: randomUUID(),
      name: cleanPhoneName(name),
      tokenHash: sha256(token),
      createdAt: now,
      lastSeenAt: now,
      cookieAt: now,
    };
    this.phones.push(record);
    try {
      this.persist();
    } catch {
      this.phones.pop();
      return { ok: false, error: "save-failed" };
    }
    const result: PairResult = { ok: true, phone: publicPhone(record), token };
    if (id) {
      this.replay = { requestId: id, credentialHash: sha256(presented), expiresAt: window.expiresAt, result };
      this.replayTimer = this.clock.schedule(window.expiresAt - now, () => this.clearReplay());
    }
    return result;
  }

  /** The phone holding `token`, or null. `refreshCookie` asks the caller to re-set the cookie (weekly). */
  authenticate(token: string | null | undefined): { phone: PublicPhone; refreshCookie: boolean } | null {
    if (!token?.startsWith(TOKEN_PREFIX)) return null;
    const hash = sha256(token);
    const record = this.phones.find((phone) => sameText(phone.tokenHash, hash));
    if (!record || record.revoked) return null;
    const now = this.clock.now();
    if (now - record.lastSeenAt >= PHONE_IDLE_MS) {
      this.phones = this.phones.filter((phone) => phone !== record);
      this.lastSeenWrites.delete(record.id);
      this.persistQuietly();
      return null;
    }
    const refreshCookie = now - record.cookieAt >= COOKIE_REFRESH_MS;
    if (refreshCookie) record.cookieAt = now;
    if (refreshCookie || now - (this.lastSeenWrites.get(record.id) ?? record.lastSeenAt) > LAST_SEEN_WRITE_MS) {
      record.lastSeenAt = now;
      this.lastSeenWrites.set(record.id, now);
      this.persistQuietly();
    }
    return { phone: publicPhone(record), refreshCookie };
  }

  /** A failed timestamp write must never stop a valid phone from working. */
  private persistQuietly(): void {
    try {
      this.persist();
    } catch {
      // The record stays valid in memory; the timestamp can wait.
    }
  }

  revoke(id: string): boolean {
    const record = this.phones.find((phone) => phone.id === id);
    if (!record) return false;
    record.revoked = true;
    this.lastSeenWrites.delete(id);
    this.persist();
    return true;
  }
}
