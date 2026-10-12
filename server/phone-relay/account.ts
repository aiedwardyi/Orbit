// Registers this PC under its Google account in the relay directory (GP-1),
// so a phone signed in to the same account can find it. The relay only
// lists PCs; this PC still decides which phones get in.

import { sign } from "node:crypto";
import { z } from "zod";

import { googleSubHash } from "../../shared/google-id-token.ts";
import { httpsRequest, type HttpsDeps } from "./https.ts";
import { relayHostFor } from "./mode.ts";
import { accountProblem, type Identity } from "./store.ts";

export const ACCOUNT_CONTEXT = "wink-relay-account/1";
export const ACCOUNT_TIMEOUT_MS = 15_000;
export const ACCOUNT_MAX_BYTES = 16 * 1024;
/** The relay refuses a Desktop ID token older than this. */
export const ACCOUNT_TOKEN_MAX_AGE_MS = 10 * 60_000;

const accountResponseSchema = z.object({ account: z.string().min(1).max(4096) });
const accountErrorSchema = z.object({ error: z.string().regex(/^[a-z0-9-]{1,64}$/) });
const idTokenClaimsSchema = z.object({ sub: z.string().min(1), iat: z.number() });

/** Bytes the account signature covers. */
export function accountPayload(idToken: string, ticket: string, pk: string): Buffer {
  return Buffer.from(JSON.stringify([ACCOUNT_CONTEXT, idToken, ticket, pk]), "utf8");
}

/** sub and issue time (ms) of a token Google handed the desktop shell, unverified. */
export function idTokenClaims(idToken: string): { sub: string; iat: number } | null {
  const part = idToken.split(".")[1];
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const claims = idTokenClaimsSchema.safeParse(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
    return claims.success ? { sub: claims.data.sub, iat: claims.data.iat * 1000 } : null;
  } catch {
    return null;
  }
}

export interface RegisterAccountOptions {
  base: string;
  identity: Identity;
  ticket: string;
  idToken: string;
  sub: string;
  now: number;
}

/** Trades a fresh Desktop ID token for a wka1. Throws with a short reason. */
export async function registerAccount(options: RegisterAccountOptions, https?: HttpsDeps): Promise<string> {
  const { identity, ticket, idToken } = options;
  const sig = sign(null, accountPayload(idToken, ticket, identity.pk), identity.privateKey).toString("base64url");
  const res = await httpsRequest(
    {
      method: "POST",
      url: `https://${relayHostFor(options.base)}/v1/account`,
      body: JSON.stringify({ idToken, ticket, pk: identity.pk, sig }),
      timeoutMs: ACCOUNT_TIMEOUT_MS,
      maxBytes: ACCOUNT_MAX_BYTES,
    },
    https,
  );
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString("utf8"));
  } catch {
    body = undefined;
  }
  if (res.status !== 200) {
    const code = accountErrorSchema.safeParse(body);
    throw new Error(`relay refused the account (${res.status}${code.success ? ` ${code.data.error}` : ""})`);
  }
  const parsed = accountResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("relay sent an unreadable account answer");
  const problem = accountProblem(parsed.data.account, identity, googleSubHash(options.sub), options.now);
  if (problem) throw new Error(`relay sent an unusable account ticket: ${problem}`);
  return parsed.data.account;
}
