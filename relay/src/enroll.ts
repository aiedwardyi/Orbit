// POST /v1/enroll {invite, pk, sig} -> {ticket} (design section 4).
// `sig` is by the PC key over UTF-8 JSON.stringify(["wink-relay-enroll/1", invite, pk]).

import { sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  ED25519_SIG_BYTES,
  labelForPublicKey,
  publicKeyFromRaw,
  rawPublicKey,
  signTicket,
  verifyInvite,
} from "../../shared/relay-protocol.ts";
import type { InviteStore } from "./invites.ts";

export const ENROLL_CONTEXT = "wink-relay-enroll/1";
export const TICKET_TTL_SEC = 365 * 24 * 60 * 60;

/** Bytes the enrollment signature covers. */
export function enrollPayload(invite: string, pk: string): Buffer {
  return Buffer.from(JSON.stringify([ENROLL_CONTEXT, invite, pk]), "utf8");
}

/** PC side: signs an enrollment request with the PC identity key. */
export function signEnrollment(privateKey: KeyObject, invite: string, pk: string): string {
  return sign(null, enrollPayload(invite, pk), privateKey).toString("base64url");
}

const B64URL = /^[A-Za-z0-9_-]+$/;
export const enrollRequestSchema = z.strictObject({
  invite: z.string().min(1).max(2048),
  pk: z.string().length(43).regex(B64URL),
  sig: z.string().length(86).regex(B64URL),
});

export type EnrollRequest = z.infer<typeof enrollRequestSchema>;

export type EnrollResult =
  | { ok: true; label: string; ticket: string }
  | { ok: false; status: number; error: string };

/** The result for a body that does not parse as an EnrollRequest. */
export const BAD_REQUEST: EnrollResult = { ok: false, status: 400, error: "bad-request" };

export interface EnrollerOptions {
  operatorPrivateKey: KeyObject;
  operatorPublicKey: KeyObject;
  store: InviteStore;
  isRevoked: (label: string) => boolean;
  now?: () => number;
  ticketTtlSec?: number;
}

export class Enroller {
  private readonly opts: EnrollerOptions;

  constructor(opts: EnrollerOptions) {
    this.opts = opts;
  }

  /** Callers parse the body with enrollRequestSchema first (BAD_REQUEST when it fails). */
  async enroll(req: EnrollRequest): Promise<EnrollResult> {
    const now = (this.opts.now ?? Date.now)();
    const { invite, pk, sig } = req;

    const opened = verifyInvite(invite, this.opts.operatorPublicKey, { now });
    if (!opened.ok) return fail(403, opened.reason === "expired" ? "invite-expired" : "invite-invalid");

    const publicKey = publicKeyFromRaw(pk);
    if (!publicKey) return fail(400, "bad-key");
    const sigBytes = Buffer.from(sig, "base64url");
    if (sigBytes.length !== ED25519_SIG_BYTES || !safeVerify(publicKey, enrollPayload(invite, pk), sigBytes)) {
      return fail(403, "bad-signature");
    }
    const raw = rawPublicKey(publicKey);
    const label = labelForPublicKey(raw);
    if (this.opts.isRevoked(label)) return fail(403, "revoked");

    // Every check above is synchronous and done; mark the invite used now.
    try {
      if (!this.opts.store.consume(opened.value.nonce, opened.value.exp)) return fail(409, "invite-used");
    } catch {
      return fail(503, "store-unavailable");
    }

    const iat = Math.floor(now / 1000);
    const ticket = signTicket(
      { label, pk: raw.toString("base64url"), iat, exp: iat + (this.opts.ticketTtlSec ?? TICKET_TTL_SEC) },
      this.opts.operatorPrivateKey,
    );
    try {
      await this.opts.store.persist(opened.value.nonce, opened.value.exp);
    } catch {
      // Stays consumed in memory: a failed write never makes an invite reusable.
      return fail(503, "store-unavailable");
    }
    return { ok: true, label, ticket };
  }
}

function safeVerify(key: KeyObject, data: Buffer, sig: Buffer): boolean {
  try {
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}

function fail(status: number, error: string): EnrollResult {
  return { ok: false, status, error };
}
