import { createHmac, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CLOCK_SKEW_SEC,
  GOOGLE_DISCOVERY_URL,
  GoogleIdTokenError,
  googleDiscoveryKeySource,
  googleSubHash,
  verifyGoogleIdToken,
  type GoogleKeySource,
  type GooglePublicJwk,
} from "./google-id-token.ts";

const AUDIENCE = "web-client.apps.googleusercontent.com";

function rsaKey(): KeyObject {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
}

function publicJwk(privateKey: KeyObject, kid: string): GooglePublicJwk {
  const exported = createPublicKey(privateKey).export({ format: "jwk" });
  if (exported.kty !== "RSA" || !exported.n || !exported.e) throw new Error("expected an RSA jwk");
  return { kid, jwk: { kty: "RSA", n: exported.n, e: exported.e, alg: "RS256", kid } };
}

function sourceOf(...keys: GooglePublicJwk[]): GoogleKeySource & { calls: number } {
  return {
    calls: 0,
    async keys() {
      this.calls += 1;
      return keys;
    },
  };
}

interface TokenClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  iat?: number;
  exp?: number;
  nonce?: string;
}

interface JwtHeader {
  alg: string;
  kid: string;
  typ: string;
}

function encode(value: JwtHeader | TokenClaims): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signToken(
  privateKey: KeyObject,
  payload: TokenClaims,
  opts: { kid?: string; alg?: string; sig?: "flip" | "hmac" | "empty" } = {},
): string {
  const alg = opts.alg ?? "RS256";
  const input = `${encode({ alg, kid: opts.kid ?? "kid-1", typ: "JWT" })}.${encode(payload)}`;
  if (opts.sig === "empty" || alg === "none") return `${input}.`;
  if (opts.sig === "hmac" || alg === "HS256") return `${input}.${createHmac("sha256", "secret").update(input).digest("base64url")}`;
  const sig = sign("RSA-SHA256", Buffer.from(input, "ascii"), privateKey);
  if (opts.sig === "flip") sig[0] ^= 0xff;
  return `${input}.${sig.toString("base64url")}`;
}

function claims(over: TokenClaims = {}): TokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    sub: "1001",
    email: "ada@example.com",
    email_verified: true,
    iat: now,
    exp: now + 3600,
    ...over,
  };
}

async function verify(token: string, keys: GoogleKeySource, options: { now?: number; skewSec?: number; nonce?: string } = {}) {
  return verifyGoogleIdToken(token, [AUDIENCE], keys, options);
}

