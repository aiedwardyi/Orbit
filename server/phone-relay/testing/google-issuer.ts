// In-process stand-in for Google's ID token issuer: a local RSA key, its JWKS
// as a key source, and RS256 tokens with whatever claims a test needs.

import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import type { GoogleKeySource, GooglePublicJwk } from "../../../shared/google-id-token.ts";

export const WEB_CLIENT = "web-client.apps.googleusercontent.test";
export const DESKTOP_CLIENT = "desktop-client.apps.googleusercontent.test";

export interface IdTokenClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  iat?: number;
  exp?: number;
  nonce?: string;
}

export class FakeGoogle {
  private readonly key: KeyObject = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  readonly keys: GoogleKeySource;

  constructor() {
    const jwk = createPublicKey(this.key).export({ format: "jwk" });
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("expected an RSA jwk");
    const published: GooglePublicJwk[] = [{ kid: "test-kid", jwk: { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", kid: "test-kid" } }];
    this.keys = { keys: async () => published };
  }

  /** A Web-client token for `sub`, valid for an hour from `now` (ms). */
  token(claims: IdTokenClaims, now = Date.now()): string {
    const iat = Math.floor(now / 1000);
    const payload = { iss: "https://accounts.google.com", aud: WEB_CLIENT, sub: "sub-owner", email: "me@example.com", iat, exp: iat + 3600, ...claims };
    const part = (json: string) => Buffer.from(json).toString("base64url");
    const input = `${part(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" }))}.${part(JSON.stringify(payload))}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input, "ascii"), this.key).toString("base64url")}`;
  }
}
