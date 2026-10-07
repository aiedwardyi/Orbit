import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ALPN_ACME,
  ALPN_CONTROL,
  ALPN_DATA,
  FrameDecoder,
  FrameError,
  LABEL_RE,
  MAX_FRAME_BYTES,
  PHONE_RELAY_OFF,
  base32lower,
  encodeFrame,
  hostFor,
  labelForPublicKey,
  labelFromHost,
  mintInvite,
  newNonce,
  isControlMessage,
  isDataMessage,
  relayMessageSchema,
  publicKeyFromRaw,
  rawPublicKey,
  signAuth,
  signTicket,
  verifyAuth,
  verifyInvite,
  verifyTicket,
  type RelayMessage,
} from "../shared/relay-protocol.ts";

// RFC 8032 section 7.1, test 1.
const RFC_SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
// base32lower(sha256(RFC_PUBLIC)) computed independently.
const RFC_LABEL = "eh7ddx5bksrgcytl";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const NOW_SEC = NOW / 1000;
const YEAR = 365 * 24 * 60 * 60;

function keyPair() {
  return generateKeyPairSync("ed25519");
}

function pcIdentity() {
  const { publicKey, privateKey } = keyPair();
  const pk = rawPublicKey(publicKey).toString("base64url");
  return { publicKey, privateKey, pk, label: labelForPublicKey(rawPublicKey(publicKey)) };
}

/** Swaps one base64url character in the middle of the given dot-separated part. */
function tamper(token: string, part: number): string {
  const parts = token.split(".");
  const s = parts[part];
  const i = Math.floor(s.length / 2);
  parts[part] = s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
  return parts.join(".");
}

describe("frame codec", () => {
  const messages: RelayMessage[] = [
    { type: "hello", v: 1, nonce: "n0nce" },
    { type: "auth", label: RFC_LABEL, pk: "pk", ticket: "wkt1.a.b", sig: "sig" },
    { type: "ready", session: "s", poolToken: "t", pool: { min: 3, max: 8 }, ticket: "wkt1.c.d" },
    { type: "want", n: 2 },
    { type: "ping" },
    { type: "pong" },
    { type: "notice", code: "draining" },
    { type: "join", session: "s", poolToken: "t" },
    { type: "go", peer: "203.0.113.9" },
  ];

  function drain(decoder: FrameDecoder): unknown[] {
    const out: unknown[] = [];
    for (let m = decoder.next(); m !== undefined; m = decoder.next()) out.push(m);
    return out;
  }

  it("round trips every message", () => {
    for (const message of messages) {
      const frame = encodeFrame(message);
      expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
      const decoder = new FrameDecoder();
      decoder.push(frame);
      expect(decoder.next()).toEqual(message);
      expect(decoder.next()).toBeUndefined();
      expect(decoder.buffered).toBe(0);
    }
  });

  it("decodes a byte-at-a-time feed", () => {
    const wire = Buffer.concat(messages.map(encodeFrame));
    const decoder = new FrameDecoder();
    const out: unknown[] = [];
    for (const byte of wire) {
      decoder.push(Buffer.from([byte]));
      out.push(...drain(decoder));
    }
    expect(out).toEqual(messages);
  });

  it("decodes coalesced frames from one read", () => {
    const decoder = new FrameDecoder();
    decoder.push(Buffer.concat(messages.map(encodeFrame)));
    expect(drain(decoder)).toEqual(messages);
  });

  it("hands back the bytes after go, even when they share a read", () => {
    const clientHello = Buffer.from([22, 3, 1, 0, 200, 1, 0, 0, 196, 3, 3]);
    const wire = Buffer.concat([encodeFrame({ type: "go", peer: "198.51.100.4" }), clientHello]);
    for (const split of [1, 3, 4, wire.length - clientHello.length, wire.length - 2]) {
      const decoder = new FrameDecoder();
      decoder.push(wire.subarray(0, split));
      let go = decoder.next();
      if (go === undefined) {
        decoder.push(wire.subarray(split));
        go = decoder.next();
        expect(go).toEqual({ type: "go", peer: "198.51.100.4" });
        expect(decoder.rest()).toEqual(clientHello);
      } else {
        expect(go).toEqual({ type: "go", peer: "198.51.100.4" });
        const rest = decoder.rest();
        expect(Buffer.concat([rest, wire.subarray(split)])).toEqual(clientHello);
      }
      expect(decoder.buffered).toBe(0);
    }
  });

  it("rejects oversize frames on both sides", () => {
    const big: RelayMessage = { type: "go", peer: "x".repeat(MAX_FRAME_BYTES) };
    expect(() => encodeFrame(big)).toThrow(FrameError);
    const decoder = new FrameDecoder();
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    decoder.push(head);
    expect(() => decoder.next()).toThrow(FrameError);
    // A TLS record mistaken for a frame header is oversize, not a hang.
    const tls = new FrameDecoder();
    tls.push(Buffer.from([22, 3, 1, 2, 0]));
    expect(() => tls.next()).toThrow(FrameError);
  });

  it("accepts a frame of exactly the maximum size", () => {
    const filler = MAX_FRAME_BYTES - JSON.stringify({ type: "go", peer: "" }).length;
    const frame = encodeFrame({ type: "go", peer: "x".repeat(filler) });
    expect(frame.length).toBe(4 + MAX_FRAME_BYTES);
    const decoder = new FrameDecoder();
    decoder.push(frame);
    expect(decoder.next()?.type).toBe("go");
  });

  it("rejects a frame that is not JSON", () => {
    const decoder = new FrameDecoder();
    decoder.push(Buffer.from([0, 0, 0, 3, 0x7b, 0x7b, 0x7b]));
    expect(() => decoder.next()).toThrow(FrameError);
  });
});

