import { createHash, createPublicKey } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { googleSubHash } from "../../shared/google-id-token.ts";
import { signAccountTicket, verifyAccountTicket } from "../../shared/relay-protocol.ts";
import { signAccountRequest } from "../src/accounts.ts";
import { loadConfig } from "../src/config.ts";
import { mintInvite } from "../../shared/relay-protocol.ts";
import { signEnrollment } from "../src/enroll.ts";
import { event, makeOperator, makePc, openControl, startRelay, ticketFor, type Harness, type Pc } from "./fixtures.ts";
import { makeIssuer, type TestIssuer } from "./google-issuer.ts";

const DESKTOP = "desktop-client.apps.googleusercontent.com";
const WEB = "web-client.apps.googleusercontent.com";
const ORIGIN = "https://signin.test";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: { label?: string; name?: string; error?: string; account?: string; ticket?: string } | { label: string; name: string }[] | null;
}

function call(
  harness: Harness,
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: harness.port,
        servername: `relay.${harness.base}`,
        ca: harness.ca.certPem,
        method,
        path,
        agent: false,
        headers: { host: `relay.${harness.base}`, ...opts.headers },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: raw ? JSON.parse(raw) : null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

function google(issuer: TestIssuer) {
  return { desktopClientId: DESKTOP, webClientId: WEB, signinOrigin: ORIGIN, keys: issuer };
}

interface IdClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  email_verified: boolean;
  iat: number;
  exp: number;
}

function idClaims(aud: string, sub: string, ageSec = 0): IdClaims {
  const now = Math.floor(Date.now() / 1000) - ageSec;
  return {
    iss: "https://accounts.google.com",
    aud,
    sub,
    email: `${sub}@example.com`,
    email_verified: true,
    iat: now,
    exp: now + 3600,
  };
}

async function register(harness: Harness, _issuer: TestIssuer, pc: Pc, token: string) {
  const ticket = ticketFor(pc, harness.operator);
  const body = JSON.stringify({
    idToken: token,
    ticket,
    pk: pc.pk,
    sig: signAccountRequest(pc.privateKey, token, ticket, pc.pk),
  });
  return call(harness, "POST", "/v1/account", { body, headers: { "content-type": "application/json" } });
}

function accountOf(body: Reply["body"]): string {
  if (!body || Array.isArray(body) || !body.account) throw new Error("no account ticket");
  return body.account;
}

