import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  GPAIR_CLEAR_COOKIE,
  GPAIR_TTL_MS,
  MAX_CHALLENGES,
  PhoneGoogle,
  challengeMark,
  gpairCookie,
  pairNonce,
} from "./phone-google.ts";
import { FakeClock } from "./phone-relay/testing/fake-clock.ts";
import { DESKTOP_CLIENT, FakeGoogle, WEB_CLIENT } from "./phone-relay/testing/google-issuer.ts";

const LABEL = "abcdefghijklmnop";
const OWNER = "sub-owner";
const SIGNIN = "https://wink.test/signin";

const createDigest = (text: string) => createHash("sha256").update(text, "utf8").digest("base64url");

function rig(options: { webClientId?: string | null; owner?: string | null } = {}) {
  const clock = new FakeClock();
  const google = new FakeGoogle();
  const pc = { owner: options.owner === undefined ? OWNER : options.owner };
  const phoneGoogle = new PhoneGoogle({
    clock,
    webClientId: options.webClientId === undefined ? WEB_CLIENT : options.webClientId,
    owner: () => (pc.owner ? { sub: pc.owner } : null),
    keys: google.keys,
  });
  /** What one browser does: start, then the sign-in page asks Google for the label-bound nonce. */
  const begin = (label = LABEL) => {
    const { cookie, location } = phoneGoogle.start(LABEL, SIGNIN);
    const challenge = gpairCookie(cookie.split(";")[0]);
    const link = new URL(location);
    const nonce = pairNonce(label, link.searchParams.get("m")!);
    return { challenge, cookie, link, token: (claims: Parameters<FakeGoogle["token"]>[0] = {}) => google.token({ sub: OWNER, nonce, ...claims }, clock.now()) };
  };
  return { clock, google, pc, phoneGoogle, begin };
}

