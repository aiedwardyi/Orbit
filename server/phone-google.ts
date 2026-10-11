// Phone sign-in with Google. The PC checks the phone's ID token itself: the
// Web client audience, this PC's own Google account, and a nonce bound both
// to a one-time cookie on this browser and to this PC's relay label. The
// sign-in page computes that nonce for the label it forwards to, so a token
// only ever works at that origin. No Allow tap: the nonce is the guard.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { GoogleIdTokenError, verifyGoogleIdToken, type GoogleIdTokenErrorCode, type GoogleKeySource } from "../shared/google-id-token.ts";
import { singleCookie } from "./phone-auth.ts";
import type { Clock } from "./phone-relay/clock.ts";

export const GPAIR_COOKIE = "__Host-wink_gpair";
export const GPAIR_TTL_MS = 10 * 60_000;
const GPAIR_CONTEXT = "wink-gpair/1\0";
/** Open challenges kept in memory; the oldest goes first. */
export const MAX_CHALLENGES = 64;

export type GoogleSignInError = "unavailable" | "no-challenge" | "wrong-account" | GoogleIdTokenErrorCode;

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("base64url");

/** `m` in the sign-in link: names this browser's challenge without revealing it. */
export function challengeMark(challenge: string): string {
  return digest(GPAIR_CONTEXT + challenge);
}

/** The nonce the sign-in page asks Google for, bound to the label it forwards the token to. */
export function pairNonce(label: string, mark: string): string {
  return digest(`${GPAIR_CONTEXT}${label}\0${mark}`);
}

export function gpairSetCookie(challenge: string): string {
  return `${GPAIR_COOKIE}=${challenge}; Path=/; Max-Age=${GPAIR_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
}

export const GPAIR_CLEAR_COOKIE = `${GPAIR_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export function gpairCookie(cookieHeader: string | undefined): string | null {
  return singleCookie(cookieHeader, GPAIR_COOKIE);
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A phone admitted by Google. The token is the cookie value, kept only in memory. */
export interface GoogleAdmission {
  phone: { id: string; name: string };
  token: string;
}

interface ReplayEntry {
  challengeHash: string;
  credentialHash: string;
  expiresAt: number;
  /** Null once the phone was revoked or this PC's Google account changed. */
  admitted: GoogleAdmission | null;
}

export interface PhoneGoogleOptions {
  clock: Clock;
  /** The Web client id this build carries, or null. */
  webClientId: string | null;
  /** This PC's signed-in Google account, or null. */
  owner(): { sub: string } | null;
  keys: GoogleKeySource;
}

export class PhoneGoogle {
  private readonly options: PhoneGoogleOptions;
  /** digest(challenge) to expiry. The challenge itself lives only in the phone's cookie. */
  private readonly challenges = new Map<string, number>();
  /** digest(challenge) to the expiry verify consumed, until remember takes it. */
  private readonly spent = new Map<string, number>();
  /** One admission per challenge, oldest first. Digests only, never the cookie or the credential. */
  private readonly replays = new Map<string, ReplayEntry>();

  constructor(options: PhoneGoogleOptions) {
    this.options = options;
  }

  /** A Web client and a signed-in account, the PC's half of being able to take a Google sign-in. */
  configured(): boolean {
    return Boolean(this.options.webClientId && this.options.owner());
  }

  /** A fresh challenge: the cookie to set and the sign-in page link for `label`. */
  start(label: string, signinUrl: string) {
    const now = this.options.clock.now();
    for (const [key, expiresAt] of this.challenges) if (expiresAt <= now) this.challenges.delete(key);
    if (this.challenges.size >= MAX_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value!);
    const challenge = randomBytes(32).toString("base64url");
    this.challenges.set(digest(challenge), now + GPAIR_TTL_MS);
    const url = new URL(signinUrl);
    url.searchParams.set("pc", label);
    url.searchParams.set("m", challengeMark(challenge));
    return { cookie: gpairSetCookie(challenge), location: url.toString() };
  }

  /** Checks a phone's ID token against this browser's challenge and consumes the challenge. */
  async verify(challenge: string | null, credential: string, label: string): Promise<{ ok: true } | { ok: false; error: GoogleSignInError }> {
    const { webClientId, clock } = this.options;
    if (!webClientId || !this.options.owner()) return { ok: false, error: "unavailable" };
    const key = challenge ? digest(challenge) : null;
    const expiresAt = key ? this.challenges.get(key) : undefined;
    if (!challenge || !key || expiresAt === undefined || expiresAt <= clock.now()) return { ok: false, error: "no-challenge" };
    let sub: string;
    try {
      const token = await verifyGoogleIdToken(credential, [webClientId], this.options.keys, {
        now: clock.now(),
        nonce: pairNonce(label, challengeMark(challenge)),
      });
      sub = token.sub;
    } catch (error) {
      if (error instanceof GoogleIdTokenError) return { ok: false, error: error.code };
      throw error;
    }
    // Read again: the account may have changed while the keys loaded.
    const owner = this.options.owner();
    if (!owner) return { ok: false, error: "unavailable" };
    if (!sameText(sub, owner.sub)) return { ok: false, error: "wrong-account" };
    // Once per challenge, even for requests that raced through the key fetch.
    if (!key || !this.challenges.delete(key)) return { ok: false, error: "no-challenge" };
    this.hold(key, expiresAt);
    return { ok: true };
  }

  /** Keeps a finished admission until the challenge's own expiry. */
  remember(challenge: string, credential: string, admitted: GoogleAdmission): void {
    const key = digest(challenge);
    const expiresAt = this.spent.get(key);
    if (expiresAt === undefined || expiresAt <= this.options.clock.now()) return;
    this.spent.delete(key);
    const now = this.options.clock.now();
    for (const [replayKey, entry] of this.replays) if (entry.expiresAt <= now) this.replays.delete(replayKey);
    if (this.replays.size >= MAX_CHALLENGES) this.replays.delete(this.replays.keys().next().value!);
    this.replays.set(key, { challengeHash: key, credentialHash: digest(credential), expiresAt, admitted });
  }

  /** The stored admission, no-challenge if it was dropped, or null if this is not a repeat. */
  replay(challenge: string | null, credential: string): ({ ok: true } & GoogleAdmission) | { ok: false; error: "no-challenge" } | null {
    if (!challenge) return null;
    const now = this.options.clock.now();
    const challengeHash = digest(challenge);
    const credentialHash = digest(credential);
    for (const [key, entry] of this.replays) {
      if (entry.expiresAt <= now) {
        this.replays.delete(key);
        continue;
      }
      if (!sameText(entry.challengeHash, challengeHash)) continue;
      if (!entry.admitted || !sameText(entry.credentialHash, credentialHash)) return { ok: false, error: "no-challenge" };
      return { ok: true, phone: entry.admitted.phone, token: entry.admitted.token };
    }
    return null;
  }

  /** Forgets every admission. A repeat then answers no-challenge. */
  dropReplays(): void {
    for (const entry of this.replays.values()) entry.admitted = null;
  }

  /** Forgets the admission for one phone. */
  dropPhone(id: string): void {
    for (const entry of this.replays.values()) if (entry.admitted?.phone.id === id) entry.admitted = null;
  }

  private hold(key: string, expiresAt: number): void {
    const now = this.options.clock.now();
    for (const [spentKey, spentAt] of this.spent) if (spentAt <= now) this.spent.delete(spentKey);
    if (this.spent.size >= MAX_CHALLENGES) this.spent.delete(this.spent.keys().next().value!);
    this.spent.set(key, expiresAt);
  }
}
