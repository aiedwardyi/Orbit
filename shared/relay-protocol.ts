/**
 * Wink phone relay wire protocol, shared by the relay and the PC harness.
 * See docs/phone-relay-design.md sections 3, 4 and 7.
 *
 * Frames: 4 byte big-endian length, then UTF-8 JSON, at most 16 KiB of JSON.
 * Keys: Ed25519 through node:crypto only. Public keys travel as base64url of
 * the raw 32 bytes, signatures as base64url.
 */

import { createHash, createPublicKey, sign, verify, randomBytes, type KeyObject } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// ALPN ids

export const ALPN_CONTROL = "wink-ctl/1";
export const ALPN_DATA = "wink-data/1";
export const ALPN_ACME = "acme-tls/1";

// ---------------------------------------------------------------------------
// Messages

export const PROTOCOL_VERSION = 1;

const count = z.int().min(0);

/** Relay to PC: first frame on a control channel. */
export const helloMessageSchema = z.object({ type: z.literal("hello"), v: count, nonce: z.string() });
/** PC to relay: `sig` covers authPayload(nonce, label). */
export const authMessageSchema = z.object({
  type: z.literal("auth"),
  label: z.string(),
  pk: z.string(),
  ticket: z.string(),
  sig: z.string(),
});
/** Relay to PC: session accepted. `ticket` is a refreshed ticket past half life. */
export const readyMessageSchema = z.object({
  type: z.literal("ready"),
  session: z.string(),
  poolToken: z.string(),
  pool: z.object({ min: count, max: count }).refine((pool) => pool.min <= pool.max, "pool.min exceeds pool.max"),
  ticket: z.string().optional(),
});
/** Relay to PC: a phone waits on an empty pool. */
export const wantMessageSchema = z.object({ type: z.literal("want"), n: count });
export const pingMessageSchema = z.object({ type: z.literal("ping") });
export const pongMessageSchema = z.object({ type: z.literal("pong") });
export const noticeCodeSchema = z.enum(["superseded", "draining", "revoked"]);
export const noticeMessageSchema = z.object({ type: z.literal("notice"), code: noticeCodeSchema });
/** PC to relay: parks this data channel in the pool. */
export const joinMessageSchema = z.object({ type: z.literal("join"), session: z.string(), poolToken: z.string() });
/** Relay to PC: a phone arrived. Raw bytes follow; neither side frames again. */
export const goMessageSchema = z.object({ type: z.literal("go"), peer: z.string() });

export const relayMessageSchema = z.discriminatedUnion("type", [
  helloMessageSchema,
  authMessageSchema,
  readyMessageSchema,
  wantMessageSchema,
  pingMessageSchema,
  pongMessageSchema,
  noticeMessageSchema,
  joinMessageSchema,
  goMessageSchema,
]);

export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type AuthMessage = z.infer<typeof authMessageSchema>;
export type ReadyMessage = z.infer<typeof readyMessageSchema>;
export type WantMessage = z.infer<typeof wantMessageSchema>;
export type PingMessage = z.infer<typeof pingMessageSchema>;
export type PongMessage = z.infer<typeof pongMessageSchema>;
export type NoticeCode = z.infer<typeof noticeCodeSchema>;
export type NoticeMessage = z.infer<typeof noticeMessageSchema>;
export type JoinMessage = z.infer<typeof joinMessageSchema>;
export type GoMessage = z.infer<typeof goMessageSchema>;

export type ControlMessage =
  | HelloMessage
  | AuthMessage
  | ReadyMessage
  | WantMessage
  | PingMessage
  | PongMessage
  | NoticeMessage;
export type DataMessage = JoinMessage | GoMessage;
export type RelayMessage = ControlMessage | DataMessage;

/** True for messages that belong on a control channel (ALPN wink-ctl/1). */
export function isControlMessage(message: RelayMessage): message is ControlMessage {
  return message.type !== "join" && message.type !== "go";
}

/** True for messages that belong on a data channel (ALPN wink-data/1). */
export function isDataMessage(message: RelayMessage): message is DataMessage {
  return message.type === "join" || message.type === "go";
}

// ---------------------------------------------------------------------------
// Frame codec

export const FRAME_HEADER_BYTES = 4;
export const MAX_FRAME_BYTES = 16 * 1024;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