describe("message validation", () => {
  const frame = (json: string) => {
    const body = Buffer.from(json);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    return Buffer.concat([head, body]);
  };

  it("sorts messages by channel", () => {
    const ready = relayMessageSchema.parse({ type: "ready", session: "s", poolToken: "t", pool: { min: 3, max: 8 } });
    expect(isControlMessage(ready)).toBe(true);
    expect(isDataMessage(ready)).toBe(false);
    const join = relayMessageSchema.parse({ type: "join", session: "s", poolToken: "t" });
    expect(isDataMessage(join)).toBe(true);
    expect(isControlMessage(join)).toBe(false);
  });

  it("refuses unknown types and bad fields in a frame", () => {
    for (const bad of [
      { type: "nope" },
      { type: "want", n: -1 },
      { type: "want", n: 1.5 },
      { type: "notice", code: "other" },
      { type: "ready", session: "s", poolToken: "t", pool: { min: 9, max: 8 } },
      { type: "auth", label: "l", pk: 1, ticket: "t", sig: "s" },
      [],
    ]) {
      const decoder = new FrameDecoder();
      decoder.push(frame(JSON.stringify(bad)));
      expect(() => decoder.next(), JSON.stringify(bad)).toThrow(FrameError);
    }
  });

  it("exports the ALPN ids", () => {
    expect([ALPN_CONTROL, ALPN_DATA, ALPN_ACME]).toEqual(["wink-ctl/1", "wink-data/1", "acme-tls/1"]);
  });
});

