import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildNotification } from "./notify.ts";
import { pingForMailbox, pingForNotification } from "./phone-ping.ts";
import {
  WEB_PUSH_KEYS_FILE,
  WEB_PUSH_SUBS_FILE,
  addPushSubscription,
  encryptPushPayload,
  loadOrCreateVapidKeys,
  loadPushSubscriptions,
  pushPayload,
  removePushSubscription,
  sendWebPushToDevices,
  vapidAuthorization,
} from "./web-push.ts";

// RFC 8291 section 5 and appendix A.
const rfc = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  result:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const b64 = (value: string) => Buffer.from(value, "base64url");
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

function decryptAsUserAgent(record: Buffer): string {
  const salt = record.subarray(0, 16);
  const idlen = record[20]!;
  const asPublic = record.subarray(21, 21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(b64(rfc.uaPrivate));
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), b64(rfc.uaPublic), asPublic, Buffer.from([1])]);
  const prk = hmac(salt, hmac(hmac(b64(rfc.auth), ecdh.computeSecret(asPublic)), keyInfo));
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const body = record.subarray(21 + idlen);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(body.subarray(-16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString();
}

describe("encryptPushPayload", () => {
  it("matches the RFC 8291 test vector", () => {
    const record = encryptPushPayload(
      Buffer.from(rfc.plaintext),
      { p256dh: rfc.uaPublic, auth: rfc.auth },
      { senderPrivateKey: b64(rfc.asPrivate), salt: b64(rfc.salt) },
    );
    expect(record.toString("base64url")).toBe(rfc.result);
  });

  it("round-trips with a fresh sender key and salt", () => {
    const a = encryptPushPayload(Buffer.from("héllo"), { p256dh: rfc.uaPublic, auth: rfc.auth });
    const b = encryptPushPayload(Buffer.from("héllo"), { p256dh: rfc.uaPublic, auth: rfc.auth });
    expect(a.equals(b)).toBe(false);
    expect(a.readUInt32BE(16)).toBe(4096);
    expect(decryptAsUserAgent(a)).toBe("héllo");
  });
});

describe("vapid", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-web-push-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates the key pair once and reuses it", () => {
    const keys = loadOrCreateVapidKeys(dir);
    expect(b64(keys.publicKey)).toHaveLength(65);
    expect(b64(keys.privateKey)).toHaveLength(32);
    expect(loadOrCreateVapidKeys(dir)).toEqual(keys);
    writeFileSync(join(dir, WEB_PUSH_KEYS_FILE), "{nope");
    expect(loadOrCreateVapidKeys(dir).publicKey).not.toBe(keys.publicKey);
  });

  it("signs an ES256 JWT for the push service origin", () => {
    const keys = loadOrCreateVapidKeys(dir);
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "https://pc.tail.ts.net", 1_700_000_000_000);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(b64(head!).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(b64(claims!).toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1_700_000_000 + 12 * 60 * 60,
      sub: "https://pc.tail.ts.net",
    });
    const pub = b64(keys.publicKey);
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
      format: "jwk",
    });
    const sig = b64(signature!);
    expect(sig).toHaveLength(64);
    expect(verify("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
    expect(verify("sha256", Buffer.from(`${head}.${claims}x`), { key, dsaEncoding: "ieee-p1363" }, sig)).toBe(false);
  });
});

