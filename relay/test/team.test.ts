import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { googleSubHash } from "../../shared/google-id-token.ts";
import { authMessageSchema, buildSetupCode, mintInvite, parseSetupCode } from "../../shared/relay-protocol.ts";
import { loadConfig } from "../src/config.ts";
import { signEnrollment } from "../src/enroll.ts";
import { TEAM_KEEP_MS, TeamLog, type TeamStats } from "../src/team.ts";
import { event, makePc, openControl, openData, startRelay, type Harness, type Pc } from "./fixtures.ts";
import { makeIssuer, type IdClaims, type TestIssuer } from "./google-issuer.ts";
import { phoneConnect, serveInner } from "./pc-side.ts";

const DESKTOP = "desktop-client.apps.googleusercontent.com";
const WEB = "web-client.apps.googleusercontent.com";
const ORIGIN = "https://signin.test";
const OWNER = "owner@example.com";
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-12T01:00:00Z");

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wink-team-"));
  dirs.push(dir);
  return dir;
}

function google(issuer: TestIssuer) {
  return { desktopClientId: DESKTOP, webClientId: WEB, signinOrigin: ORIGIN, keys: issuer };
}

function claims(over: IdClaims = {}): IdClaims {
  const now = Math.floor(Date.now() / 1000);
  return { iss: "https://accounts.google.com", aud: WEB, sub: "owner-sub", email: OWNER, email_verified: true, iat: now, exp: now + 3600, ...over };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(harness: Harness, path: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<Reply> {
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
        headers: { host: `relay.${harness.base}`, ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// SAFETY: a 200 from /v1/team is TeamLog.stats() as JSON.
const statsOf = (reply: Reply): TeamStats => JSON.parse(reply.body) as TeamStats;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("team session log", () => {
  it("records control up and down and each phone splice on a live relay", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), teamOwnerEmail: OWNER });
    const pc = makePc();
    const ctl = await openControl(h, pc);
    const data = await openData(h, ctl.ready.session, ctl.ready.poolToken);
    await h.waitLog(event("join", { label: pc.label }));
    const inner = serveInner(data, await h.ca.issue(`${pc.label}.${h.base}`));
    const phone = await phoneConnect(h, pc.label);
    await inner;

    const during = statsOf(await get(h, "/v1/team", bearer(issuer.sign(claims()))));
    expect(during.pcs).toMatchObject([{ label: pc.label, name: pc.label, online: true }]);
    expect(during.pcs[0]?.phone.at(-1)?.count).toBe(1);

    phone.destroy();
    await h.waitLog(event("splice-end", { label: pc.label }));
    ctl.socket.destroy();
    await h.waitLog(event("session-down", { label: pc.label }));
    const journal = join(h.dataDir, "team-sessions");
    await vi.waitFor(async () => {
      const lines = (await readFile(journal, "utf8")).trim().split("\n");
      expect(lines.map((line) => line.split(" ").slice(0, 2).join(" ")).sort()).toEqual([`pc ${pc.label}`, `phone ${pc.label}`]);
    });
    for (const line of (await readFile(journal, "utf8")).trim().split("\n")) {
      const [, , start, end] = line.split(" ");
      expect(Number(end)).toBeGreaterThanOrEqual(Number(start));
    }
    const after = statsOf(await get(h, "/v1/team", bearer(issuer.sign(claims()))));
    expect(after.pcs).toMatchObject([{ label: pc.label, online: false }]);
    expect(after.pcs[0]?.lastSeen).toBeGreaterThan(0);
  });

  it("names a pc as the phone list does, else by label", async () => {
    const team = await TeamLog.open(await tempDir(), clock().now);
    team.pcUp("aaaaaaaaaaaaaaaa");
    team.setName("aaaaaaaaaaaaaaaa", "  Home  ");
    team.pcUp("bbbbbbbbbbbbbbbb");
    expect(team.stats(0).pcs.map((pc) => pc.name)).toEqual(["bbbbbbbbbbbbbbbb", "Home"]);
    await team.close();
  });

  it("closes sessions a crash left open at their last ping on the next boot", async () => {
    const dir = await tempDir();
    const c = clock();
    const team = await TeamLog.open(dir, c.now);
    team.pcUp("aaaaaaaaaaaaaaaa");
    team.setName("aaaaaaaaaaaaaaaa", "Home");
    c.advance(MIN);
    team.phoneStart("aaaaaaaaaaaaaaaa");
    c.advance(4 * MIN);
    team.pcSeen("aaaaaaaaaaaaaaaa");
    c.advance(MIN);
    await team.checkpoint();
    // No close(): the process dies here.
    c.advance(HOUR);
    const reboot = await TeamLog.open(dir, c.now);
    const [pc] = reboot.stats(0).pcs;
    expect(pc).toMatchObject({ name: "Home", online: false, lastSeen: T0 + 5 * MIN, firstSeen: T0 });
    expect(pc?.hours.at(-1)).toBe(0.08);
    expect(pc?.phone.at(-1)).toEqual({ count: 1, minutes: 5 });
    expect((await readFile(join(dir, "team-sessions"), "utf8")).split("\n")).toEqual(
      expect.arrayContaining([`pc aaaaaaaaaaaaaaaa ${T0} ${T0 + 5 * MIN}`, `phone aaaaaaaaaaaaaaaa ${T0 + MIN} ${T0 + 6 * MIN}`]),
    );
    await reboot.close();
  });

  it("drops sessions older than 90 days on boot and hourly", async () => {
    const dir = await tempDir();
    const c = clock();
    const team = await TeamLog.open(dir, c.now);
    team.pcUp("aaaaaaaaaaaaaaaa");
    c.advance(HOUR);
    team.pcDown("aaaaaaaaaaaaaaaa");
    c.advance(TEAM_KEEP_MS - HOUR);
    team.pcUp("bbbbbbbbbbbbbbbb");
    c.advance(MIN);
    team.pcDown("bbbbbbbbbbbbbbbb");
    await team.close();
    expect((await readFile(join(dir, "team-sessions"), "utf8")).match(/^pc /gm)).toHaveLength(2);

    c.advance(2 * HOUR);
    const reboot = await TeamLog.open(dir, c.now);
    expect(reboot.stats(0).pcs.map((pc) => pc.label)).toEqual(["bbbbbbbbbbbbbbbb"]);
    expect(await readFile(join(dir, "team-sessions"), "utf8")).not.toContain("aaaaaaaaaaaaaaaa");

    c.advance(TEAM_KEEP_MS);
    await reboot.checkpoint();
    await reboot.close();
    expect(reboot.stats(0).pcs).toEqual([]);
    expect(await readFile(join(dir, "team-sessions"), "utf8")).toBe("");
  });

  it("buckets hours and phone sessions by the viewer's local day", async () => {
    const c = clock(Date.parse("2026-10-11T16:00:00Z"));
    const team = await TeamLog.open(await tempDir(), c.now);
    const label = "aaaaaaaaaaaaaaaa";
    team.pcUp(label);
    c.advance(2 * HOUR);
    // Joins a minute apart are one phone session; one 10 minutes later is another.
    const first = team.phoneStart(label);
    const second = team.phoneStart(label);
    c.advance(2 * MIN);
    team.phoneEnd(first);
    team.phoneEnd(second);
    c.advance(MIN);
    team.phoneEnd(team.phoneStart(label));
    c.advance(10 * MIN);
    const third = team.phoneStart(label);
    c.advance(3 * MIN);
    team.phoneEnd(third);
    c.advance(HOUR);
    team.pcDown(label);

    // Seoul (UTC+9): all of it is on 10-12. UTC: it is on 10-11.
    const seoul = team.stats(540);
    expect(seoul.days.at(-1)).toBe("2026-10-12");
    expect(seoul.days).toHaveLength(14);
    expect(seoul.pcs[0]?.hours.at(-1)).toBe(3.27);
    expect(seoul.pcs[0]?.phone.at(-1)).toEqual({ count: 2, minutes: 6 });
    const utc = team.stats(0);
    expect(utc.days.at(-1)).toBe("2026-10-11");
    expect(utc.pcs[0]?.hours.at(-1)).toBe(3.27);
    expect(utc.pcs[0]?.hours.at(-2)).toBe(0);
    await team.close();
  });

  it("groups pcs by account, unions hours, and sums phone time", async () => {
    const c = clock();
    const team = await TeamLog.open(await tempDir(), c.now);
    const ada = "aaaaaaaaaaaaaaaa";
    const desk = "bbbbbbbbbbbbbbbb";
    const solo = "cccccccccccccccc";
    const hash = googleSubHash("ada-sub");
    team.setName(ada, "Field");
    team.setName(desk, "Studio");
    team.setName(solo, "Spare");
    team.setAccount(ada, hash, "Ada");
    team.setAccount(desk, hash, "Ada");
    team.pcUp(ada);
    team.pcUp(desk);
    team.pcUp(solo);
    c.advance(HOUR);
    team.pcDown(ada);
    team.pcDown(desk);
    const phone = team.phoneStart(ada);
    c.advance(5 * MIN);
    team.phoneEnd(phone);
    const other = team.phoneStart(desk);
    c.advance(5 * MIN);
    team.phoneEnd(other);
    team.pcDown(solo);

    const stats = team.stats(0);
    expect(stats.pcs.map((pc) => pc.hours.at(-1))).toEqual([1, 1.17, 1]);
    const adaPerson = stats.people.find((person) => person.pcs.length === 2);
    const spare = stats.people.find((person) => person.pcs.length === 1);
    expect(adaPerson).toMatchObject({
      name: "Ada",
      online: false,
      pcs: [
        { label: ada, name: "Field", online: false },
        { label: desk, name: "Studio", online: false },
      ],
    });
    expect(adaPerson?.hours.at(-1)).toBe(1);
    expect(adaPerson?.phone.at(-1)).toEqual({ count: 2, minutes: 10 });
    expect(adaPerson?.id).not.toBe(hash);
    expect(JSON.stringify(stats)).not.toContain(hash);
    expect(spare).toMatchObject({ name: "Spare", pcs: [{ label: solo, name: "Spare", online: false }] });
    expect(spare?.id).not.toBe(adaPerson?.id);
    await team.close();
  });

  it("round-trips old journals and appends account lines only on change", async () => {
    const dir = await tempDir();
    const c = clock();
    const ada = "aaaaaaaaaaaaaaaa";
    const hash = googleSubHash("ada-sub");
    const name = Buffer.from("Home", "utf8").toString("base64url");
    await writeFile(join(dir, "team-sessions"), `name ${ada} ${name}\npc ${ada} ${T0} ${T0 + HOUR}\n`);
    const loaded = await TeamLog.open(dir, c.now);
    const first = loaded.stats(0);
    expect(first.pcs).toMatchObject([{ label: ada, name: "Home", online: false }]);
    expect(first.people).toMatchObject([{ name: "Home", pcs: [{ label: ada, name: "Home", online: false }] }]);
    loaded.setAccount(ada, hash, "Ada");
    loaded.setAccount(ada, hash, "Ada");
    loaded.setAccount(ada, hash, "");
    await loaded.close();

    const lines = (await readFile(join(dir, "team-sessions"), "utf8")).trim().split("\n");
    expect(lines.filter((line) => line.startsWith("acct "))).toEqual([`acct ${ada} ${hash}`]);
    expect(lines.filter((line) => line.startsWith("who "))).toHaveLength(2);
    const again = await TeamLog.open(dir, c.now);
    expect(again.stats(0).people[0]).toMatchObject({ name: "Home" });
    expect(JSON.stringify(again.stats(0))).not.toContain(hash);
    again.setAccount(ada, hash, "Bea");
    await again.close();
    const next = await TeamLog.open(dir, c.now);
    expect(next.stats(0).people[0]?.name).toBe("Bea");
    await next.close();
  });

  it("keeps a cleared wink name cleared when the journal is reloaded without compaction", async () => {
    const dir = await tempDir();
    const c = clock();
    const ada = "aaaaaaaaaaaaaaaa";
    const hash = googleSubHash("ada-sub");
    const team = await TeamLog.open(dir, c.now);
    team.setName(ada, "Field");
    team.pcUp(ada);
    c.advance(MIN);
    team.pcDown(ada);
    team.setAccount(ada, hash, "Ada");
    team.setAccount(ada, hash, "");
    await team.close();
    const journal = await readFile(join(dir, "team-sessions"), "utf8");
    expect(journal).toContain(`who ${ada} ${Buffer.from("Ada", "utf8").toString("base64url")}`);
    const loaded = await TeamLog.open(dir, c.now);
    const person = loaded.stats(0).people.find((entry) => entry.pcs.some((pc) => pc.label === ada));
    expect(person?.name).toBe("Field");
    await loaded.close();
  });

  it("keeps a pc enrolled from a test setup code off /v1/team and leaves a normal enroll as it was", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), teamOwnerEmail: OWNER });
    const harness = h;
    const code = parseSetupCode(buildSetupCode(harness.base, mintInvite(harness.operator, { test: true })));
    if (!code.ok) throw new Error(code.reason);
    const tester = makePc();
    const mate = makePc();
    const enroll = async (pc: Pc, invite: string) => {
      const body = JSON.stringify({ invite, pk: pc.pk, sig: signEnrollment(pc.privateKey, invite, pc.pk) });
      const reply = await get(harness, "/v1/enroll", { "content-type": "application/json" }, "POST", body);
      expect(reply.status).toBe(200);
      // SAFETY: a 200 from /v1/enroll is {ticket}.
      return openControl(harness, pc, { ticket: (JSON.parse(reply.body) as { ticket: string }).ticket });
    };
    const controls = [await enroll(tester, code.value.invite), await enroll(mate, mintInvite(harness.operator))];

    const stats = statsOf(await get(harness, "/v1/team", bearer(issuer.sign(claims()))));
    expect(stats.pcs).toMatchObject([{ label: mate.label, online: true }]);
    expect(stats.people.map((person) => person.pcs.map((pc) => pc.label))).toEqual([[mate.label]]);
    await vi.waitFor(async () => {
      const lines = (await readFile(join(harness.dataDir, "team-sessions"), "utf8")).split("\n");
      const marks = lines.filter((line) => line.startsWith("test ")).map((line) => line.split(" "));
      expect(marks.map((mark) => mark.slice(0, 2).join(" "))).toEqual([`test ${tester.label}`]);
      expect(Number(marks[0]?.[2])).toBeGreaterThan(0);
    });
    for (const ctl of controls) ctl.socket.destroy();
  });

  it("hides test pcs through reopen, compaction and the hourly prune, then lets the mark go", async () => {
    const dir = await tempDir();
    const c = clock();
    const tester = "aaaaaaaaaaaaaaaa";
    const mate = "bbbbbbbbbbbbbbbb";
    const journal = () => readFile(join(dir, "team-sessions"), "utf8");
    const hidden = (stats: TeamStats) => {
      expect(stats.pcs.map((pc) => pc.label)).toEqual([mate]);
      expect(stats.people.map((person) => person.pcs.map((pc) => pc.label))).toEqual([[mate]]);
    };
    const team = await TeamLog.open(dir, c.now);
    team.markTest(tester);
    // The hourly prune runs before the test pc first connects.
    c.advance(2 * HOUR);
    await team.checkpoint();
    team.setName(tester, "Release check");
    team.pcUp(tester);
    team.pcUp(mate);
    c.advance(HOUR);
    team.pcDown(tester);
    team.pcDown(mate);
    hidden(team.stats(0));
    await team.close();
    expect(await journal()).toContain(`test ${tester} ${T0}\n`);

    const reopened = await TeamLog.open(dir, c.now);
    hidden(reopened.stats(0));
    expect(await journal()).toContain(`test ${tester} ${T0}\n`);
    // 90 days after the mark, its spans still hold it.
    c.advance(TEAM_KEEP_MS - HOUR);
    await reopened.checkpoint();
    hidden(reopened.stats(0));
    await reopened.close();
    expect(await journal()).toContain(`test ${tester} ${T0}\n`);

    c.advance(TEAM_KEEP_MS);
    const later = await TeamLog.open(dir, c.now);
    expect(await journal()).not.toContain("test ");
    later.pcUp(tester);
    expect(later.stats(0).pcs.map((pc) => pc.label)).toEqual([tester]);
    await later.close();
  });

  it("honors a test line appended to the journal by hand", async () => {
    const dir = await tempDir();
    const tester = "aaaaaaaaaaaaaaaa";
    const mate = "bbbbbbbbbbbbbbbb";
    await writeFile(join(dir, "team-sessions"), `pc ${tester} ${T0} ${T0 + HOUR}\npc ${mate} ${T0} ${T0 + HOUR}\n`);
    await appendFile(join(dir, "team-sessions"), `test ${tester} ${T0 + 2 * HOUR}\n`);
    const team = await TeamLog.open(dir, clock(T0 + 2 * HOUR).now);
    expect(team.stats(0).pcs.map((pc) => pc.label)).toEqual([mate]);
    expect(team.stats(0).people.map((person) => person.pcs.map((pc) => pc.label))).toEqual([[mate]]);
    await team.close();
    expect(await readFile(join(dir, "team-sessions"), "utf8")).toContain(`test ${tester} ${T0 + 2 * HOUR}\n`);
  });

  it("keeps a wink name on this relay and still parses on the 1.0.172 schema", () => {
    const msg = { type: "auth" as const, label: "l", pk: "p", ticket: "t", sig: "s", name: "Desk", person: "Ada" };
    expect(authMessageSchema.parse(msg)).toMatchObject({ person: "Ada", name: "Desk" });
    expect(authMessageSchema.safeParse({ ...msg, person: "x".repeat(64) }).success).toBe(true);
    expect(authMessageSchema.safeParse({ ...msg, person: "x".repeat(65) }).success).toBe(false);
    const relay172 = authMessageSchema.omit({ person: true });
    expect(relay172.parse(msg)).not.toHaveProperty("person");
    expect(relay172.parse(msg)).toMatchObject({ name: "Desk" });
  });
});