describe("labels", () => {
  it("derives the label of a fixed key", () => {
    const raw = Buffer.from(RFC_PUBLIC, "hex");
    expect(labelForPublicKey(raw)).toBe(RFC_LABEL);
    expect(LABEL_RE.test(RFC_LABEL)).toBe(true);
    const privateKey = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(RFC_SECRET, "hex")]),
      format: "der",
      type: "pkcs8",
    });
    expect(rawPublicKey(privateKey).toString("hex")).toBe(RFC_PUBLIC);
    expect(rawPublicKey(publicKeyFromRaw(raw.toString("base64url"))!).toString("hex")).toBe(RFC_PUBLIC);
  });

  it("encodes RFC 4648 base32 vectors", () => {
    expect(base32lower(Buffer.from("foobar"))).toBe("mzxw6ytboi");
    expect(base32lower(Buffer.from("f"))).toBe("my");
    expect(base32lower(Buffer.alloc(0))).toBe("");
  });

  it("refuses keys that are not 32 bytes", () => {
    expect(() => labelForPublicKey(Buffer.alloc(31))).toThrow();
    expect(publicKeyFromRaw(Buffer.alloc(31).toString("base64url"))).toBeNull();
    expect(publicKeyFromRaw("not base64url!")).toBeNull();
  });

  it("maps labels to hosts and back", () => {
    expect(hostFor(RFC_LABEL, "Wink.Example")).toBe(`${RFC_LABEL}.wink.example`);
    expect(() => hostFor("relay", "wink.example")).toThrow();
    expect(labelFromHost(`${RFC_LABEL}.wink.example`, "wink.example")).toBe(RFC_LABEL);
    expect(labelFromHost(`${RFC_LABEL.toUpperCase()}.WINK.example`, "wink.Example")).toBe(RFC_LABEL);
  });

  it("returns null for every other host", () => {
    const base = "wink.example";
    for (const host of [
      "relay.wink.example",
      "www.wink.example",
      "status.wink.example",
      "wink.example",
      `${RFC_LABEL}.other.example`,
      `${RFC_LABEL}.wink.example.evil`,
      `${RFC_LABEL}xwink.example`,
      `a.${RFC_LABEL}.wink.example`,
      `${RFC_LABEL}.wink.example:443`,
      `${RFC_LABEL.slice(0, 15)}1.wink.example`,
      `${RFC_LABEL}a.wink.example`,
      "",
    ]) {
      expect(labelFromHost(host, base), host).toBeNull();
    }
    expect(labelFromHost(`${RFC_LABEL}.`, "")).toBeNull();
  });
});

describe("tickets", () => {
  const operator = keyPair();
  const pc = pcIdentity();
  const claims = { label: pc.label, pk: pc.pk, iat: NOW_SEC, exp: NOW_SEC + YEAR };

  it("verifies a valid ticket", () => {
    const ticket = signTicket(claims, operator.privateKey);
    expect(ticket.startsWith("wkt1.")).toBe(true);
    expect(verifyTicket(ticket, operator.publicKey, { now: NOW })).toEqual({ ok: true, value: claims });
  });

  it("rejects tampered payloads, signatures and the wrong operator", () => {
    const ticket = signTicket(claims, operator.privateKey);
    expect(verifyTicket(tamper(ticket, 1), operator.publicKey, { now: NOW })).toMatchObject({ ok: false });
    expect(verifyTicket(tamper(ticket, 2), operator.publicKey, { now: NOW }))
      .toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyTicket(ticket, keyPair().publicKey, { now: NOW })).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyTicket(ticket.replace("wkt1.", "wki1."), operator.publicKey, { now: NOW }))
      .toEqual({ ok: false, reason: "malformed" });
    expect(verifyTicket("wkt1.x", operator.publicKey, { now: NOW })).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects expired tickets, allowing a little clock skew", () => {
    const ticket = signTicket({ ...claims, exp: NOW_SEC + 60 }, operator.privateKey);
    expect(verifyTicket(ticket, operator.publicKey, { now: NOW + 120_000 }).ok).toBe(true);
    expect(verifyTicket(ticket, operator.publicKey, { now: NOW + 3_600_000 }))
      .toEqual({ ok: false, reason: "expired" });
    const future = signTicket({ ...claims, iat: NOW_SEC + 3600, exp: NOW_SEC + YEAR }, operator.privateKey);
    expect(verifyTicket(future, operator.publicKey, { now: NOW })).toEqual({ ok: false, reason: "not-yet-valid" });
  });

  it("rejects a label that does not match the key, even when signed", () => {
    const other = pcIdentity();
    const ticket = signTicket({ ...claims, label: other.label }, operator.privateKey);
    expect(verifyTicket(ticket, operator.publicKey, { now: NOW })).toEqual({ ok: false, reason: "label-mismatch" });
  });
});