describe("Google ID tokens", () => {
  it("returns the claims of a valid RS256 token", async () => {
    const key = rsaKey();
    const keys = sourceOf(publicJwk(key, "kid-1"));
    const now = 1_700_000_000_000;
    const token = signToken(key, claims({ iat: 1_700_000_000, exp: 1_700_003_600, nonce: "n-1" }));
    await expect(verify(token, keys, { now })).resolves.toEqual({
      sub: "1001",
      email: "ada@example.com",
      emailVerified: true,
      aud: AUDIENCE,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
      nonce: "n-1",
    });
    expect(keys.calls).toBe(1);
    expect(googleSubHash("1001")).toHaveLength(43);
    expect(googleSubHash("1001")).not.toContain("1001");
  });

  it("rejects a bad signature", async () => {
    const key = rsaKey();
    const token = signToken(key, claims(), { sig: "flip" });
    await expect(verify(token, sourceOf(publicJwk(key, "kid-1")))).rejects.toMatchObject({
      name: "GoogleIdTokenError",
      code: "bad-signature",
    });
  });

  it("rejects alg none without looking for a key", async () => {
    const key = rsaKey();
    const keys = sourceOf(publicJwk(key, "kid-1"));
    const token = signToken(key, claims(), { alg: "none", sig: "empty" });
    await expect(verify(token, keys)).rejects.toMatchObject({ code: "unsupported-alg" });
    expect(keys.calls).toBe(0);
    expect(token.endsWith(".")).toBe(true);
  });

  it("rejects HS256 without using the key as an HMAC secret", async () => {
    const key = rsaKey();
    const keys = sourceOf(publicJwk(key, "kid-1"));
    await expect(verify(signToken(key, claims(), { alg: "HS256" }), keys)).rejects.toMatchObject({ code: "unsupported-alg" });
    expect(keys.calls).toBe(0);
  });

  it("refetches JWKS once when the kid is unknown, then accepts the token", async () => {
    const key = rsaKey();
    const right = publicJwk(key, "kid-new");
    const pages = [[publicJwk(rsaKey(), "kid-old")], [right]];
    let calls = 0;
    const keys: GoogleKeySource = {
      async keys(refresh) {
        expect(refresh).toBe(calls > 0);
        const page = pages[calls] ?? [];
        calls += 1;
        return page;
      },
    };
    await expect(verify(signToken(key, claims(), { kid: "kid-new" }), keys)).resolves.toMatchObject({ sub: "1001" });
    expect(calls).toBe(2);
  });

  it("rejects an unknown kid after that one refetch", async () => {
    const key = rsaKey();
    let calls = 0;
    const keys: GoogleKeySource = {
      async keys(refresh) {
        expect(refresh).toBe(calls > 0);
        calls += 1;
        return [publicJwk(key, "other")];
      },
    };
    await expect(verify(signToken(key, claims(), { kid: "missing" }), keys)).rejects.toMatchObject({ code: "unknown-kid" });
    expect(calls).toBe(2);
  });

  it("rejects the wrong issuer", async () => {
    const key = rsaKey();
    const keys = sourceOf(publicJwk(key, "kid-1"));
    await expect(verify(signToken(key, claims({ iss: "https://evil.example" })), keys)).rejects.toMatchObject({ code: "bad-issuer" });
    await expect(verify(signToken(key, claims({ iss: "accounts.google.com.evil" })), keys)).rejects.toMatchObject({
      code: "bad-issuer",
    });
  });

  it("rejects the wrong audience", async () => {
    const key = rsaKey();
    const token = signToken(key, claims({ aud: "desktop-client.apps.googleusercontent.com" }));
    await expect(verify(token, sourceOf(publicJwk(key, "kid-1")))).rejects.toMatchObject({ code: "bad-audience" });
  });

  it("rejects an expired token", async () => {
    const key = rsaKey();
    const now = 1_700_000_000_000;
    const token = signToken(key, claims({ iat: 1_699_000_000, exp: 1_699_003_600 }));
    await expect(verify(token, sourceOf(publicJwk(key, "kid-1")), { now })).rejects.toMatchObject({ code: "expired" });
  });

  it("allows exp and iat inside the skew and rejects them past it", async () => {
    const key = rsaKey();
    const keys = sourceOf(publicJwk(key, "kid-1"));
    const nowSec = 1_700_000_000;
    const now = nowSec * 1000;
    const lateExp = signToken(key, claims({ iat: nowSec - 3600, exp: nowSec - GOOGLE_CLOCK_SKEW_SEC + 1 }));
    await expect(verify(lateExp, keys, { now })).resolves.toMatchObject({ sub: "1001" });
    const earlyIat = signToken(key, claims({ iat: nowSec + GOOGLE_CLOCK_SKEW_SEC - 1, exp: nowSec + 3600 }));
    await expect(verify(earlyIat, keys, { now })).resolves.toMatchObject({ sub: "1001" });
    const expired = signToken(key, claims({ iat: nowSec - 3600, exp: nowSec - GOOGLE_CLOCK_SKEW_SEC - 1 }));
    await expect(verify(expired, keys, { now })).rejects.toMatchObject({ code: "expired" });
    const early = signToken(key, claims({ iat: nowSec + GOOGLE_CLOCK_SKEW_SEC + 5, exp: nowSec + 3600 }));
    await expect(verify(early, keys, { now })).rejects.toMatchObject({ code: "not-yet-valid" });
  });

  it("rejects malformed tokens", async () => {
    const key = rsaKey();
    const keys = sourceOf(publicJwk(key, "kid-1"));
    const good = signToken(key, claims());
    const [head, , sig] = good.split(".");
    for (const token of ["", "a.b", "a.b.c", `${head}.!!! .${sig}`, good.slice(0, -4)]) {
      await expect(verify(token, keys)).rejects.toBeInstanceOf(GoogleIdTokenError);
    }
    const missingExp = signToken(key, { iss: "https://accounts.google.com", aud: AUDIENCE, sub: "1001", iat: 1 });
    await expect(verify(missingExp, keys)).rejects.toMatchObject({ code: "malformed" });
  });

  it("checks nonce only when the caller expects one", async () => {
    const key = rsaKey();
    const keys = sourceOf(publicJwk(key, "kid-1"));
    const token = signToken(key, claims({ nonce: "expected" }));
    await expect(verify(token, keys)).resolves.toMatchObject({ nonce: "expected" });
    await expect(verify(token, keys, { nonce: "expected" })).resolves.toMatchObject({ nonce: "expected" });
    await expect(verify(token, keys, { nonce: "other" })).rejects.toMatchObject({ code: "nonce-mismatch" });
    const bare = signToken(key, claims());
    await expect(verify(bare, keys, { nonce: "expected" })).rejects.toMatchObject({ code: "nonce-mismatch" });
  });

  it("fetches JWKS from the discovery jwks_uri, caches it, and refuses another host", async () => {
    const fetched: string[] = [];
    const jwk = publicJwk(rsaKey(), "k1").jwk;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === GOOGLE_DISCOVERY_URL) {
        return Response.json({ jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" });
      }
      if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
      if (url === "https://accounts.google.com/.well-known/openid-configuration") {
        return Response.json({ jwks_uri: "https://evil.example/certs" });
      }
      return new Response("no", { status: 404 });
    };
    const keys = googleDiscoveryKeySource(fetchImpl);
    expect(await keys.keys(false)).toEqual([expect.objectContaining({ kid: "k1" })]);
    await keys.keys(false);
    expect(fetched).toEqual([GOOGLE_DISCOVERY_URL, "https://www.googleapis.com/oauth2/v3/certs"]);
    await keys.keys(true);
    expect(fetched).toHaveLength(4);

    let discoveryHits = 0;
    const foreign = googleDiscoveryKeySource(async (input) => {
      discoveryHits += 1;
      expect(String(input)).toBe(GOOGLE_DISCOVERY_URL);
      return Response.json({ jwks_uri: "https://evil.example/certs" });
    });
    await expect(foreign.keys(false)).rejects.toMatchObject({ code: "key-source" });
    expect(discoveryHits).toBe(1);
  });

  it("refetches an unknown kid once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = 1_700_000_000_000;
    vi.setSystemTime(start);
    try {
      let jwksHits = 0;
      const jwk = publicJwk(rsaKey(), "k1").jwk;
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url === GOOGLE_DISCOVERY_URL) return Response.json({ jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" });
        jwksHits += 1;
        return Response.json({ keys: [jwk] });
      };
      const keys = googleDiscoveryKeySource(fetchImpl);
      const token = signToken(rsaKey(), claims(), { kid: "missing" });
      for (let i = 0; i < 5; i++) await expect(verify(token, keys)).rejects.toMatchObject({ code: "unknown-kid" });
      expect(jwksHits).toBe(2);
      vi.setSystemTime(start + 60_000);
      await expect(verify(token, keys)).rejects.toMatchObject({ code: "unknown-kid" });
      expect(jwksHits).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches when the JWKS max-age ends, clamped between 5 minutes and 24 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = 1_700_000_000_000;
    vi.setSystemTime(start);
    try {
      const jwk = publicJwk(rsaKey(), "k1").jwk;
      const source = (maxAge: string | null) => {
        let jwksHits = 0;
        const fetchImpl: typeof fetch = async (input) => {
          const url = String(input);
          if (url === GOOGLE_DISCOVERY_URL) return Response.json({ jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" });
          jwksHits += 1;
          const headers: Record<string, string> = {};
          if (maxAge !== null) headers["cache-control"] = `public, max-age=${maxAge}`;
          return new Response(JSON.stringify({ keys: [jwk] }), { headers });
        };
        return { keys: googleDiscoveryKeySource(fetchImpl), hits: () => jwksHits };
      };
      const aged = source("300");
      await aged.keys.keys(false);
      vi.setSystemTime(start + 300_000 - 1);
      await aged.keys.keys(false);
      expect(aged.hits()).toBe(1);
      vi.setSystemTime(start + 300_000);
      await aged.keys.keys(false);
      expect(aged.hits()).toBe(2);

      vi.setSystemTime(start);
      const floored = source("1");
      await floored.keys.keys(false);
      vi.setSystemTime(start + 60_000);
      await floored.keys.keys(false);
      expect(floored.hits()).toBe(1);
      vi.setSystemTime(start + 300_000);
      await floored.keys.keys(false);
      expect(floored.hits()).toBe(2);

      vi.setSystemTime(start);
      const capped = source("1000000");
      await capped.keys.keys(false);
      vi.setSystemTime(start + 86_400_000 - 1);
      await capped.keys.keys(false);
      expect(capped.hits()).toBe(1);
      vi.setSystemTime(start + 86_400_000);
      await capped.keys.keys(false);
      expect(capped.hits()).toBe(2);

      vi.setSystemTime(start);
      const fallback = source(null);
      await fallback.keys.keys(false);
      vi.setSystemTime(start + 3_600_000 - 1);
      await fallback.keys.keys(false);
      expect(fallback.hits()).toBe(1);
      vi.setSystemTime(start + 3_600_000);
      await fallback.keys.keys(false);
      expect(fallback.hits()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the cached keys when a refetch fails", async () => {
    let fail = false;
    let jwksHits = 0;
    const jwk = publicJwk(rsaKey(), "k1").jwk;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === GOOGLE_DISCOVERY_URL) return Response.json({ jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" });
      jwksHits += 1;
      if (fail) return new Response("no", { status: 503 });
      return Response.json({ keys: [jwk] });
    };
    const keys = googleDiscoveryKeySource(fetchImpl);
    const first = await keys.keys(false);
    fail = true;
    await expect(keys.keys(true)).resolves.toEqual(first);
    const hits = jwksHits;
    await expect(keys.keys(true)).resolves.toEqual(first);
    expect(jwksHits).toBe(hits);
  });

  it("shares one in-flight fetch across concurrent callers", async () => {
    let discoveryHits = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jwk = publicJwk(rsaKey(), "k1").jwk;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === GOOGLE_DISCOVERY_URL) {
        discoveryHits += 1;
        await gate;
        return Response.json({ jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" });
      }
      return Response.json({ keys: [jwk] });
    };
    const keys = googleDiscoveryKeySource(fetchImpl);
    const pending = Promise.all([keys.keys(false), keys.keys(false)]);
    expect(discoveryHits).toBe(1);
    release();
    const [a, b] = await pending;
    expect(discoveryHits).toBe(1);
    expect(a).toEqual(b);
    expect(a).toEqual([expect.objectContaining({ kid: "k1" })]);
  });
});
