import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, readyMessageSchema, type TeamSnag } from "../../shared/relay-protocol.ts";
import { SNAG_KEEP_MS, SNAG_LEASE_MS, SnagStore } from "../src/snags.ts";
import { TeamLog } from "../src/team.ts";
import { event, makePc, openControl, startRelay, type Control, type Harness } from "./fixtures.ts";
import { makeIssuer, type IdClaims, type TestIssuer } from "./google-issuer.ts";

const DESKTOP = "desktop-client.apps.googleusercontent.com";
const WEB = "web-client.apps.googleusercontent.com";
const OWNER = "owner@example.com";
const SECRET = "tail-text-that-must-never-be-logged";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wink-snags-"));
  dirs.push(dir);
  return dir;
}

const google = (issuer: TestIssuer) => ({ desktopClientId: DESKTOP, webClientId: WEB, signinOrigin: "https://signin.test", keys: issuer });

function claims(over: IdClaims = {}): IdClaims {
  const now = Math.floor(Date.now() / 1000);
  return { iss: "https://accounts.google.com", aud: WEB, sub: "owner-sub", email: OWNER, email_verified: true, iat: now, exp: now + 3600, ...over };
}

let seq = 0;
function snag(over: Partial<TeamSnag> = {}): TeamSnag {
  seq += 1;
  return {
    id: seq.toString(16).padStart(32, "0"),
    at: Date.now(),
    event: "stalled",
    build: "1.0.217",
    os: "win32",
    teacher: "claude:claude-opus-5-5",
    worker: "codex",
    pane8: "3fa91c02",
    label: "INVOICE-EXPORT",
    minutes: 102,
    notes: [["stalled", 100]],
    detail: "3 STALLED notes, no screen change or report since",
    tail: SECRET,
    ...over,
  };
}