describe("phone Google sign-in", () => {
  it("admits a token whose nonce binds this browser's challenge to this PC's label", async () => {
    const { phoneGoogle, begin } = rig();
    const browser = begin();
    expect(`${browser.link.origin}${browser.link.pathname}`).toBe(SIGNIN);
    expect([...browser.link.searchParams.keys()]).toEqual(["pc", "m"]);
    expect(browser.link.searchParams.get("pc")).toBe(LABEL);
    expect(browser.link.searchParams.get("m")).toBe(challengeMark(browser.challenge!));
    expect(browser.link.toString()).not.toContain(browser.challenge);
    expect(await phoneGoogle.verify(browser.challenge, browser.token(), LABEL)).toEqual({ ok: true });
  });

  it("sets a host-only, secure, http-only, lax challenge cookie for ten minutes", () => {
    const { begin } = rig();
    const { cookie, challenge } = begin();
    expect(cookie).toMatch(/^__Host-wink_gpair=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    expect(challenge).toHaveLength(43);
    expect(GPAIR_CLEAR_COOKIE).toBe("__Host-wink_gpair=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  });

  it("follows the nonce rule the sign-in page uses", () => {
    expect(challengeMark("c")).toBe(createDigest("wink-gpair/1\0c"));
    expect(pairNonce(LABEL, "m")).toBe(createDigest(`wink-gpair/1\0${LABEL}\0m`));
  });

  it("refuses a token made for another browser's cookie", async () => {
    const { phoneGoogle, begin } = rig();
    const victim = begin();
    const attacker = begin();
    expect(await phoneGoogle.verify(attacker.challenge, victim.token(), LABEL)).toEqual({ ok: false, error: "nonce-mismatch" });
    expect(await phoneGoogle.verify(victim.challenge, victim.token(), LABEL)).toEqual({ ok: true });
  });

  it("refuses a nonce bound to another label", async () => {
    const { phoneGoogle, begin } = rig();
    const browser = begin("qrstuvwxyzabcdef");
    expect(await phoneGoogle.verify(browser.challenge, browser.token(), LABEL)).toEqual({ ok: false, error: "nonce-mismatch" });
  });

  it("refuses a replay after the challenge is consumed", async () => {
    const { phoneGoogle, begin } = rig();
    const browser = begin();
    const token = browser.token();
    expect(await phoneGoogle.verify(browser.challenge, token, LABEL)).toEqual({ ok: true });
    expect(await phoneGoogle.verify(browser.challenge, token, LABEL)).toEqual({ ok: false, error: "no-challenge" });
  });

  it("admits one of two requests that race on the same challenge", async () => {
    const { phoneGoogle, begin } = rig();
    const browser = begin();
    const token = browser.token();
    const results = await Promise.all([phoneGoogle.verify(browser.challenge, token, LABEL), phoneGoogle.verify(browser.challenge, token, LABEL)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("refuses another Google account", async () => {
    const { phoneGoogle, begin } = rig();
    const browser = begin();
    expect(await phoneGoogle.verify(browser.challenge, browser.token({ sub: "sub-stranger" }), LABEL)).toEqual({ ok: false, error: "wrong-account" });
  });

  it("refuses a Desktop-client token", async () => {
    const { phoneGoogle, begin } = rig();
    const browser = begin();
    expect(await phoneGoogle.verify(browser.challenge, browser.token({ aud: DESKTOP_CLIENT }), LABEL)).toEqual({ ok: false, error: "bad-audience" });
  });

  it("refuses an expired token", async () => {
    const { phoneGoogle, begin, clock } = rig();
    const browser = begin();
    const iat = Math.floor(clock.now() / 1000) - 7200;
    expect(await phoneGoogle.verify(browser.challenge, browser.token({ iat, exp: iat + 3600 }), LABEL)).toEqual({ ok: false, error: "expired" });
  });

  it("refuses a challenge older than ten minutes", async () => {
    const { phoneGoogle, begin, clock } = rig();
    const browser = begin();
    clock.jump(GPAIR_TTL_MS);
    expect(await phoneGoogle.verify(browser.challenge, browser.token(), LABEL)).toEqual({ ok: false, error: "no-challenge" });
  });

  it("refuses when this PC is signed out of Google or has no Web client", async () => {
    const signedOut = rig({ owner: null });
    expect(signedOut.phoneGoogle.configured()).toBe(false);
    const browser = signedOut.begin();
    expect(await signedOut.phoneGoogle.verify(browser.challenge, browser.token(), LABEL)).toEqual({ ok: false, error: "unavailable" });
    expect(rig({ webClientId: null }).phoneGoogle.configured()).toBe(false);
    expect(rig().phoneGoogle.configured()).toBe(true);
  });

  it("refuses a PC that signed out while the token was checked", async () => {
    const { phoneGoogle, begin, pc } = rig();
    const browser = begin();
    const pending = phoneGoogle.verify(browser.challenge, browser.token(), LABEL);
    pc.owner = null;
    expect(await pending).toEqual({ ok: false, error: "unavailable" });
  });

  it("refuses without a challenge cookie, or with two", async () => {
    const { phoneGoogle, begin } = rig();
    const browser = begin();
    expect(await phoneGoogle.verify(null, browser.token(), LABEL)).toEqual({ ok: false, error: "no-challenge" });
    expect(await phoneGoogle.verify("made-up", browser.token(), LABEL)).toEqual({ ok: false, error: "no-challenge" });
    expect(gpairCookie(`__Host-wink_gpair=a; __Host-wink_gpair=b`)).toBeNull();
    expect(gpairCookie(`other=1; __Host-wink_gpair=${browser.challenge}`)).toBe(browser.challenge);
  });

  it("keeps a bounded number of open challenges, dropping the oldest", async () => {
    const { phoneGoogle, begin } = rig();
    const first = begin();
    for (let i = 0; i < MAX_CHALLENGES; i++) begin();
    expect(await phoneGoogle.verify(first.challenge, first.token(), LABEL)).toEqual({ ok: false, error: "no-challenge" });
  });

  it("replays one admission for the same challenge and credential until it is dropped", async () => {
    const { phoneGoogle, begin, clock } = rig();
    const browser = begin();
    const token = browser.token();
    const admitted = { phone: { id: "p1", name: "Pixel" }, token: "phone-token" };
    expect(await phoneGoogle.verify(browser.challenge, token, LABEL)).toEqual({ ok: true });
    phoneGoogle.remember(browser.challenge!, token, admitted);
    expect(phoneGoogle.replay(browser.challenge, token)).toEqual({ ok: true, ...admitted });
    expect(phoneGoogle.replay(browser.challenge, `${token}x`)).toEqual({ ok: false, error: "no-challenge" });
    expect(phoneGoogle.replay(null, token)).toBeNull();
    expect(phoneGoogle.replay("other-cookie", token)).toBeNull();

    const revoked = begin();
    const revokedToken = revoked.token();
    expect(await phoneGoogle.verify(revoked.challenge, revokedToken, LABEL)).toEqual({ ok: true });
    phoneGoogle.remember(revoked.challenge!, revokedToken, { phone: { id: "p2", name: "Other" }, token: "other-token" });
    phoneGoogle.dropPhone("p2");
    expect(phoneGoogle.replay(revoked.challenge, revokedToken)).toEqual({ ok: false, error: "no-challenge" });
    expect(phoneGoogle.replay(browser.challenge, token)).toEqual({ ok: true, ...admitted });

    phoneGoogle.dropReplays();
    expect(phoneGoogle.replay(browser.challenge, token)).toEqual({ ok: false, error: "no-challenge" });

    const expiring = begin();
    const expiringToken = expiring.token();
    expect(await phoneGoogle.verify(expiring.challenge, expiringToken, LABEL)).toEqual({ ok: true });
    phoneGoogle.remember(expiring.challenge!, expiringToken, admitted);
    clock.jump(GPAIR_TTL_MS);
    expect(phoneGoogle.replay(expiring.challenge, expiringToken)).toBeNull();
    expect(await phoneGoogle.verify(expiring.challenge, expiringToken, LABEL)).toEqual({ ok: false, error: "no-challenge" });
  });

  it("keeps a bounded number of Google replays, dropping the oldest", async () => {
    const { phoneGoogle, begin } = rig();
    const first = begin();
    const firstToken = first.token();
    expect(await phoneGoogle.verify(first.challenge, firstToken, LABEL)).toEqual({ ok: true });
    phoneGoogle.remember(first.challenge!, firstToken, { phone: { id: "first", name: "A" }, token: "t0" });
    for (let i = 0; i < MAX_CHALLENGES; i++) {
      const browser = begin();
      const token = browser.token();
      expect(await phoneGoogle.verify(browser.challenge, token, LABEL)).toEqual({ ok: true });
      phoneGoogle.remember(browser.challenge!, token, { phone: { id: `p${i}`, name: "A" }, token: `t${i}` });
    }
    expect(phoneGoogle.replay(first.challenge, firstToken)).toBeNull();
  });
});