describe("invites", () => {
  const operator = keyPair();

  it("verifies a valid invite for 7 days", () => {
    const invite = mintInvite(operator.privateKey, { now: NOW, nonce: "abc" });
    expect(verifyInvite(invite, operator.publicKey, { now: NOW }))
      .toEqual({ ok: true, value: { exp: NOW_SEC + 7 * 86400, nonce: "abc" } });
    expect(verifyInvite(invite, operator.publicKey, { now: NOW + 6 * 86_400_000 }).ok).toBe(true);
  });

  it("gives each invite its own nonce", () => {
    const a = verifyInvite(mintInvite(operator.privateKey, { now: NOW }), operator.publicKey, { now: NOW });
    const b = verifyInvite(mintInvite(operator.privateKey, { now: NOW }), operator.publicKey, { now: NOW });
    expect(a.ok && b.ok && a.value.nonce !== b.value.nonce).toBe(true);
  });

  it("rejects tampered, foreign and expired invites", () => {
    const invite = mintInvite(operator.privateKey, { now: NOW });
    expect(verifyInvite(tamper(invite, 1), operator.publicKey, { now: NOW }).ok).toBe(false);
    expect(verifyInvite(tamper(invite, 2), operator.publicKey, { now: NOW }))
      .toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyInvite(invite, keyPair().publicKey, { now: NOW }).ok).toBe(false);
    expect(verifyInvite(invite, operator.publicKey, { now: NOW + 8 * 86_400_000 }))
      .toEqual({ ok: false, reason: "expired" });
    // A ticket is not an invite, even from the same operator.
    const pc = pcIdentity();
    const ticket = signTicket({ label: pc.label, pk: pc.pk, iat: NOW_SEC, exp: NOW_SEC + YEAR }, operator.privateKey);
    expect(verifyInvite(ticket, operator.publicKey, { now: NOW }).ok).toBe(false);
  });
});

describe("auth signature", () => {
  const pc = pcIdentity();

  it("verifies a signature over the hello nonce and label", () => {
    const nonce = newNonce();
    const sig = signAuth(pc.privateKey, nonce, pc.label);
    expect(verifyAuth(pc.pk, nonce, pc.label, sig)).toBe(true);
  });

  it("rejects a tampered signature or a different nonce", () => {
    const nonce = newNonce();
    const sig = signAuth(pc.privateKey, nonce, pc.label);
    expect(verifyAuth(pc.pk, newNonce(), pc.label, sig)).toBe(false);
    expect(verifyAuth(pc.pk, nonce, pc.label, tamper(sig, 0))).toBe(false);
    expect(verifyAuth(pc.pk, nonce, pc.label, "")).toBe(false);
    expect(verifyAuth(pc.pk, "short", pc.label, sig)).toBe(false);
  });

  it("rejects a label that does not match the key", () => {
    const other = pcIdentity();
    const nonce = newNonce();
    const sig = signAuth(pc.privateKey, nonce, other.label);
    expect(verifyAuth(pc.pk, nonce, other.label, sig)).toBe(false);
    // Another key cannot sign for this PC's label either.
    const forged = signAuth(other.privateKey, nonce, pc.label);
    expect(verifyAuth(pc.pk, nonce, pc.label, forged)).toBe(false);
    expect(verifyAuth(other.pk, nonce, pc.label, forged)).toBe(false);
  });
});

describe("status", () => {
  it("has an off status with every section 7 field", () => {
    expect(PHONE_RELAY_OFF).toEqual({
      state: "off",
      host: null,
      relayRttMs: null,
      poolIdle: 0,
      certNotAfter: null,
      lastError: null,
      nextRetryAt: null,
    });
  });
});