describe("subscription store", () => {
  let dir: string;
  const sub = (id: string) => ({ endpoint: `https://push.example/${id}`, keys: { p256dh: rfc.uaPublic, auth: rfc.auth } });
  const payload = { title: "t", body: "b", tag: "x", url: "/" };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-web-push-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps one entry per endpoint and removes by endpoint", () => {
    expect(loadPushSubscriptions(dir)).toEqual([]);
    addPushSubscription(dir, sub("a"));
    addPushSubscription(dir, sub("b"));
    addPushSubscription(dir, { ...sub("a"), keys: { p256dh: rfc.uaPublic, auth: "bmV3" } });
    expect(loadPushSubscriptions(dir).map((s) => [s.endpoint, s.keys.auth])).toEqual([
      ["https://push.example/b", rfc.auth],
      ["https://push.example/a", "bmV3"],
    ]);
    removePushSubscription(dir, "https://push.example/b");
    expect(loadPushSubscriptions(dir).map((s) => s.endpoint)).toEqual(["https://push.example/a"]);
  });

  it("ignores corrupt files and invalid entries", () => {
    writeFileSync(join(dir, WEB_PUSH_SUBS_FILE), "{nope");
    expect(loadPushSubscriptions(dir)).toEqual([]);
    writeFileSync(join(dir, WEB_PUSH_SUBS_FILE), JSON.stringify({ subscriptions: [{ endpoint: "http://x/y", keys: sub("a").keys }, sub("ok")] }));
    expect(loadPushSubscriptions(dir).map((s) => s.endpoint)).toEqual(["https://push.example/ok"]);
  });

  it("drops subscriptions the push service answers 404 or 410, keeps the rest", async () => {
    for (const id of ["ok", "gone", "missing", "busy"]) addPushSubscription(dir, sub(id));
    const status: Record<string, number> = { ok: 201, gone: 410, missing: 404, busy: 503 };
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: status[String(url).split("/").pop()!] }));
    const warn = vi.fn();
    const results = await sendWebPushToDevices(dir, payload, "https://pc.tail.ts.net", undefined, fetchImpl, warn);
    expect(results.map((r) => r.ok)).toEqual([true, false, false, false]);
    expect(loadPushSubscriptions(dir).map((s) => s.endpoint)).toEqual(["https://push.example/ok", "https://push.example/busy"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ "content-encoding": "aes128gcm", ttl: "86400", urgency: "high" });
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  it("sends a test to one device only", async () => {
    addPushSubscription(dir, sub("a"));
    addPushSubscription(dir, sub("b"));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 201 }));
    await sendWebPushToDevices(dir, payload, "https://pc.tail.ts.net", "https://push.example/b", fetchImpl);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["https://push.example/b"]);
    expect(await sendWebPushToDevices(dir, payload, "https://pc.tail.ts.net", "https://push.example/none", fetchImpl)).toEqual([]);
  });
});

describe("pushPayload", () => {
  const bot = { id: "bot-1", name: "Scout", threadId: "thread-1" };
  const target = { botId: "bot-1", threadId: "thread-1" };

  it("follows the phone ping filters", () => {
    expect(pingForNotification(buildNotification("done", bot, "thread-1", "all set")!, 59_999)).toBeNull();
    expect(pingForMailbox("Scout", "DONE CARD branch=x")).toBeNull();
    expect(pushPayload(pingForNotification(buildNotification("done", bot, "thread-1", "all set")!, 60_000)!, target)).toEqual({
      title: "Scout finished",
      body: "all set",
      tag: "openmausbot:bot-1",
      url: "/?bot=bot-1&thread=thread-1",
    });
    expect(pushPayload(pingForMailbox("Scout", "FAIL CARD branch=x\ndetail")!, target)).toMatchObject({
      title: "Scout: worker FAIL",
      body: "FAIL CARD branch=x",
    });
  });

  it("publishes no part of a config key cut at the summary boundary", () => {
    const value = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
    const detail = `${"x".repeat(98)} ${JSON.stringify({ key: value })}`;
    const pings = [pingForNotification(buildNotification("approval", bot, "thread-1", detail)!)!, pingForMailbox("Scout", `FAIL ${detail}`)!];
    for (const ping of pings) expect(JSON.stringify(pushPayload(ping, target))).not.toMatch(/Ab3dEf6h/);
  });

  it("redacts secrets and encodes the open url", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const payload = pushPayload({ title: `leaked ${token}`, message: `token=${token}` }, { botId: "b&1", threadId: "t 1" });
    expect(JSON.stringify(payload)).not.toContain(token);
    expect(new URLSearchParams(payload.url.slice(2)).get("bot")).toBe("b&1");
  });
});
