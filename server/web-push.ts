// Web Push: closed-app notifications to a phone browser that enabled them, beside ntfy.
// VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291) on node:crypto alone.
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { PhonePing } from "./phone-ping.ts";
import { redactSecretsInText } from "./redact.ts";

export const WEB_PUSH_KEYS_FILE = "web-push-vapid.json";
export const WEB_PUSH_SUBS_FILE = "web-push-subscriptions.json";
export const WEB_PUSH_TIMEOUT_MS = 5_000;
const WEB_PUSH_TTL_S = 24 * 60 * 60;
const VAPID_EXP_S = 12 * 60 * 60;
const RECORD_SIZE = 4096;

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const vapidKeysSchema = z.object({ publicKey: b64url, privateKey: b64url });
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().startsWith("https://"),
  keys: z.object({ p256dh: b64url, auth: b64url }),
});
const subscriptionsFileSchema = z.object({ subscriptions: z.array(z.unknown()) });
export const pushEndpointSchema = z.object({ endpoint: z.string() });

export type VapidKeys = z.infer<typeof vapidKeysSchema>;
export type PushSubscriptionRecord = z.infer<typeof pushSubscriptionSchema>;
export type PushPayload = { title: string; body: string; tag: string; url: string };
export type PushTarget = { botId: string; threadId: string };
export type WebPushResult = { ok: true } | { ok: false; gone: boolean; error: string };

const fromB64url = (value: string) => Buffer.from(value, "base64url");

export function loadOrCreateVapidKeys(dataDir: string): VapidKeys {
  const path = join(dataDir, WEB_PUSH_KEYS_FILE);
  try {
    const parsed = vapidKeysSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success && fromB64url(parsed.data.publicKey).length === 65 && fromB64url(parsed.data.privateKey).length === 32) {
      return parsed.data;
    }
  } catch {
    // Missing or corrupt: mint a fresh pair; old subscriptions then fail and get dropped.
  }
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  const keys = {
    publicKey: Buffer.concat([Buffer.from([4]), fromB64url(jwk.x!), fromB64url(jwk.y!)]).toString("base64url"),
    privateKey: jwk.d!,
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

/** ES256 JWT for the push service's origin, as an RFC 8292 Authorization header. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const pub = fromB64url(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
    format: "jwk",
  });
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_EXP_S, sub: subject };
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** One aes128gcm record. `seed` pins the sender key and salt for the RFC test vector. */
export function encryptPushPayload(
  plaintext: Buffer,
  keys: PushSubscriptionRecord["keys"],
  seed?: { senderPrivateKey: Buffer; salt: Buffer },
): Buffer {
  const uaPublic = fromB64url(keys.p256dh);
  const ecdh = createECDH("prime256v1");
  if (seed) ecdh.setPrivateKey(seed.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = seed?.salt ?? randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(hmac(fromB64url(keys.auth), ecdh.computeSecret(uaPublic)), keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Same redaction as ntfy; the tag matches desktop toasts so one bot stacks as one. */
export function pushPayload(ping: PhonePing, target: PushTarget): PushPayload {
  const query = new URLSearchParams({ bot: target.botId, thread: target.threadId });
  return {
    title: redactSecretsInText(ping.title),
    body: redactSecretsInText(ping.message),
    tag: `openmausbot:${target.botId}`,
    url: `/?${query}`,
  };
}

/** Never throws. 404/410 mean the browser dropped the subscription. */
export async function sendWebPush(
  subscription: PushSubscriptionRecord,
  payload: PushPayload,
  keys: VapidKeys,
  subject: string,
  fetchImpl: typeof fetch = fetch,
  warn: (line: string) => void = console.warn,
): Promise<WebPushResult> {
  try {
    const res = await fetchImpl(subscription.endpoint, {
      method: "POST",
      headers: {
        authorization: vapidAuthorization(subscription.endpoint, keys, subject),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(WEB_PUSH_TTL_S),
        urgency: "high",
      },
      body: new Uint8Array(encryptPushPayload(Buffer.from(JSON.stringify(payload)), subscription.keys)),
      signal: AbortSignal.timeout(WEB_PUSH_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const error = `push service answered ${res.status}`;
    const gone = res.status === 404 || res.status === 410;
    if (!gone) warn(`web-push: ${error}`);
    return { ok: false, gone, error };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    warn(`web-push: ${error}`);
    return { ok: false, gone: false, error };
  }
}

export function loadPushSubscriptions(dataDir: string): PushSubscriptionRecord[] {
  try {
    const parsed = subscriptionsFileSchema.safeParse(JSON.parse(readFileSync(join(dataDir, WEB_PUSH_SUBS_FILE), "utf8")));
    if (!parsed.success) return [];
    return parsed.data.subscriptions.flatMap((entry) => {
      const sub = pushSubscriptionSchema.safeParse(entry);
      return sub.success ? [sub.data] : [];
    });
  } catch {
    return [];
  }
}

function savePushSubscriptions(dataDir: string, subscriptions: PushSubscriptionRecord[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, WEB_PUSH_SUBS_FILE), JSON.stringify({ subscriptions }, null, 2), { mode: 0o600 });
}

/** One entry per device; re-enabling the same browser replaces its entry. */
export function addPushSubscription(dataDir: string, subscription: PushSubscriptionRecord): void {
  const rest = loadPushSubscriptions(dataDir).filter((sub) => sub.endpoint !== subscription.endpoint);
  savePushSubscriptions(dataDir, [...rest, { endpoint: subscription.endpoint, keys: subscription.keys }]);
}

export function removePushSubscription(dataDir: string, endpoint: string): void {
  const all = loadPushSubscriptions(dataDir);
  const rest = all.filter((sub) => sub.endpoint !== endpoint);
  if (rest.length !== all.length) savePushSubscriptions(dataDir, rest);
}

/** Sends to one device (by endpoint) or all; drops every subscription the push service says is gone. */
export async function sendWebPushToDevices(
  dataDir: string,
  payload: PushPayload,
  subject: string,
  only?: string,
  fetchImpl: typeof fetch = fetch,
  warn?: (line: string) => void,
): Promise<WebPushResult[]> {
  const subscriptions = loadPushSubscriptions(dataDir).filter((sub) => only === undefined || sub.endpoint === only);
  if (!subscriptions.length) return [];
  const keys = loadOrCreateVapidKeys(dataDir);
  const results = await Promise.all(subscriptions.map((sub) => sendWebPush(sub, payload, keys, subject, fetchImpl, warn)));
  results.forEach((result, i) => {
    if (!result.ok && result.gone) removePushSubscription(dataDir, subscriptions[i]!.endpoint);
  });
  return results;
}