function byLabel(a: { label: string }, b: { label: string }): number {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

function pcs(harness: Harness, token: string, origin?: string) {
  const headers: Record<string, string> = {};
  headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  return call(harness, "GET", "/v1/pcs", { headers });
}

describe("account directory", () => {
  it("issues a wka1 only for a fresh desktop token", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), limits: { accountPerIpPerHour: 100 } });
    const pc = makePc();
    const sub = "desktop-sub-100";
    const ok = await register(h, issuer, pc, issuer.sign(idClaims(DESKTOP, sub, 60)));
    expect(ok.status).toBe(200);
    const account = ok.body && "account" in ok.body ? ok.body.account : undefined;
    expect(account).toBeTruthy();
    const opened = verifyAccountTicket(String(account), createPublicKey(h.operator));
    expect(opened.ok && opened.value).toMatchObject({ label: pc.label, subHash: googleSubHash(sub) });
    expect(String(account)).not.toContain(sub);

    const web = await register(h, issuer, makePc(), issuer.sign(idClaims(WEB, sub)));
    expect(web).toMatchObject({ status: 403, body: { error: "bad-audience" } });
  });

  it("lists live pcs only for a web token", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), limits: { accountPerIpPerHour: 100 } });
    const sub = "shared-sub-200";
    const home = makePc();
    const work = makePc();
    const desktop = issuer.sign(idClaims(DESKTOP, sub));
    const homeAccount = await register(h, issuer, home, desktop);
    const workAccount = await register(h, issuer, work, desktop);
    const homeCtl = await openControl(h, home, { account: accountOf(homeAccount.body), name: "Home" });
    const workCtl = await openControl(h, work, { account: accountOf(workAccount.body), name: "Work" });
    const listed = await pcs(h, issuer.sign(idClaims(WEB, sub, 30 * 60)), ORIGIN);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(
      [
        { label: home.label, name: "Home" },
        { label: work.label, name: "Work" },
      ].sort(byLabel),
    );
    const desktopList = await pcs(h, desktop);
    expect(desktopList).toMatchObject({ status: 403, body: { error: "bad-audience" } });
    homeCtl.socket.destroy();
    workCtl.socket.destroy();
  });

  it("refuses a stale desktop token", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), limits: { accountPerIpPerHour: 100 } });
    const pc = makePc();
    const stale = await register(h, issuer, pc, issuer.sign(idClaims(DESKTOP, "stale-sub", 20 * 60)));
    expect(stale).toMatchObject({ status: 403, body: { error: "token-stale" } });
  });

  it("refuses a revoked label", async () => {
    const issuer = makeIssuer();
    const pc = makePc();
    const file = join(await mkdtemp(join(tmpdir(), "wink-revoked-")), "revoked");
    await writeFile(file, `${pc.label}\n`);
    h = await startRelay({ google: google(issuer), revokedLabelsFile: file, limits: { accountPerIpPerHour: 100 } });
    const res = await register(h, issuer, pc, issuer.sign(idClaims(DESKTOP, "revoked-sub")));
    expect(res).toMatchObject({ status: 403, body: { error: "revoked" } });
  });

  it("drops a pc from the directory when its control channel closes", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), limits: { accountPerIpPerHour: 100 } });
    const sub = "drop-sub";
    const pc = makePc();
    const issued = await register(h, issuer, pc, issuer.sign(idClaims(DESKTOP, sub)));
    const ctl = await openControl(h, pc, { account: accountOf(issued.body), name: "Desk" });
    const web = issuer.sign(idClaims(WEB, sub));
    expect(await pcs(h, web)).toMatchObject({ status: 200, body: [{ label: pc.label, name: "Desk" }] });
    ctl.socket.destroy();
    await h.waitLog(event("session-down", { label: pc.label }));
    expect(await pcs(h, web)).toMatchObject({ status: 200, body: [] });
  });

  it("drops a pc from the directory when auth sends account null, and keeps the session", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), limits: { accountPerIpPerHour: 100 } });
    const sub = "signout-sub";
    const pc = makePc();
    const issued = await register(h, issuer, pc, issuer.sign(idClaims(DESKTOP, sub)));
    const first = await openControl(h, pc, { account: accountOf(issued.body), name: "Desk" });
    const web = issuer.sign(idClaims(WEB, sub));
    expect((await pcs(h, web)).body).toEqual([{ label: pc.label, name: "Desk" }]);
    const second = await openControl(h, pc, { account: null });
    first.socket.on("error", () => {});
    expect(h.relay.hub.status(pc.label).online).toBe(true);
    expect((await pcs(h, web)).body).toEqual([]);
    second.socket.destroy();
  });

  it("allows CORS only for the sign-in origin", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), limits: { accountPerIpPerHour: 100, pcsPerIpPerMin: 100 } });
    const token = issuer.sign(idClaims(WEB, "cors-sub"));
    const ok = await pcs(h, token, ORIGIN);
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const evil = await pcs(h, token, "https://evil.test");
    expect(evil.status).toBe(200);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const health = await call(h, "GET", "/v1/healthz", { headers: { origin: ORIGIN } });
    expect(health.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await call(h, "OPTIONS", "/v1/pcs", {
      headers: { origin: ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(String(preflight.headers["access-control-allow-headers"])).toMatch(/authorization/i);
    const blocked = await call(h, "OPTIONS", "/v1/pcs", { headers: { origin: "https://evil.test" } });
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers an OPTIONS preflight before spending a directory rate-limit token", async () => {
    const issuer = makeIssuer();
    h = await startRelay({
      google: google(issuer),
      limits: { pcsPerIpPerMin: 1, connPerIpPerSec: 100, connPerIpBurst: 100 },
    });
    const headers = {
      origin: ORIGIN,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    };
    const first = await call(h, "OPTIONS", "/v1/pcs", { headers });
    const second = await call(h, "OPTIONS", "/v1/pcs", { headers });
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(first.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const token = issuer.sign(idClaims(WEB, "preflight-sub"));
    expect((await pcs(h, token, ORIGIN)).status).toBe(200);
    expect((await pcs(h, token, ORIGIN)).status).toBe(429);
  });

  it("rate-limits directory reads to 30 a minute per IP", async () => {
    const issuer = makeIssuer();
    h = await startRelay({
      google: google(issuer),
      limits: { pcsPerIpPerMin: 30, connPerIpPerSec: 100, connPerIpBurst: 100 },
    });
    const token = issuer.sign(idClaims(WEB, "rate-sub"));
    const results = [];
    for (let i = 0; i < 31; i++) results.push(await pcs(h, token));
    expect(results.slice(0, 30).every((res) => res.status === 200)).toBe(true);
    expect(results[30]).toMatchObject({ status: 429, body: { error: "rate-limited" } });
  });

  it("connects a pc with an expired, malformed, or unverifiable account ticket and leaves it unlisted", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), limits: { accountPerIpPerHour: 100, pcsPerIpPerMin: 100 } });
    const web = issuer.sign(idClaims(WEB, "bad-ticket-sub"));
    const now = Math.floor(Date.now() / 1000);
    const stranger = makeOperator();
    const harness = h;
    const cases: { reason: string; ticket: (pc: Pc) => string }[] = [
      {
        reason: "account-expired",
        ticket: (pc) =>
          signAccountTicket(
            { label: pc.label, subHash: googleSubHash("expired-sub"), iat: now - 10_000, exp: now - 4_000 },
            harness.operator,
          ),
      },
      { reason: "account-malformed", ticket: () => "wka1.%%%.sig" },
      {
        reason: "account-bad-signature",
        ticket: (pc) =>
          signAccountTicket(
            { label: pc.label, subHash: googleSubHash("forged-sub"), iat: now, exp: now + 3600 },
            stranger,
          ),
      },
      {
        reason: "account-not-yet-valid",
        ticket: (pc) =>
          signAccountTicket(
            { label: pc.label, subHash: googleSubHash("early-sub"), iat: now + 10_000, exp: now + 20_000 },
            harness.operator,
          ),
      },
    ];
    for (const row of cases) {
      const pc = makePc();
      const account = row.ticket(pc);
      const ctl = await openControl(h, pc, { account, name: "Desk" });
      expect(ctl.ready.account).toBeUndefined();
      expect(h.relay.hub.status(pc.label).online).toBe(true);
      expect((await pcs(h, web)).body).toEqual([]);
      const subHash = createHash("sha256").update(account, "utf8").digest("base64url");
      await h.waitLog(event("account-ignored", { label: pc.label, reason: row.reason, subHash }));
      expect(h.logs.join("\n")).not.toContain(account);
      ctl.socket.destroy();
    }
  });

  it("leaves a pc that sends no account connected and unlisted", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), limits: { accountPerIpPerHour: 100, enrollPerIpPerHour: 20 } });
    const old = makePc();
    const ctl = await openControl(h, old);
    expect(h.relay.hub.status(old.label).online).toBe(true);
    const listed = await pcs(h, issuer.sign(idClaims(WEB, "nobody")));
    expect(listed).toMatchObject({ status: 200, body: [] });
    const invite = mintInvite(h.operator);
    const enroll = await call(h, "POST", "/v1/enroll", {
      body: JSON.stringify({ invite, pk: old.pk, sig: signEnrollment(old.privateKey, invite, old.pk) }),
      headers: { "content-type": "application/json" },
    });
    expect(enroll.status).toBe(200);
    ctl.socket.destroy();
  });

  it("404s both routes when the config has no google block", async () => {
    h = await startRelay();
    const missing = await call(h, "POST", "/v1/account", {
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(missing).toMatchObject({ status: 404, body: { error: "not-found" } });
    expect(await call(h, "GET", "/v1/pcs")).toMatchObject({ status: 404, body: { error: "not-found" } });
    expect(await call(h, "GET", "/v1/healthz")).toMatchObject({ status: 200 });
  });

  it("loads a google block and rejects a bad origin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wink-cfg-"));
    const path = join(dir, "config.json");
    const acme = { directoryUrl: "https://ca.invalid/directory", termsOfServiceAgreed: true };
    await writeFile(
      path,
      JSON.stringify({
        base: "wink.example.com",
        acme,
        google: { desktopClientId: DESKTOP, webClientId: WEB, signinOrigin: "https://wink.edwardyi.dev" },
      }),
    );
    const config = await loadConfig(path);
    expect(config.google).toEqual({
      desktopClientId: DESKTOP,
      webClientId: WEB,
      signinOrigin: "https://wink.edwardyi.dev",
    });
    await writeFile(
      path,
      JSON.stringify({
        base: "wink.example.com",
        acme,
        google: { desktopClientId: DESKTOP, webClientId: WEB, signinOrigin: "https://wink.edwardyi.dev/signin" },
      }),
    );
    await expect(loadConfig(path)).rejects.toThrow(/config is invalid/);
  });
});