describe("GET /v1/team", () => {
  it("404s without an owner or without the google block", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer) });
    expect((await get(h, "/v1/team", bearer(issuer.sign(claims())))).status).toBe(404);
    await h.close();
    h = await startRelay({ teamOwnerEmail: OWNER });
    expect((await get(h, "/v1/team", bearer(issuer.sign(claims())))).status).toBe(404);
  });

  it("answers only the owner's verified web token", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), teamOwnerEmail: "Owner@Example.com", limits: { pcsPerIpPerMin: 100 } });
    expect(await get(h, "/v1/team")).toMatchObject({ status: 401 });
    expect(await get(h, "/v1/team", { authorization: "Bearer nope" })).toMatchObject({ status: 401 });
    const denied = [
      claims({ email: "someone@example.com" }),
      claims({ email_verified: false }),
      claims({ aud: DESKTOP, email: "someone@example.com" }),
      claims({ aud: DESKTOP, email_verified: false }),
      claims({ aud: "other-client.apps.googleusercontent.com" }),
    ];
    for (const c of denied) expect((await get(h, "/v1/team", bearer(issuer.sign(c)))).status).toBe(403);
    expect((await get(h, "/v1/team", bearer(issuer.sign(claims({ aud: DESKTOP }))))).status).toBe(200);
    expect(JSON.parse((await get(h, "/v1/team", bearer(issuer.sign(claims({ email: "someone@example.com" }))))).body)).toEqual({
      error: "not-owner",
    });

    const ok = await get(h, "/v1/team?tz=540", bearer(issuer.sign(claims({ email: "OWNER@example.com" }))));
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ days: expect.any(Array), pcs: [] });
    expect((await get(h, "/v1/team?tz=9999", bearer(issuer.sign(claims())))).status).toBe(400);
    expect((await get(h, "/v1/team/x", bearer(issuer.sign(claims())))).status).toBe(404);
    expect(h.logs.join("\n")).not.toMatch(/example\.com/i);
  });

  it("allows CORS only for the sign-in origin", async () => {
    const issuer = makeIssuer();
    h = await startRelay({ google: google(issuer), teamOwnerEmail: OWNER, limits: { pcsPerIpPerMin: 100 } });
    const token = issuer.sign(claims());
    const ok = await get(h, "/v1/team", { ...bearer(token), origin: ORIGIN });
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const evil = await get(h, "/v1/team", { ...bearer(token), origin: "https://evil.test" });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await get(h, "/v1/team", { origin: ORIGIN, "access-control-request-method": "GET" }, "OPTIONS");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(String(preflight.headers["access-control-allow-headers"])).toMatch(/authorization/i);
    const blocked = await get(h, "/v1/team", { origin: "https://evil.test" }, "OPTIONS");
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("loads teamOwnerEmail from config", async () => {
    const dir = await tempDir();
    const file = join(dir, "config.json");
    const base = { base: "relay-test.example", acme: { directoryUrl: "https://acme.test/dir", termsOfServiceAgreed: true } };
    await writeFile(file, JSON.stringify({ ...base, teamOwnerEmail: OWNER }));
    expect((await loadConfig(file)).teamOwnerEmail).toBe(OWNER);
    await writeFile(file, JSON.stringify({ ...base, teamOwnerEmail: "not an email" }));
    await expect(loadConfig(file)).rejects.toThrow(/teamOwnerEmail/);
  });
});
