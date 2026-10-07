// Private relay material under DATA_DIR/phone-relay (design sections 4, 6).
// Every file is 0600 in a 0700 directory, written atomically, and never part
// of thread or memory sync (those only walk threads-v2 and memory-v2).
// A file that exists but fails validation is reported, never replaced.

import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import {
  TICKET_PREFIX,
  labelForPublicKey,
  rawPublicKey,
  ticketClaimsSchema,
  type TicketClaims,
} from "../../shared/relay-protocol.ts";

export const RELAY_DIR_NAME = "phone-relay";
const IDENTITY_FILE = "identity.pem";
const TICKET_FILE = "ticket.json";
const CERT_FILE = "cert.json";
const KEY_HISTORY_FILE = "key-history.json";
const MAX_KEY_HISTORY = 64;
const PRIVATE_MODE = 0o600;

export type Loaded<T> = { kind: "missing" } | { kind: "ok"; value: T } | { kind: "invalid"; reason: string };

export interface Identity {
  privateKey: KeyObject;
  /** base64url of the raw 32 byte public key, the wire `pk`. */
  pk: string;
  label: string;
}

export interface StoredCert {
  keyPem: string;
  certPem: string;
  notBefore: number;
  notAfter: number;
}

export function relayDir(dataDir: string): string {
  return join(dataDir, RELAY_DIR_NAME);
}

function ensureDir(dataDir: string): string {
  const dir = relayDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readText(path: string): Loaded<string> {
  try {
    return { kind: "ok", value: readFileSync(path, "utf8") };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: "unreadable" };
  }
}

function parseJsonText(text: string): z.core.util.JSONType | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Creates `path` only if absent. Returns false when another writer got there first. */
function writeExclusive(path: string, data: string): boolean {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", PRIVATE_MODE);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
  }
}

// ---------------------------------------------------------------------------
// Identity

function identityFromPem(pem: string): Identity | null {
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") return null;
    const raw = rawPublicKey(privateKey);
    return { privateKey, pk: raw.toString("base64url"), label: labelForPublicKey(raw) };
  } catch {
    return null;
  }
}

export function readIdentity(dataDir: string): Loaded<Identity> {
  const text = readText(join(relayDir(dataDir), IDENTITY_FILE));
  if (text.kind !== "ok") return text;
  const identity = identityFromPem(text.value);
  return identity ? { kind: "ok", value: identity } : { kind: "invalid", reason: "identity file is not an Ed25519 key" };
}

/** Loads the PC identity, creating it on first use. Throws rather than replace an unreadable one. */
export function loadOrCreateIdentity(dataDir: string): Identity {
  const existing = readIdentity(dataDir);
  if (existing.kind === "ok") return existing.value;
  if (existing.kind === "invalid") throw new Error(`phone relay identity unusable: ${existing.reason}`);
  const dir = ensureDir(dataDir);
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  if (writeExclusive(join(dir, IDENTITY_FILE), pem)) {
    const created = identityFromPem(pem);
    if (!created) throw new Error("phone relay identity could not be created");
    return created;
  }
  const raced = readIdentity(dataDir);
  if (raced.kind !== "ok") throw new Error("phone relay identity unusable after concurrent create");
  return raced.value;
}

// ---------------------------------------------------------------------------
// Ticket

const ticketFileSchema = z.object({ ticket: z.string().min(1).max(16 * 1024) });

/** Ticket claims without the operator signature check; the PC has no operator key. */
export function decodeTicketClaims(ticket: string): TicketClaims | null {
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const claims = ticketClaimsSchema.safeParse(parseJsonText(Buffer.from(parts[1], "base64url").toString("utf8")));
  return claims.success ? claims.data : null;
}

/** null when `ticket` names this identity and has not expired, else the reason. */
export function ticketProblem(ticket: string, identity: Identity, now: number): string | null {
  const claims = decodeTicketClaims(ticket);
  if (!claims) return "malformed ticket";
  if (claims.label !== identity.label || claims.pk !== identity.pk) return "ticket is for another key";
  if (claims.exp * 1000 <= now) return "ticket expired";
  return null;
}

export function readTicket(dataDir: string): Loaded<string> {
  const text = readText(join(relayDir(dataDir), TICKET_FILE));
  if (text.kind !== "ok") return text;
  const parsed = ticketFileSchema.safeParse(parseJsonText(text.value));
  return parsed.success ? { kind: "ok", value: parsed.data.ticket } : { kind: "invalid", reason: "ticket file is corrupt" };
}

