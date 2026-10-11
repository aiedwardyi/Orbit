// Google ID token check for the phone sign-in flow. Node crypto only.
// GP-2 imports verifyGoogleIdToken. The relay uses it for /v1/account and /v1/pcs.

import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";

export const GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration";
/** Allowed clock difference, in seconds. Same window as the relay tickets. */
export const GOOGLE_CLOCK_SKEW_SEC = 300;

const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_CHARS = 8192;

export const GOOGLE_ID_TOKEN_ERRORS = [
  "malformed",
  "unsupported-alg",
  "bad-signature",
  "unknown-kid",
  "bad-issuer",
  "bad-audience",
  "expired",
  "not-yet-valid",
  "nonce-mismatch",
  "key-source",
] as const;

export type GoogleIdTokenErrorCode = (typeof GOOGLE_ID_TOKEN_ERRORS)[number];

export class GoogleIdTokenError extends Error {
  readonly code: GoogleIdTokenErrorCode;

  constructor(code: GoogleIdTokenErrorCode) {
    super(code);
    this.name = "GoogleIdTokenError";
    this.code = code;
  }
}

export interface GoogleIdToken {
  sub: string;
  email: string;
  emailVerified: boolean;
  aud: string;
  iat: number;
  exp: number;
  /** Null when the token carries no nonce. */
  nonce: string | null;
}

/** RSA public JWK. `d` is never kept. */
export interface GoogleRsaJwk {
  kty: "RSA";
  n: string;
  e: string;
  alg?: "RS256";
  kid?: string;
}

export interface GooglePublicJwk {
  kid: string;
  jwk: GoogleRsaJwk;
}

/** `keys(true)` refetches. Tests inject this; production uses googleDiscoveryKeySource. */
export interface GoogleKeySource {
  keys(refresh: boolean): Promise<readonly GooglePublicJwk[]>;
}

export interface VerifyGoogleIdTokenOptions {
  /** Current time in ms since epoch. Defaults to Date.now(). */
  now?: number;
  /** Clock skew in seconds. Defaults to GOOGLE_CLOCK_SKEW_SEC. */
  skewSec?: number;
  /** When set, the token nonce must match. Omit to skip the check. */
  nonce?: string;
}

const headerSchema = z.object({
  alg: z.string(),
  kid: z.string().min(1).max(256).optional(),
  typ: z.string().optional(),
});

const payloadSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  exp: z.int(),
  iat: z.int(),
  sub: z.string().min(1).max(255),
  email: z.string().max(320).optional(),
  email_verified: z.boolean().optional(),
  nonce: z.string().max(512).optional(),
});

type JwtHeader = z.infer<typeof headerSchema>;
type JwtPayload = z.infer<typeof payloadSchema>;

/** base64url(sha256(utf8 sub)). Directory keys and wka1 store this, never `sub`. */
export function googleSubHash(sub: string): string {
  return createHash("sha256").update(sub, "utf8").digest("base64url");
}

