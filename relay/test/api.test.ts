import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:https";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintInvite, verifyTicket } from "../../shared/relay-protocol.ts";
import { Enroller, signEnrollment } from "../src/enroll.ts";
import { InviteStore, nonceHash } from "../src/invites.ts";
import { event, makePc, openControl, startRelay, type Harness, type Pc } from "./fixtures.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, string | number | boolean | null>;
  raw: string;
}

function call(
  h: Harness,
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string>; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: h.port,
        servername: `relay.${h.base}`,
        ca: h.ca.certPem,
        method,
        path,
        agent: false,
        headers: { host: opts.host ?? `relay.${h.base}`, ...opts.headers },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(raw), raw }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const enrollBody = (invite: string, pc: Pc, signer = pc) =>
  JSON.stringify({ invite, pk: pc.pk, sig: signEnrollment(signer.privateKey, invite, pc.pk) });

const enroll = (h: Harness, body: string) =>
  call(h, "POST", "/v1/enroll", { body, headers: { "content-type": "application/json" } });

describe("enrollment", () => {
  it("issues a ticket for the key's own label that then authenticates a control channel", async () => {
    h = await startRelay();
    const pc = makePc();
    const res = await enroll(h, enrollBody(mintInvite(h.operator), pc));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["ticket"]);
    const ticket = verifyTicket(String(res.body.ticket), createPublicKey(h.operator));
    expect(ticket.ok && ticket.value.label).toBe(pc.label);
    const ctl = await openControl(h, pc, { ticket: String(res.body.ticket) });
    expect(ctl.ready.session).toBeTruthy();
    ctl.socket.destroy();
    await h.waitLog(event("enrolled", { label: pc.label }));
  });

  it("rejects a replayed invite, also after a restart, and stores only a nonce hash", async () => {
    h = await startRelay();
    const nonce = "nonce-under-test";
    const invite = mintInvite(h.operator, { nonce });
    expect((await enroll(h, enrollBody(invite, makePc()))).status).toBe(200);
    const again = await enroll(h, enrollBody(invite, makePc()));
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "invite-used" });

    const stored = await readFile(join(h.dataDir, "used-invites"), "utf8");
    expect(stored).toContain(nonceHash(nonce));
    expect(stored).not.toContain(nonce);
    const reopened = await InviteStore.open(h.dataDir);
    expect(reopened.has(nonce)).toBe(true);
  });

  it("lets exactly one of many concurrent requests use an invite", async () => {
    h = await startRelay({ limits: { enrollPerIpPerHour: 100 } });
    const invite = mintInvite(h.operator);
    const results = await Promise.all(Array.from({ length: 12 }, () => enroll(h!, enrollBody(invite, makePc()))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(11);
  });

  it("does not burn an invite on a request that fails validation", async () => {
    h = await startRelay({ limits: { enrollPerIpPerHour: 100 } });
    const invite = mintInvite(h.operator);
    const pc = makePc();
    // Signed by a different key than `pk`.
    const bad = await enroll(h, enrollBody(invite, pc, makePc()));
    expect(bad).toMatchObject({ status: 403, body: { error: "bad-signature" } });
    // Signature over a different invite.
    const other = mintInvite(h.operator);
    const wrongPayload = JSON.stringify({ invite, pk: pc.pk, sig: signEnrollment(pc.privateKey, other, pc.pk) });
    expect((await enroll(h, wrongPayload)).status).toBe(403);
    expect((await enroll(h, enrollBody(invite, pc))).status).toBe(200);
  });

  it("rejects foreign, expired and malformed invites and bad bodies", async () => {
    h = await startRelay({ limits: { enrollPerIpPerHour: 100, maxBodyBytes: 4096 } });
    const pc = makePc();
    const foreign = mintInvite(generateKeyPairSync("ed25519").privateKey);
    expect(await enroll(h, enrollBody(foreign, pc))).toMatchObject({ status: 403, body: { error: "invite-invalid" } });
    const expired = mintInvite(h.operator, { now: Date.now() - 30 * 86400_000, ttlSec: 60 });
    expect(await enroll(h, enrollBody(expired, pc))).toMatchObject({ status: 403, body: { error: "invite-expired" } });
    expect((await enroll(h, "{not json")).status).toBe(400);
    expect((await enroll(h, JSON.stringify({ invite: "x", pk: pc.pk }))).status).toBe(400);
    const extra = JSON.stringify({ ...JSON.parse(enrollBody(mintInvite(h.operator), pc)), more: 1 });
    expect((await enroll(h, extra)).status).toBe(400);
    expect((await enroll(h, "x".repeat(5000))).status).toBe(413);
    const wrongType = await call(h, "POST", "/v1/enroll", { body: enrollBody(mintInvite(h.operator), pc) });
    expect(wrongType.status).toBe(415);
  });

  it("refuses revoked labels", async () => {
    const pc = makePc();
    h = await startRelay();
    const file = join(await mkdtemp(join(tmpdir(), "wink-revoked-")), "revoked");
    await writeFile(file, `${pc.label}\n`);
    await h.close();
    h = await startRelay({ revokedLabelsFile: file });
    expect(await enroll(h, enrollBody(mintInvite(h.operator), pc))).toMatchObject({
      status: 403,
      body: { error: "revoked" },
    });
  });

  it("rate limits enrollment per IP", async () => {
    h = await startRelay({ limits: { enrollPerIpPerHour: 2 } });
    for (let i = 0; i < 2; i++) expect((await enroll(h, "{}")).status).toBe(400);
    expect((await enroll(h, enrollBody(mintInvite(h.operator), makePc()))).status).toBe(429);
  });

  it("keeps an invite consumed when the store cannot persist", async () => {
    const store = await InviteStore.open(await mkdtemp(join(tmpdir(), "wink-store-")));
    const operator = generateKeyPairSync("ed25519").privateKey;
    const enroller = new Enroller({
      operatorPrivateKey: operator,
      operatorPublicKey: createPublicKey(operator),
      store,
      isRevoked: () => false,
    });
    store.persist = () => Promise.reject(new Error("disk full"));
    const invite = mintInvite(operator);
    const pc = makePc();
    const body = JSON.parse(enrollBody(invite, pc));
    expect(await enroller.enroll(body)).toMatchObject({ ok: false, status: 503 });
    expect(await enroller.enroll(body)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("status and health", () => {
  it("serves healthz and a bounded {online, since} status", async () => {
    h = await startRelay();
    expect(await call(h, "GET", "/v1/healthz")).toMatchObject({ status: 200, body: { ok: true } });
    const pc = makePc();
    expect((await call(h, "GET", `/v1/status/${pc.label}`)).body).toEqual({ online: false, since: null });
    const ctl = await openControl(h, pc);
    const online = await call(h, "GET", `/v1/status/${pc.label}`, {
      headers: { origin: `https://${pc.label}.${h.base}` },
    });
    expect(Object.keys(online.body).sort()).toEqual(["online", "since"]);
    expect(online.body.online).toBe(true);
    expect(online.body.since).toEqual(expect.any(Number));
    expect(online.headers["access-control-allow-origin"]).toBe(`https://${pc.label}.${h.base}`);
    expect(online.raw.length).toBeLessThan(64);
    const foreign = await call(h, "GET", `/v1/status/${pc.label}`, { headers: { origin: "https://evil.example" } });
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
    ctl.socket.destroy();
    await h.waitLog(event("session-down", { label: pc.label }));
    expect((await call(h, "GET", `/v1/status/${pc.label}`)).body.online).toBe(false);
  });

  it("serves the API only for Host relay.<base> and valid paths", async () => {
    h = await startRelay({ limits: { statusPerIpPerMin: 2 } });
    const pc = makePc();
    expect((await call(h, "GET", "/v1/healthz", { host: `${pc.label}.${h.base}` })).status).toBe(421);
    expect((await call(h, "GET", "/v1/status/NOT-A-LABEL")).status).toBe(404);
    expect((await call(h, "GET", "/v1/other")).status).toBe(404);
    expect((await call(h, "POST", "/v1/healthz")).status).toBe(405);
    expect((await call(h, "GET", `/v1/status/${pc.label}`)).status).toBe(200);
    expect((await call(h, "GET", `/v1/status/${pc.label}`)).status).toBe(429);
  });
});