export function writeTicket(dataDir: string, ticket: string): void {
  const dir = ensureDir(dataDir);
  writeFileAtomic(join(dir, TICKET_FILE), `${JSON.stringify({ ticket })}\n`, { mode: PRIVATE_MODE });
}

// ---------------------------------------------------------------------------
// Certificate and key history

const certFileSchema = z.object({ keyPem: z.string().min(1), certPem: z.string().min(1) });

/** Parses a key and leaf certificate pair, checking they belong together and name `host`. */
export function parseCertPair(keyPem: string, certPem: string, host: string): StoredCert | null {
  try {
    const leaf = new X509Certificate(certPem);
    if (!leaf.checkPrivateKey(createPrivateKey(keyPem))) return null;
    if (leaf.checkHost(host, { wildcards: false, subject: "never" }) !== host) return null;
    return { keyPem, certPem, notBefore: Date.parse(leaf.validFrom), notAfter: Date.parse(leaf.validTo) };
  } catch {
    return null;
  }
}

export function readCert(dataDir: string, host: string): Loaded<StoredCert> {
  const text = readText(join(relayDir(dataDir), CERT_FILE));
  if (text.kind !== "ok") return text;
  const parsed = certFileSchema.safeParse(parseJsonText(text.value));
  const cert = parsed.success ? parseCertPair(parsed.data.keyPem, parsed.data.certPem, host) : null;
  return cert ? { kind: "ok", value: cert } : { kind: "invalid", reason: "certificate file is corrupt" };
}

export function writeCert(dataDir: string, keyPem: string, certPem: string): void {
  const dir = ensureDir(dataDir);
  writeFileAtomic(join(dir, CERT_FILE), `${JSON.stringify({ keyPem, certPem })}\n`, { mode: PRIVATE_MODE });
}

/** SHA-256 of the SubjectPublicKeyInfo DER, base64url. */
export function spkiFingerprint(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("base64url");
}

const keyHistorySchema = z.object({ spki: z.array(z.string()) });

export function loadKeyHistory(dataDir: string): Loaded<string[]> {
  const text = readText(join(relayDir(dataDir), KEY_HISTORY_FILE));
  if (text.kind !== "ok") return text;
  const parsed = keyHistorySchema.safeParse(parseJsonText(text.value));
  return parsed.success ? { kind: "ok", value: parsed.data.spki } : { kind: "invalid", reason: "key history file is corrupt" };
}

/** Known certificate keys, empty when none were recorded. Throws rather than guess at an unusable file. */
export function readKeyHistory(dataDir: string): string[] {
  const history = loadKeyHistory(dataDir);
  if (history.kind === "invalid") throw new Error(`phone relay key history unusable: ${history.reason}`);
  return history.kind === "ok" ? history.value : [];
}

/** Records a certificate key before it is sent to a CA, so CT monitoring knows it. Never overwrites an unusable history. */
export function rememberCertKey(dataDir: string, fingerprint: string): void {
  const history = readKeyHistory(dataDir).filter((entry) => entry !== fingerprint);
  history.push(fingerprint);
  const dir = ensureDir(dataDir);
  writeFileAtomic(join(dir, KEY_HISTORY_FILE), `${JSON.stringify({ spki: history.slice(-MAX_KEY_HISTORY) })}\n`, {
    mode: PRIVATE_MODE,
  });
}

// ---------------------------------------------------------------------------
// ACME account keys, one per directory URL so CAs never share an account key

function accountKeyFile(directoryUrl: string): string {
  return `acme-account-${createHash("sha256").update(directoryUrl).digest("hex").slice(0, 16)}.pem`;
}

function ecKeyFromPem(pem: string): boolean {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

export function newEcKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

export function loadOrCreateAccountKey(dataDir: string, directoryUrl: string): string {
  const path = join(relayDir(dataDir), accountKeyFile(directoryUrl));
  const existing = readText(path);
  if (existing.kind === "ok") {
    if (ecKeyFromPem(existing.value)) return existing.value;
    throw new Error("ACME account key unusable");
  }
  if (existing.kind === "invalid") throw new Error("ACME account key unreadable");
  ensureDir(dataDir);
  const pem = newEcKeyPem();
  if (writeExclusive(path, pem)) return pem;
  const raced = readText(path);
  if (raced.kind === "ok" && ecKeyFromPem(raced.value)) return raced.value;
  throw new Error("ACME account key unusable after concurrent create");
}
