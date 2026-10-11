// In-process RSA issuer for account-directory tests. No network.

import { createHmac, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export interface IssuerKey {
  kid: string;
  jwk: { kty: "RSA"; n: string; e: string; alg: "RS256"; kid: string };
}

export interface IdClaims {
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
  typ: "JWT";
}

export interface TestIssuer {
  readonly kid: string;
  keys(refresh: boolean): Promise<readonly IssuerKey[]>;
  sign(claims: IdClaims, opts?: { alg?: string; kid?: string }): string;
}

export function makeIssuer(): TestIssuer {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-kid";
  const exported = createPublicKey(privateKey).export({ format: "jwk" });
  if (exported.kty !== "RSA" || !exported.n || !exported.e) throw new Error("expected an RSA jwk");
  const jwk = { kty: "RSA" as const, n: exported.n, e: exported.e, alg: "RS256" as const, kid };
  return {
    kid,
    async keys() {
      return [{ kid, jwk }];
    },
    sign(claims, opts = {}) {
      return signIdToken(privateKey, claims, { ...opts, kid: opts.kid ?? kid });
    },
  };
}

function encode(value: JwtHeader | IdClaims): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function signIdToken(
  privateKey: KeyObject,
  claims: IdClaims,
  opts: { alg?: string; kid?: string } = {},
): string {
  const alg = opts.alg ?? "RS256";
  const input = `${encode({ alg, kid: opts.kid ?? "test-kid", typ: "JWT" })}.${encode(claims)}`;
  if (alg === "none") return `${input}.`;
  if (alg === "HS256") return `${input}.${createHmac("sha256", "secret").update(input).digest("base64url")}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input, "ascii"), privateKey).toString("base64url")}`;
}