function parseJson(text: string): z.core.util.JSONType | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function decodePart<T>(part: string, schema: z.ZodType<T>): T | undefined {
  if (!B64URL_RE.test(part)) return undefined;
  const json = parseJson(Buffer.from(part, "base64url").toString("utf8"));
  if (json === undefined) return undefined;
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function findKey(keys: readonly GooglePublicJwk[], kid: string): GoogleRsaJwk | undefined {
  for (const key of keys) {
    if (key.kid !== kid || key.jwk.kty !== "RSA") continue;
    if (key.jwk.alg && key.jwk.alg !== "RS256") continue;
    if (!key.jwk.n || !key.jwk.e) continue;
    return key.jwk;
  }
  return undefined;
}

async function loadKeys(keys: GoogleKeySource, refresh: boolean): Promise<readonly GooglePublicJwk[]> {
  try {
    return await keys.keys(refresh);
  } catch (error) {
    if (error instanceof GoogleIdTokenError) throw error;
    throw new GoogleIdTokenError("key-source");
  }
}

function audiencesOf(aud: JwtPayload["aud"]): string[] {
  return Array.isArray(aud) ? aud : [aud];
}

function sameNonce(got: string, want: string): boolean {
  const left = Buffer.from(got);
  const right = Buffer.from(want);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verifies one Google ID token.
 * `audiences` is the allowed client id list. Throws GoogleIdTokenError.
 */
export async function verifyGoogleIdToken(
  token: string,
  audiences: readonly string[],
  keys: GoogleKeySource,
  options: VerifyGoogleIdTokenOptions = {},
): Promise<GoogleIdToken> {
  if (token.length < 5 || token.length > MAX_TOKEN_CHARS) throw new GoogleIdTokenError("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || parts[2] === undefined) throw new GoogleIdTokenError("malformed");
  const header: JwtHeader | undefined = decodePart(parts[0], headerSchema);
  if (!header) throw new GoogleIdTokenError("malformed");
  // Fixed before any key is loaded, so `none` and HMAC cannot choose the verifier.
  if (header.alg !== "RS256") throw new GoogleIdTokenError("unsupported-alg");
  if (!header.kid) throw new GoogleIdTokenError("malformed");
  if (!B64URL_RE.test(parts[2])) throw new GoogleIdTokenError("malformed");
  const signature = Buffer.from(parts[2], "base64url");
  if (signature.length === 0) throw new GoogleIdTokenError("malformed");

  let jwk = findKey(await loadKeys(keys, false), header.kid);
  if (!jwk) jwk = findKey(await loadKeys(keys, true), header.kid);
  if (!jwk) throw new GoogleIdTokenError("unknown-kid");

  let ok = false;
  try {
    // Only n and e: a JWK that also carries `d` must not be imported.
    const publicKey = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), publicKey, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new GoogleIdTokenError("bad-signature");

  const payload = decodePart(parts[1], payloadSchema);
  if (!payload || payload.exp < payload.iat) throw new GoogleIdTokenError("malformed");
  if (!ISSUERS.has(payload.iss)) throw new GoogleIdTokenError("bad-issuer");
  const aud = audiences.find((candidate) => audiencesOf(payload.aud).includes(candidate));
  if (!aud) throw new GoogleIdTokenError("bad-audience");

  const skew = options.skewSec ?? GOOGLE_CLOCK_SKEW_SEC;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (payload.exp + skew <= now) throw new GoogleIdTokenError("expired");
  if (payload.iat - skew > now) throw new GoogleIdTokenError("not-yet-valid");
  if (options.nonce !== undefined && !sameNonce(payload.nonce ?? "", options.nonce)) {
    throw new GoogleIdTokenError("nonce-mismatch");
  }

  return {
    sub: payload.sub,
    email: payload.email ?? "",
    emailVerified: payload.email_verified === true,
    aud,
    iat: payload.iat,
    exp: payload.exp,
    nonce: payload.nonce ?? null,
  };
}

const discoverySchema = z.object({ jwks_uri: z.string().min(1).max(300) });
const jwkSchema = z.object({
  kty: z.string(),
  kid: z.string().min(1).max(256).optional(),
  n: z.string().min(1).max(4096).optional(),
  e: z.string().min(1).max(32).optional(),
  alg: z.string().max(16).optional(),
  use: z.string().max(16).optional(),
});
const jwksSchema = z.object({ keys: z.array(jwkSchema).max(32) });

function allowedJwksUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  return url.hostname === "www.googleapis.com" || url.hostname === "accounts.google.com";
}

const MIN_MAX_AGE_SEC = 5 * 60;
const MAX_MAX_AGE_SEC = 24 * 60 * 60;
const DEFAULT_MAX_AGE_SEC = 60 * 60;
const KID_REFRESH_MS = 60_000;

function maxAgeMs(header: string | null): number {
  const match = /(?:^|[,\s])max-age=(\d+)/i.exec(header ?? "");
  const parsed = match ? Number(match[1]) : DEFAULT_MAX_AGE_SEC;
  const sec = Math.min(MAX_MAX_AGE_SEC, Math.max(MIN_MAX_AGE_SEC, parsed));
  return sec * 1000;
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<z.core.util.JSONType | undefined> {
  const fetched = await fetchText(fetchImpl, url);
  return fetched ? parseJson(fetched.text) : undefined;
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ text: string; cacheControl: string | null } | undefined> {
  try {
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const text = await response.text();
    if (text.length > 256 * 1024) return undefined;
    return { text, cacheControl: response.headers.get("cache-control") };
  } catch {
    return undefined;
  }
}

async function loadGoogleKeys(fetchImpl: typeof fetch): Promise<{ keys: GooglePublicJwk[]; maxAgeMs: number }> {
  const discovery = discoverySchema.safeParse(await fetchJson(fetchImpl, GOOGLE_DISCOVERY_URL));
  if (!discovery.success || !allowedJwksUrl(discovery.data.jwks_uri)) throw new GoogleIdTokenError("key-source");
  const fetched = await fetchText(fetchImpl, discovery.data.jwks_uri);
  const jwks = jwksSchema.safeParse(fetched ? parseJson(fetched.text) : undefined);
  if (!fetched || !jwks.success) throw new GoogleIdTokenError("key-source");
  const keys: GooglePublicJwk[] = [];
  for (const key of jwks.data.keys) {
    if (key.kty !== "RSA" || !key.kid || !key.n || !key.e) continue;
    if ((key.alg && key.alg !== "RS256") || (key.use && key.use !== "sig")) continue;
    keys.push({ kid: key.kid, jwk: { kty: "RSA", n: key.n, e: key.e, alg: "RS256", kid: key.kid } });
  }
  if (keys.length === 0) throw new GoogleIdTokenError("key-source");
  return { keys, maxAgeMs: maxAgeMs(fetched.cacheControl) };
}

/** Cached JWKS from Google's discovery document.
 * `keys(true)` refetches at most once a minute. A failed refetch keeps the previous keys.
 */
export function googleDiscoveryKeySource(fetchImpl: typeof fetch = globalThis.fetch): GoogleKeySource {
  let cached: GooglePublicJwk[] | null = null;
  let freshUntil = 0;
  let kidRefreshUntil = 0;
  let retryUntil = 0;
  let inflight: Promise<readonly GooglePublicJwk[]> | null = null;

  function begin(): Promise<readonly GooglePublicJwk[]> {
    if (inflight) return inflight;
    const run = (async () => {
      try {
        const loaded = await loadGoogleKeys(fetchImpl);
        cached = loaded.keys;
        freshUntil = Date.now() + loaded.maxAgeMs;
        return loaded.keys;
      } catch (error) {
        if (cached) {
          retryUntil = Date.now() + KID_REFRESH_MS;
          return cached;
        }
        throw error;
      } finally {
        inflight = null;
      }
    })();
    inflight = run;
    return run;
  }

  return {
    async keys(refresh) {
      if (inflight) return inflight;
      const now = Date.now();
      if (cached && !refresh && now < freshUntil) return cached;
      if (cached && !refresh && now < retryUntil) return cached;
      if (refresh && cached && now < kidRefreshUntil) return cached;
      if (refresh) kidRefreshUntil = now + KID_REFRESH_MS;
      return begin();
    },
  };
}