/** Encodes one message. Throws FrameError when the JSON is over MAX_FRAME_BYTES. */
export function encodeFrame(message: RelayMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new FrameError(`frame of ${body.length} bytes exceeds ${MAX_FRAME_BYTES}`);
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Streaming decoder. push() bytes as they arrive, then call next() until it
 * returns undefined. next() hands out one frame at a time so a caller can
 * stop right after `go` and take the raw bytes behind it with rest(): the
 * phone's ClientHello may share a read with the `go` frame.
 *
 * next() throws FrameError on an oversize length, invalid JSON or an unknown
 * message; the channel is unusable after that.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    this.chunks.push(buf);
    this.size += buf.length;
  }

  /** Bytes received and not yet consumed by next(). */
  get buffered(): number {
    return this.size;
  }

  /** Next complete message, or undefined when more bytes are needed. */
  next(): RelayMessage | undefined {
    if (this.size < FRAME_HEADER_BYTES) return undefined;
    const head = this.peek(FRAME_HEADER_BYTES);
    const length = head.readUInt32BE(0);
    if (length > MAX_FRAME_BYTES) throw new FrameError(`frame of ${length} bytes exceeds ${MAX_FRAME_BYTES}`);
    if (this.size < FRAME_HEADER_BYTES + length) return undefined;
    const frame = this.take(FRAME_HEADER_BYTES + length);
    const message = relayMessageSchema.safeParse(parseJson(frame.toString("utf8", FRAME_HEADER_BYTES)));
    if (!message.success) throw new FrameError("frame is not a relay message");
    return message.data;
  }

  /** Returns every unconsumed byte and empties the decoder. */
  rest(): Buffer {
    const out = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
    this.chunks = [];
    this.size = 0;
    return out;
  }

  private peek(n: number): Buffer {
    if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks, this.size)];
    return this.chunks[0].subarray(0, n);
  }

  private take(n: number): Buffer {
    if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks, this.size)];
    const first = this.chunks[0];
    if (first.length === n) this.chunks.shift();
    else this.chunks[0] = first.subarray(n);
    this.size -= n;
    return first.subarray(0, n);
  }
}

// ---------------------------------------------------------------------------
// Labels

export const LABEL_LENGTH = 16;
export const LABEL_RE = /^[a-z2-7]{16}$/;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
export function base32lower(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** base32lower(sha256(raw 32 byte Ed25519 public key)), first 16 chars. */
export function labelForPublicKey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== ED25519_KEY_BYTES) throw new Error("Ed25519 public key must be 32 bytes");
  return base32lower(createHash("sha256").update(rawPublicKey).digest()).slice(0, LABEL_LENGTH);
}

function normalizeBase(base: string): string {
  return base.toLowerCase();
}

export function hostFor(label: string, base: string): string {
  if (!LABEL_RE.test(label)) throw new Error("invalid relay label");
  return `${label}.${normalizeBase(base)}`;
}

/** The label of `<label>.<base>`, or null for any other host. Case-insensitive. */
export function labelFromHost(host: string, base: string): string | null {
  const suffix = `.${normalizeBase(base)}`;
  if (suffix.length < 2) return null;
  const lower = host.toLowerCase();
  if (!lower.endsWith(suffix)) return null;
  const label = lower.slice(0, lower.length - suffix.length);
  return LABEL_RE.test(label) ? label : null;
}

// ---------------------------------------------------------------------------
// Ed25519 helpers

export const ED25519_KEY_BYTES = 32;
export const ED25519_SIG_BYTES = 64;
export const NONCE_BYTES = 32;
/** Allowed clock difference between signer and verifier, in seconds. */
export const CLOCK_SKEW_SEC = 300;

export const TICKET_PREFIX = "wkt1";
export const INVITE_PREFIX = "wki1";
export const AUTH_CONTEXT = "wink-relay-auth/1";

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

function fromB64url(text: string): Buffer | null {
  return B64URL_RE.test(text) ? Buffer.from(text, "base64url") : null;
}

/** JSON.parse that yields undefined on bad input; callers validate with a schema. */
function parseJson(text: string): z.core.util.JSONType | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Raw 32 byte public key of an Ed25519 public or private KeyObject. */
export function rawPublicKey(key: KeyObject): Buffer {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  if (pub.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  const x = pub.export({ format: "jwk" }).x;
  if (!x) throw new Error("not an Ed25519 key");
  return Buffer.from(x, "base64url");
}

/** Ed25519 public KeyObject from the base64url of its raw 32 bytes (the wire `pk`), or null. */
export function publicKeyFromRaw(pk: string): KeyObject | null {
  const bytes = fromB64url(pk);
  if (!bytes || bytes.length !== ED25519_KEY_BYTES) return null;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pk }, format: "jwk" });
  } catch {
    return null;
  }
}

