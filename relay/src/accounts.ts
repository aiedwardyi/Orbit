// POST /v1/account {idToken, ticket, pk, sig} -> {account: wka1}.
// `sig` is by the PC key over UTF-8 JSON.stringify(["wink-relay-account/1", idToken, ticket, pk]).
// The desktop ID token must be under 10 minutes old. The relay never logs sub, email or the token.

import { sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  GOOGLE_CLOCK_SKEW_SEC,
  GoogleIdTokenError,
  googleSubHash,
  verifyGoogleIdToken,
  type GoogleIdToken,
  type GoogleKeySource,
} from "../../shared/google-id-token.ts";
import {
  ED25519_SIG_BYTES,
  labelForPublicKey,
  publicKeyFromRaw,
  rawPublicKey,
  signAccountTicket,
  verifyTicket,
} from "../../shared/relay-protocol.ts";
import { TICKET_TTL_SEC } from "./enroll.ts";

export const ACCOUNT_CONTEXT = "wink-relay-account/1";
/** A desktop ID token older than this is refused, before clock skew. */
export const ACCOUNT_TOKEN_MAX_AGE_SEC = 10 * 60;

const B64URL = /^[A-Za-z0-9_-]+$/;

export const accountRequestSchema = z.strictObject({
  idToken: z.string().min(1).max(8192),
  ticket: z.string().min(1).max(4096),
  pk: z.string().length(43).regex(B64URL),
  sig: z.string().length(86).regex(B64URL),
});

export type AccountRequest = z.infer<typeof accountRequestSchema>;

type Denied = { ok: false; status: number; error: string };

export type AccountResult = { ok: true; label: string; subHash: string; account: string } | Denied;

export type IdentityResult = { ok: true; subHash: string } | Denied;

type GoogleCheck = { ok: true; token: GoogleIdToken } | Denied;

export const BAD_ACCOUNT_REQUEST: AccountResult = { ok: false, status: 400, error: "bad-request" };

/** Bytes the account-registration signature covers. */
export function accountPayload(idToken: string, ticket: string, pk: string): Buffer {
  return Buffer.from(JSON.stringify([ACCOUNT_CONTEXT, idToken, ticket, pk]), "utf8");
}

/** PC side: signs a /v1/account request with the PC identity key. */
export function signAccountRequest(privateKey: KeyObject, idToken: string, ticket: string, pk: string): string {
  return sign(null, accountPayload(idToken, ticket, pk), privateKey).toString("base64url");
}

export interface AccountsOptions {
  desktopClientId: string;
  webClientId: string;
  keys: GoogleKeySource;
  operatorPrivateKey: KeyObject;
  operatorPublicKey: KeyObject;
  isRevoked: (label: string) => boolean;
  now?: () => number;
  ticketTtlSec?: number;
}

export class Accounts {
  private readonly opts: AccountsOptions;

  constructor(opts: AccountsOptions) {
    this.opts = opts;
  }

  /** Callers parse the body with accountRequestSchema first. */
  async register(req: AccountRequest): Promise<AccountResult> {
    const now = (this.opts.now ?? Date.now)();
    const opened = verifyTicket(req.ticket, this.opts.operatorPublicKey, { now });
    if (!opened.ok) return fail(403, opened.reason === "expired" ? "ticket-expired" : "ticket-invalid");

    const publicKey = publicKeyFromRaw(req.pk);
    if (!publicKey) return fail(400, "bad-key");
    const ticketKey = publicKeyFromRaw(opened.value.pk);
    if (!ticketKey || !rawPublicKey(publicKey).equals(rawPublicKey(ticketKey))) return fail(403, "key-mismatch");
    if (labelForPublicKey(rawPublicKey(publicKey)) !== opened.value.label) return fail(403, "label-mismatch");

    const sigBytes = Buffer.from(req.sig, "base64url");
    if (sigBytes.length !== ED25519_SIG_BYTES || !safeVerify(publicKey, accountPayload(req.idToken, req.ticket, req.pk), sigBytes)) {
      return fail(403, "bad-signature");
    }
    if (this.opts.isRevoked(opened.value.label)) return fail(403, "revoked");

    const claims = await this.google(req.idToken, [this.opts.desktopClientId], now);
    if (!claims.ok) return claims;
    const nowSec = Math.floor(now / 1000);
    // Skew is added so a clock a few minutes fast still accepts a token just issued on the PC.
    if (nowSec - claims.token.iat > ACCOUNT_TOKEN_MAX_AGE_SEC + GOOGLE_CLOCK_SKEW_SEC) return fail(403, "token-stale");

    const subHash = googleSubHash(claims.token.sub);
    const account = signAccountTicket(
      { label: opened.value.label, subHash, iat: nowSec, exp: nowSec + (this.opts.ticketTtlSec ?? TICKET_TTL_SEC) },
      this.opts.operatorPrivateKey,
    );
    return { ok: true, label: opened.value.label, subHash, account };
  }

  /** Web-client token for GET /v1/pcs. Age is the token's own exp, not the 10 minute desktop window. */
  async identity(idToken: string): Promise<IdentityResult> {
    const claims = await this.google(idToken, [this.opts.webClientId], (this.opts.now ?? Date.now)());
    if (!claims.ok) return claims;
    return { ok: true, subHash: googleSubHash(claims.token.sub) };
  }

  /** Web or desktop token for GET /v1/team: only a verified `email` (lowercase) passes. */
  async owner(idToken: string, email: string): Promise<IdentityResult> {
    const claims = await this.google(idToken, [this.opts.webClientId, this.opts.desktopClientId], (this.opts.now ?? Date.now)());
    if (!claims.ok) return claims;
    if (!claims.token.emailVerified || claims.token.email.toLowerCase() !== email) return fail(403, "not-owner");
    return { ok: true, subHash: googleSubHash(claims.token.sub) };
  }

  private async google(
    idToken: string,
    audiences: readonly string[],
    now: number,
  ): Promise<GoogleCheck> {
    try {
      const token = await verifyGoogleIdToken(idToken, audiences, this.opts.keys, { now });
      return { ok: true, token };
    } catch (error) {
      if (error instanceof GoogleIdTokenError) return googleFailure(error);
      return fail(403, "bad-token");
    }
  }
}

function googleFailure(error: GoogleIdTokenError): GoogleCheck {
  if (error.code === "bad-audience") return fail(403, "bad-audience");
  if (error.code === "bad-issuer") return fail(403, "bad-issuer");
  if (error.code === "expired") return fail(403, "token-expired");
  return fail(403, "bad-token");
}

function safeVerify(key: KeyObject, data: Buffer, sig: Buffer): boolean {
  try {
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}

function fail(status: number, error: string): Denied {
  return { ok: false, status, error };
}