function post(harness: Harness, path: string, token: string | null, body?: { ids: string[] }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = { host: `relay.${harness.base}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = request(
      { host: "127.0.0.1", port: harness.port, servername: `relay.${harness.base}`, ca: harness.ca.certPem, method: "POST", path, agent: false, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function stillUp(ctl: Control): Promise<void> {
  ctl.socket.write(encodeFrame({ type: "ping" }));
  expect(await ctl.reader.next()).toEqual({ type: "pong" });
}

describe("snag frames", () => {
  it("offers snags only on a team relay, and an old PC strips the offer and stays up", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), teamOwnerEmail: OWNER });
    const ctl = await openControl(h, makePc());
    expect(ctl.ready.snags).toBe(true);
    const oldPc = readyMessageSchema.omit({ snags: true });
    expect(oldPc.parse(ctl.ready)).not.toHaveProperty("snags");
    await stillUp(ctl);
    ctl.socket.destroy();
    await h.close();

    h = await startRelay();
    const plain = await openControl(h, makePc());
    expect(plain.ready).not.toHaveProperty("snags");
    plain.socket.destroy();
  });

  it("stores a snag, answers snagged and drops a duplicate", async () => {
    h = await startRelay({ google: google(makeIssuer()), teamOwnerEmail: OWNER });
    const pc = makePc();
    const ctl = await openControl(h, pc);
    const one = snag();
    ctl.socket.write(encodeFrame({ type: "snag", data: one }));
    expect(await ctl.reader.next()).toEqual({ type: "snagged", id: one.id });
    ctl.socket.write(encodeFrame({ type: "snag", data: one }));
    expect(await ctl.reader.next()).toEqual({ type: "snagged", id: one.id });
    await h.waitLog(event("snag", { label: pc.label, reason: "duplicate" }));
    await stillUp(ctl);
    expect(h.logs.join("\n")).not.toContain(SECRET);
    ctl.socket.destroy();
  });

  it("drops a malformed or oversize snag without closing the channel", async () => {
    h = await startRelay({ google: google(makeIssuer()), teamOwnerEmail: OWNER });
    const pc = makePc();
    const ctl = await openControl(h, pc);
    ctl.socket.write(encodeFrame({ type: "snag", data: { ...snag(), event: "nope" } }));
    ctl.socket.write(encodeFrame({ type: "snag", data: "x" }));
    await h.waitLog(event("snag", { label: pc.label, reason: "bad-snag" }), 2);
    ctl.socket.write(encodeFrame({ type: "snag", data: { ...snag(), extra: "y".repeat(10 * 1024) } }));
    await h.waitLog(event("snag", { label: pc.label, reason: "too-large" }));
    await stillUp(ctl);
    expect(h.relay.hub.status(pc.label).online).toBe(true);
    ctl.socket.destroy();
  });

  it("drops a snag on a relay without a team owner and stays up", async () => {
    h = await startRelay();
    const pc = makePc();
    const ctl = await openControl(h, pc);
    ctl.socket.write(encodeFrame({ type: "snag", data: snag() }));
    await h.waitLog(event("snag", { label: pc.label, reason: "snags-off" }));
    await stillUp(ctl);
    ctl.socket.destroy();
  });
});

describe("POST /v1/team/snags", () => {
  it("leases claims to the owner, joins the PC, and deletes on ack", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), teamOwnerEmail: OWNER, limits: { pcsPerIpPerMin: 100 } });
    const pc = makePc();
    const ctl = await openControl(h, pc);
    const one = snag();
    ctl.socket.write(encodeFrame({ type: "snag", data: one }));
    await ctl.reader.next();
    const owner = issuer.sign(claims());

    expect((await post(h, "/v1/team/snags/claim", null)).status).toBe(401);
    expect((await post(h, "/v1/team/snags/claim", issuer.sign(claims({ email: "someone@example.com" })))).status).toBe(403);
    const claimed = await post(h, "/v1/team/snags/claim", owner);
    expect(claimed.status).toBe(200);
    expect(JSON.parse(claimed.body)).toEqual({ snags: [{ ...one, pc: { label: pc.label, name: pc.label, person: "" } }] });
    expect(JSON.parse((await post(h, "/v1/team/snags/claim", owner)).body)).toEqual({ snags: [] });

    expect((await post(h, "/v1/team/snags/ack", owner, { ids: ["nope"] })).status).toBe(400);
    expect(JSON.parse((await post(h, "/v1/team/snags/ack", owner, { ids: [one.id] })).body)).toEqual({ acked: 1 });
    await vi.waitFor(async () => expect(await readFile(join(h!.dataDir, "team-snags"), "utf8")).toBe(""));
    await h.waitLog(event("snags-acked", { count: 1 }));
    expect(h.logs.join("\n")).not.toContain(SECRET);
    expect(h.logs.join("\n")).not.toMatch(/example\.com/i);
    ctl.socket.destroy();
  });

  it("404s without a team owner", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer) });
    expect((await post(h, "/v1/team/snags/claim", issuer.sign(claims()))).status).toBe(404);
  });
});

describe("snag store", () => {
  const LABEL = "aaaaaaaaaaaaaaaa";

  it("caps each label per day, survives a reload, and re-offers a lapsed lease", async () => {
    const dir = await tempDir();
    let t = Date.parse("2026-10-31T01:00:00Z");
    const now = () => t;
    const store = await SnagStore.open(dir, 20, now);
    const results = Array.from({ length: 21 }, () => store.add(LABEL, snag()));
    expect(results.filter((r) => r === "stored")).toHaveLength(20);
    expect(results.at(-1)).toBe("over-cap");
    expect(store.add("bbbbbbbbbbbbbbbb", snag())).toBe("stored");
    expect(store.claim()).toHaveLength(21);
    await store.close();

    const again = await SnagStore.open(dir, 20, now);
    expect(again.claim()).toHaveLength(0);
    t += SNAG_LEASE_MS;
    expect(again.claim()).toHaveLength(21);
    t += 24 * 60 * 60 * 1000;
    expect(again.add(LABEL, snag())).toBe("stored");
    await again.close();
  });

  it("drops snags past 14 days and the oldest past 4 MB", async () => {
    let t = Date.parse("2026-10-31T01:00:00Z");
    const store = await SnagStore.open(await tempDir(), 10_000, () => t);
    store.add(LABEL, snag());
    t += SNAG_KEEP_MS + 1;
    expect(store.claim()).toHaveLength(0);
    const first = snag({ tail: "x".repeat(3000) });
    store.add(LABEL, first);
    for (let i = 0; i < 1500; i++) store.add(LABEL, snag({ tail: "x".repeat(3000) }));
    const held = store.claim();
    expect(held.length).toBeLessThan(1500);
    expect(held.some((entry) => entry.snag.id === first.id)).toBe(false);
    await store.close();
  });

  it("names a PC and its person as the Team page does", async () => {
    const team = await TeamLog.open(await tempDir());
    expect(team.who(LABEL)).toEqual({ name: LABEL, person: "" });
    team.setName(LABEL, " Studio ");
    team.setAccount(LABEL, "A".repeat(43), "Jisoo");
    expect(team.who(LABEL)).toEqual({ name: "Studio", person: "Jisoo" });
    await team.close();
  });
});
