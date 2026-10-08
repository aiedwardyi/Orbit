import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generateKeyPairSync } from "node:crypto";
import { labelForPublicKey, rawPublicKey, signTicket } from "../../shared/relay-protocol.ts";
import {
  decodeTicketClaims,
  loadOrCreateAccountKey,
  loadOrCreateIdentity,
  readIdentity,
  readTicket,
  relayDir,
  rememberCertKey,
  ticketProblem,
  writeTicket,
} from "./store.ts";
import { tempDataDir } from "./testing/harness.ts";

describe("relay store", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function dir(): string {
    const made = tempDataDir();
    cleanups.push(made.cleanup);
    return made.dir;
  }

  it("creates the identity once and reuses it", () => {
    const dataDir = dir();
    const first = loadOrCreateIdentity(dataDir);
    const second = loadOrCreateIdentity(dataDir);
    expect(second.pk).toBe(first.pk);
    expect(second.label).toBe(labelForPublicKey(Buffer.from(first.pk, "base64url")));
    if (process.platform !== "win32") {
      expect(statSync(join(relayDir(dataDir), "identity.pem")).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(relayDir(dataDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("never replaces an identity it cannot read", () => {
    const dataDir = dir();
    mkdirSync(relayDir(dataDir), { recursive: true });
    const path = join(relayDir(dataDir), "identity.pem");
    writeFileSync(path, "-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----\n");
    expect(readIdentity(dataDir).kind).toBe("invalid");
    expect(() => loadOrCreateIdentity(dataDir)).toThrow(/unusable/);
    expect(readFileSync(path, "utf8")).toContain("garbage");

    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    writeFileSync(path, rsa);
    expect(() => loadOrCreateIdentity(dataDir)).toThrow(/unusable/);
    expect(readFileSync(path, "utf8")).toBe(rsa);
  });

  it("checks tickets against this identity and expiry", () => {
    const dataDir = dir();
    const identity = loadOrCreateIdentity(dataDir);
    const operator = generateKeyPairSync("ed25519").privateKey;
    const now = Date.now();
    const iat = Math.floor(now / 1000);
    const good = signTicket({ label: identity.label, pk: identity.pk, iat, exp: iat + 3600 }, operator);
    expect(ticketProblem(good, identity, now)).toBeNull();
    expect(ticketProblem(good, identity, now + 3601_000)).toBe("ticket expired");
    const otherKey = rawPublicKey(generateKeyPairSync("ed25519").privateKey);
    const other = signTicket({ label: labelForPublicKey(otherKey), pk: otherKey.toString("base64url"), iat, exp: iat + 3600 }, operator);
    expect(ticketProblem(other, identity, now)).toBe("ticket is for another key");
    expect(ticketProblem("wkt1.%%%.x", identity, now)).toBe("malformed ticket");
    expect(decodeTicketClaims(good)).toMatchObject({ label: identity.label, pk: identity.pk });

    writeTicket(dataDir, good);
    expect(readTicket(dataDir)).toEqual({ kind: "ok", value: good });
    writeFileSync(join(relayDir(dataDir), "ticket.json"), "{not json");
    expect(readTicket(dataDir).kind).toBe("invalid");
  });

  it("never replaces a key history it cannot read", () => {
    const dataDir = dir();
    mkdirSync(relayDir(dataDir), { recursive: true });
    const path = join(relayDir(dataDir), "key-history.json");
    writeFileSync(path, '{"spki":["key-a",');
    try {
      rememberCertKey(dataDir, "key-b");
    } catch {
      /* refusing to write keeps the history too */
    }
    expect(readFileSync(path, "utf8")).toBe('{"spki":["key-a",');
  });

  it("keeps one account key per ACME directory", () => {
    const dataDir = dir();
    const a = loadOrCreateAccountKey(dataDir, "https://ca-one.test/directory");
    const b = loadOrCreateAccountKey(dataDir, "https://ca-two.test/directory");
    expect(a).not.toBe(b);
    expect(loadOrCreateAccountKey(dataDir, "https://ca-one.test/directory")).toBe(a);
  });
});
