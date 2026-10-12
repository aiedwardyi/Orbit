// Owner team stats for Settings. The relay stays the source of truth.

import { createHash } from "node:crypto";

import { RELAY_BASE_RE } from "../shared/relay-protocol.ts";
import { ACCOUNT_TIMEOUT_MS, ACCOUNT_TOKEN_MAX_AGE_MS, idTokenClaims } from "./phone-relay/account.ts";
import { relayHostFor } from "./phone-relay/mode.ts";

export interface TeamTokenSource {
  idToken(): string | null;
  freshIdToken(): Promise<string | null>;
}

const denied = { status: 403, body: { owner: false } };

/** Enrolled base wins. A baked value may be a base or an https relay origin. */
export function teamRelayOrigin(enrolledBase: string | null, baked: string | null): string | null {
  const chosen = (enrolledBase || baked || "").trim().toLowerCase();
  if (!chosen || chosen.startsWith("http://")) return null;
  const host = (chosen.startsWith("https://") ? chosen.slice("https://".length) : chosen).split("/")[0] ?? "";
  const base = host.startsWith("relay.") ? host.slice("relay.".length) : host;
  if (!RELAY_BASE_RE.test(base)) return null;
  return `https://${relayHostFor(base)}`;
}

/** sha256 hex of the trimmed lowercase email. The bake stores this, never the email. */
export function teamOwnerHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** Held token only while it is as fresh as a relay account registration, else refresh. */
export async function teamIdToken(source: TeamTokenSource, now: () => number = Date.now): Promise<string | null> {
  const held = source.idToken();
  const claims = held ? idTokenClaims(held) : null;
  if (held && claims && now() - claims.iat <= ACCOUNT_TOKEN_MAX_AGE_MS) return held;
  try {
    return (await source.freshIdToken()) || source.idToken();
  } catch {
    return source.idToken();
  }
}

export async function teamRoute(
  enrolledBase: string | null,
  baked: string | null,
  ownerHash: string | null,
  email: string | null,
  source: TeamTokenSource,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<{ status: number; body: unknown }> {
  const origin = teamRelayOrigin(enrolledBase, baked);
  const session = (email ?? "").trim();
  const bakedOwner = (ownerHash ?? "").trim().toLowerCase();
  if (!origin || !bakedOwner || !session || teamOwnerHash(session) !== bakedOwner) return denied;
  const token = await teamIdToken(source, now);
  if (!token) return denied;
  const tz = -new Date(now()).getTimezoneOffset();
  try {
    const response = await fetchImpl(`${origin}/v1/team?tz=${tz}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
    });
    if (!response.ok) return denied;
    return { status: 200, body: await response.json() };
  } catch {
    return denied;
  }
}