/** 32 random bytes, base64url: the hello nonce and the invite nonce. */
export function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

function verifySig(publicKey: KeyObject, data: Buffer, sigText: string): boolean {
  const sig = fromB64url(sigText);
  if (!sig || sig.length !== ED25519_SIG_BYTES) return false;
  try {
    return verify(null, data, publicKey, sig);
  } catch {
    return false;
  }
}

const nowSec = (now: number | undefined) => Math.floor((now ?? Date.now()) / 1000);

export interface VerifyOptions {
  /** Current time in ms since epoch. Defaults to Date.now(). */
  now?: number;
}

export type VerifyResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Operator-signed proof that `pk` may hold `label`. Times are seconds since epoch. */
export const ticketClaimsSchema = z.object({
  label: z.string().regex(LABEL_RE),
  pk: z.string(),
  iat: z.int(),
  exp: z.int(),
});
export type TicketClaims = z.infer<typeof ticketClaimsSchema>;

/** Operator-signed enrollment invite. `exp` is seconds since epoch. */
export const inviteClaimsSchema = z.object({ exp: z.int(), nonce: z.string().min(1) });
export type InviteClaims = z.infer<typeof inviteClaimsSchema>;

/** Signed `<prefix>.<b64url json>.<b64url sig>`; the signature covers `<prefix>.<b64url json>`. */
function signToken(prefix: string, payload: TicketClaims | InviteClaims, privateKey: KeyObject): string {
  const signed = `${prefix}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return `${signed}.${sign(null, Buffer.from(signed, "ascii"), privateKey).toString("base64url")}`;
}

function openToken<T>(prefix: string, token: string, publicKey: KeyObject, schema: z.ZodType<T>): VerifyResult<T> {
  if (token.length > MAX_FRAME_BYTES) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return { ok: false, reason: "malformed" };
  const body = fromB64url(parts[1]);
  if (!body) return { ok: false, reason: "malformed" };
  if (!verifySig(publicKey, Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), parts[2])) {
    return { ok: false, reason: "bad-signature" };
  }
  const claims = schema.safeParse(parseJson(body.toString("utf8")));
  return claims.success ? { ok: true, value: claims.data } : { ok: false, reason: "malformed" };
}

function checkTimes(iat: number, exp: number, now: number | undefined): string | null {
  const t = nowSec(now);
  if (exp + CLOCK_SKEW_SEC <= t) return "expired";
  if (iat - CLOCK_SKEW_SEC > t) return "not-yet-valid";
  return null;
}

export function signTicket(claims: TicketClaims, operatorPrivateKey: KeyObject): string {
  return signToken(TICKET_PREFIX, ticketClaimsSchema.parse(claims), operatorPrivateKey);
}

/** Checks signature, label derived from pk, and lifetime with CLOCK_SKEW_SEC slack. */
export function verifyTicket(
  ticket: string,
  operatorPublicKey: KeyObject,
  options: VerifyOptions = {},
): VerifyResult<TicketClaims> {
  const opened = openToken(TICKET_PREFIX, ticket, operatorPublicKey, ticketClaimsSchema);
  if (!opened.ok) return opened;
  const claims = opened.value;
  const raw = fromB64url(claims.pk);
  if (!raw || raw.length !== ED25519_KEY_BYTES) return { ok: false, reason: "malformed" };
  if (labelForPublicKey(raw) !== claims.label) return { ok: false, reason: "label-mismatch" };
  const timeError = checkTimes(claims.iat, claims.exp, options.now);
  return timeError ? { ok: false, reason: timeError } : opened;
}

/** Mints an invite valid for `ttlSec` (7 days by default). */
export function mintInvite(
  operatorPrivateKey: KeyObject,
  options: { now?: number; ttlSec?: number; nonce?: string } = {},
): string {
  const exp = nowSec(options.now) + (options.ttlSec ?? 7 * 24 * 60 * 60);
  return signToken(INVITE_PREFIX, inviteClaimsSchema.parse({ exp, nonce: options.nonce ?? newNonce() }), operatorPrivateKey);
}

/** Checks signature and expiry. Single use is the relay's job (it keeps used nonces). */
export function verifyInvite(
  invite: string,
  operatorPublicKey: KeyObject,
  options: VerifyOptions = {},
): VerifyResult<InviteClaims> {
  const opened = openToken(INVITE_PREFIX, invite, operatorPublicKey, inviteClaimsSchema);
  if (!opened.ok) return opened;
  if (opened.value.exp + CLOCK_SKEW_SEC <= nowSec(options.now)) return { ok: false, reason: "expired" };
  return opened;
}

// ---------------------------------------------------------------------------
// Setup codes

/**
 * What an operator sends a teammate: `wks1:<base>:<invite>`. It carries the
 * relay's base domain so no build has to name one. Neither part contains ":".
 */
export const SETUP_PREFIX = "wks1";
/** A relay base domain, lowercase: at least two dot-separated DNS labels. */
export const RELAY_BASE_RE = /^(?=.{3,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SETUP_INVITE_RE = new RegExp(`^${INVITE_PREFIX}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`);

export interface SetupCode {
  base: string;
  invite: string;
}

/** "malformed" covers a wrong prefix or part count. */
export type SetupCodeProblem = "malformed" | "bad-base" | "bad-invite";

export function parseSetupCode(code: string): { ok: true; value: SetupCode } | { ok: false; reason: SetupCodeProblem } {
  const parts = code.trim().split(":");
  if (parts.length !== 3 || parts[0] !== SETUP_PREFIX) return { ok: false, reason: "malformed" };
  const base = parts[1].toLowerCase();
  if (!RELAY_BASE_RE.test(base)) return { ok: false, reason: "bad-base" };
  const invite = parts[2];
  if (invite.length > MAX_FRAME_BYTES || !SETUP_INVITE_RE.test(invite)) return { ok: false, reason: "bad-invite" };
  return { ok: true, value: { base, invite } };
}

export function buildSetupCode(base: string, invite: string): string {
  const code = `${SETUP_PREFIX}:${base.trim().toLowerCase()}:${invite.trim()}`;
  const parsed = parseSetupCode(code);
  if (!parsed.ok) throw new Error(parsed.reason === "bad-base" ? "base is not a domain name" : "invalid invite");
  return code;
}

/** Bytes the control `auth` signature covers: "wink-relay-auth/1" | nonce | label. */
export function authPayload(nonce: string, label: string): Buffer | null {
  const nonceBytes = fromB64url(nonce);
  if (!nonceBytes || nonceBytes.length !== NONCE_BYTES || !LABEL_RE.test(label)) return null;
  return Buffer.concat([Buffer.from(AUTH_CONTEXT, "ascii"), nonceBytes, Buffer.from(label, "ascii")]);
}

/** PC side: signs the relay's hello nonce for `label`, returns base64url. */
export function signAuth(privateKey: KeyObject, nonce: string, label: string): string {
  const payload = authPayload(nonce, label);
  if (!payload) throw new Error("invalid nonce or label");
  return sign(null, payload, privateKey).toString("base64url");
}

/** Relay side: `sig` is by `pk` over the nonce and label, and `label` derives from `pk`. */
export function verifyAuth(pk: string, nonce: string, label: string, sig: string): boolean {
  const publicKey = publicKeyFromRaw(pk);
  const payload = authPayload(nonce, label);
  if (!publicKey || !payload) return false;
  if (labelForPublicKey(rawPublicKey(publicKey)) !== label) return false;
  return verifySig(publicKey, payload, sig);
}

// ---------------------------------------------------------------------------
// Settings status (section 7), GET /api/phone-relay/status

export type PhoneRelayState =
  | "off"
  | "enrolling"
  | "certifying"
  | "connected"
  | "reconnecting"
  | "rejected"
  | "cert-error";

export interface PhoneRelayStatus {
  state: PhoneRelayState;
  /** `<label>.<base>` once an identity exists. */
  host: string | null;
  relayRttMs: number | null;
  poolIdle: number;
  /** Certificate expiry, ms since epoch. */
  certNotAfter: number | null;
  lastError: string | null;
  /** Next reconnect attempt, ms since epoch. */
  nextRetryAt: number | null;
}

export const PHONE_RELAY_OFF: Readonly<PhoneRelayStatus> = Object.freeze({
  state: "off",
  host: null,
  relayRttMs: null,
  poolIdle: 0,
  certNotAfter: null,
  lastError: null,
  nextRetryAt: null,
});
