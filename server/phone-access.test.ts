import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse, createServer, request, type IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { PHONE_RELAY_OFF } from "../shared/relay-protocol.ts";
import * as atomic from "./atomic.ts";
import { serveLinkedFile } from "./linked-files.ts";
import { PhoneAccess } from "./phone-access.ts";
import { phoneSetCookie, requestCredentials } from "./phone-auth.ts";
import { PAIRING_TTL_MS, PhoneDevices } from "./phone-devices.ts";
import type { PhoneRelayConfig } from "./phone-relay/index.ts";
import { createPhoneRelay } from "./phone-relay/runtime.ts";
import type { JsonObject } from "./schema.ts";
import { FakeClock } from "./phone-relay/testing/fake-clock.ts";
import { StatusLog, rig, tempDataDir, type Rig } from "./phone-relay/testing/harness.ts";
import { listenLocal } from "./phone-relay/testing/net.ts";
import { isRelayRequest, markRelaySocket } from "./phone-relay/via.ts";
import { apiRequestAuthorized } from "./remote-access.ts";

const COMMS = "c".repeat(48);
const pairingSchema = z.object({ url: z.string(), code: z.string() });
const phonesSchema = z.object({ phones: z.array(z.object({ id: z.string(), name: z.string() })) });
const REMOTE_KEY = "a".repeat(64);
const CLIP = Buffer.from("linked-clip-bytes");

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface World {
  r: Rig;
  access: PhoneAccess;
  config: PhoneRelayConfig;
  statuses: StatusLog;
  clock: FakeClock;
  /** Handlers the gate must keep relay traffic away from. */
  reached: string[];
  origin: string;
  linkedRoot: string;
  local(path: string, init?: { method?: string; body?: JsonObject; bearer?: boolean; headers?: Record<string, string> }): Promise<Reply>;
  broadcast(frame: string): void;
}

const worlds: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of worlds.splice(0)) await close();
});

function send(res: ServerResponse, status: number, body: JsonObject): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The order of checks in server/index.ts, around fake routes. */
function app(access: PhoneAccess, reached: string[], linkedRoot: string, staticDir: string, sse: Set<ServerResponse>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const relay = isRelayRequest(req);
    let phone = null;
    if (relay) {
      const gate = await access.gate(req, res);
      if (gate.handled) return;
      phone = gate.phone;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const credentials = requestCredentials(relay, phone !== null, req.headers.authorization === `Bearer ${COMMS}`, REMOTE_KEY);
    if (method === "POST" && path === "/api/mailbox") {
      reached.push("mailbox");
      return send(res, 200, { ok: true });
    }
    if (
      path.startsWith("/api/") &&
      !(method === "GET" && path === "/api/health") &&
      !credentials.phoneSession &&
      !apiRequestAuthorized(credentials.bearerOk, req.headers.cookie, credentials.remoteKey, path)
    ) {
      return send(res, 401, { error: "unauthorized" });
    }
    if (method === "GET" && path === "/remote") {
      reached.push("remote");
      return send(res, 200, { ok: true });
    }
    if (path.startsWith("/api/internal/")) {
      reached.push("internal");
      return send(res, 200, { ok: true });
    }
    if (await access.handle(req, res, path, method, credentials.bearerOk)) return;
    if (method === "GET" && path === "/api/remote-link") {
      reached.push("remote-link");
      return send(res, 200, { url: `https://home.tail396477.ts.net/remote?key=${REMOTE_KEY}` });
    }
    if (method === "GET" && path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"kind":"hello"}\n\n');
      sse.add(res);
      req.on("close", () => sse.delete(res));
      return;
    }
    if (method === "GET" && path === "/api/threads/t1/linked-file") {
      return serveLinkedFile(req, res, {
        ...credentials,
        threadId: "t1",
        messages: [{ id: "m1", text: `[clip](${join(linkedRoot, "clip.mp4")})` }],
        deviceId: "this-pc",
        writerDeviceId: () => null,
        rootsFor: () => [linkedRoot],
      });
    }
    if (path === "/api/bots") return send(res, 200, { bots: [] });
    if (method === "GET" && path === "/api/health") return send(res, 200, { app: "openmausbot", pid: 1 });
    if (method === "GET" && !path.startsWith("/api/")) {
      const file = path === "/" ? "index.html" : path.slice(1);
      try {
        res.writeHead(200);
        return res.end(readFileSync(join(staticDir, file)));
      } catch {
        return res.end(readFileSync(join(staticDir, "index.html")));
      }
    }
    return send(res, 404, { error: `no route: ${method} ${path}` });
  };
}

function staticFiles(): string {
  const dir = mkdtempSync(join(tmpdir(), "wink-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "APP SHELL");
  writeFileSync(join(dir, "pair.html"), "PAIR PAGE");
  writeFileSync(join(dir, "manifest.json"), "{}");
  writeFileSync(join(dir, "assets", "app.js"), "APP JS");
  return dir;
}

async function world(options: { config?: Partial<PhoneRelayConfig>; enroll?: (invite: string) => Promise<void> } = {}): Promise<World> {
  const r = await rig();
  const staticDir = staticFiles();
  const linkedRoot = mkdtempSync(join(tmpdir(), "wink-linked-"));
  writeFileSync(join(linkedRoot, "clip.mp4"), CLIP);
  const config: PhoneRelayConfig = { ...r.config, ...options.config };
  const statuses = new StatusLog();
  const clock = new FakeClock();
  const reached: string[] = [];
  const sse = new Set<ServerResponse>();
  const access: PhoneAccess = new PhoneAccess({
    dataDir: r.dataDir,
    env: {},
    staticDir,
    config: () => config,
    saveEnabled: (enabled) => {
      config.enabled = enabled;
    },
    onChange: () => statuses.push(access.status()),
    clock,
    start: (relayOptions) =>
      createPhoneRelay(relayOptions, { clock: new FakeClock(), env: {}, connector: r.relay.connector(), ctSource: null, acmeInsecureDirectories: true }),
    enroll: options.enroll ? (enrollOptions) => options.enroll!(enrollOptions.invite) : undefined,
  });
  const handler = app(access, reached, linkedRoot, staticDir, sse);
  const server = createServer(handler);
  const port = await listenLocal(server);
  await access.start(handler);
  await statuses.until((s) => s.state === "connected");
  worlds.push(async () => {
    await access.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await r.close();
    rmSync(staticDir, { recursive: true, force: true });
    rmSync(linkedRoot, { recursive: true, force: true });
  });
  return {
    r,
    access,
    config,
    statuses,
    clock,
    reached,
    origin: `https://${r.host}`,
    linkedRoot,
    broadcast: (frame) => {
      for (const res of sse) res.write(`data: ${frame}\n\n`);
    },
    async local(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.bearer !== false) headers.set("authorization", `Bearer ${COMMS}`);
      if (init.body !== undefined) headers.set("content-type", "application/json");
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const received: IncomingHttpHeaders = {};
      res.headers.forEach((value, name) => {
        received[name] = value;
      });
      return { status: res.status, headers: received, body: await res.text() };
    },
  };
}

/** One request from a phone, TLS end to end with the PC through the relay. */
function viaRelay(r: Rig, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = r.relay.phone(r.host);
    socket.on("error", reject);
    const req = request(
      { method: init.method ?? "GET", host: r.host, path, headers: { host: r.host, ...init.headers }, createConnection: () => socket },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          socket.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

function streamViaRelay(r: Rig, path: string, headers: Record<string, string>): Promise<{ res: IncomingMessage; socket: TLSSocket }> {
  return new Promise((resolve, reject) => {
    const socket = r.relay.phone(r.host);
    socket.on("error", () => {});
    const req = request({ host: r.host, path, headers: { host: r.host, ...headers }, createConnection: () => socket }, (res) => {
      res.on("error", () => {});
      resolve({ res, socket });
    });
    req.on("error", reject);
    req.end();
  });
}

async function mint(w: World): Promise<{ url: string; code: string; token: string }> {
  const res = await w.local("/api/phone/pairing", { method: "POST" });
  expect(res.status).toBe(200);
  const body = pairingSchema.parse(JSON.parse(res.body));
  return { ...body, token: new URL(body.url).hash.slice("#k=".length) };
}

function redeem(w: World, credential: string, init: { name?: string; requestId?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return viaRelay(w.r, "/api/phone/pair", {
    method: "POST",
    headers: { origin: w.origin, "content-type": "application/json", ...init.headers },
    body: JSON.stringify({ credential, name: init.name ?? "Pixel", requestId: init.requestId ?? randomUUID() }),
  });
}

/** Pairs a phone and returns its Cookie header value. */
async function pairPhone(w: World, name = "Pixel"): Promise<string> {
  const { token } = await mint(w);
  const res = await redeem(w, token, { name });
  expect(res.status).toBe(200);
  return String(res.headers["set-cookie"]?.[0]).split(";")[0]!;
}

describe("phone pairing through the relay", () => {
  it("pairs with the QR token and sets a host-only phone cookie", async () => {
    const w = await world();
    const { url, code, token } = await mint(w);
    expect(url).toMatch(new RegExp(`^https://${w.r.host.replaceAll(".", "\\.")}/pair#k=wkp_[A-Za-z0-9_-]{43}$`));
    expect(code).toMatch(/^\d{6}$/);

    const page = await viaRelay(w.r, "/pair");
    expect(page).toMatchObject({ status: 200, body: "PAIR PAGE" });
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");

    const paired = await redeem(w, token, { name: "Pixel 9" });
    expect(paired.status).toBe(200);
    const [cookie] = paired.headers["set-cookie"] ?? [];
    expect(cookie).toMatch(/^__Host-wink_phone=wkd_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax$/);
    expect(paired.body).not.toContain("wkd_");
    const session = cookie!.split(";")[0]!;

    expect((await viaRelay(w.r, "/api/bots", { headers: { cookie: session } })).status).toBe(200);
    expect(await viaRelay(w.r, "/", { headers: { cookie: session } })).toMatchObject({ status: 200, body: "APP SHELL" });
    expect((await viaRelay(w.r, "/api/bots")).status).toBe(401);
    const { phones } = phonesSchema.parse(JSON.parse((await w.local("/api/phone/devices")).body));
    expect(phones.map((phone) => phone.name)).toEqual(["Pixel 9"]);
  });

  it("pairs an installed app with the 6 digit code", async () => {
    const w = await world();
    const { code } = await mint(w);
    const res = await redeem(w, code);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/^__Host-wink_phone=wkd_/);
  });

  it("refuses an expired QR at exactly two minutes", async () => {
    const w = await world();
    const { token } = await mint(w);
    w.clock.advance(PAIRING_TTL_MS);
    const res = await redeem(w, token);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "no-pairing" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("burns the code on the fifth wrong guess", async () => {
    const w = await world();
    const { code } = await mint(w);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect((await redeem(w, wrong)).status).toBe(401);
    expect(JSON.parse((await redeem(w, wrong)).body)).toEqual({ error: "too-many-attempts" });
    expect((await redeem(w, code)).status).toBe(409);
  });

  it("replays a lost answer for the same request and issues one phone to a race", async () => {
    const w = await world();
    const first = await mint(w);
    const requestId = randomUUID();
    const a = await redeem(w, first.token, { requestId });
    const b = await redeem(w, first.token, { requestId });
    expect(a.status).toBe(200);
    expect(b.headers["set-cookie"]).toEqual(a.headers["set-cookie"]);

    const second = await mint(w);
    // The fake relay splices one waiting phone per idle channel, so race only as many as are parked.
    await w.r.relay.until(() => w.r.relay.idleCount(w.r.identity.label) >= 3);
    const race = await Promise.all(Array.from({ length: 3 }, () => redeem(w, second.code)));
    expect(race.map((res) => res.status).sort()).toEqual([200, 409, 409]);
    expect(JSON.parse((await w.local("/api/phone/devices")).body).phones).toHaveLength(2);
  });

  it("limits pairing by the relay's peer address, never by forwarded headers", async () => {
    const w = await world();
    w.r.relay.peer = "198.51.100.1";
    for (let i = 0; i < 10; i++) {
      const res = await redeem(w, "000000", { headers: { "x-forwarded-for": `192.0.2.${i}`, forwarded: `for=192.0.2.${i}` } });
      expect(res.status).not.toBe(429);
    }
    expect((await redeem(w, "000000", { headers: { "x-forwarded-for": "192.0.2.99" } })).status).toBe(429);
    for (const peer of ["198.51.100.2", "198.51.100.3"]) {
      w.r.relay.peer = peer;
      for (let i = 0; i < 10; i++) expect((await redeem(w, "000000")).status).not.toBe(429);
    }
    // 30 attempts a minute for the whole PC, whoever asks.
    w.r.relay.peer = "198.51.100.4";
    expect((await redeem(w, "000000")).status).toBe(429);
  });
});

describe("relay request gate", () => {
  it("rejects a spoofed Host and a missing or foreign Origin", async () => {
    const w = await world();
    const session = await pairPhone(w);
    for (const host of ["localhost", "127.0.0.1:8799", "home.tail396477.ts.net"]) {
      expect((await viaRelay(w.r, "/api/bots", { headers: { host, cookie: session } })).status).toBe(403);
    }
    expect((await viaRelay(w.r, "/api/bots", { method: "POST", headers: { cookie: session } })).status).toBe(403);
    for (const origin of ["https://evil.example", "http://127.0.0.1:8799", "null"]) {
      expect((await viaRelay(w.r, "/api/bots", { method: "POST", headers: { cookie: session, origin } })).status).toBe(403);
    }
    expect((await viaRelay(w.r, "/api/bots", { method: "POST", headers: { cookie: session, origin: w.origin } })).status).toBe(200);
  });

  it("ignores the boot token, the tailnet cookie and companion or forwarding headers", async () => {
    const w = await world();
    const res = await viaRelay(w.r, "/api/bots", {
      headers: {
        authorization: `Bearer ${COMMS}`,
        cookie: `orbit_remote=${REMOTE_KEY}; wink_phone=x`,
        "x-openmausbot-companion": "1",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "localhost",
        forwarded: "for=127.0.0.1;host=localhost",
        via: "1.1 tailscale",
      },
    });
    expect(res.status).toBe(401);
  });

  it("never lets a header or a phone cookie make local traffic look like a phone", async () => {
    const w = await world();
    const session = await pairPhone(w);
    expect((await w.local("/api/bots", { bearer: false, headers: { cookie: session } })).status).toBe(401);
    const fakeRelay = { via: "wink-relay", "x-wink-relay": "1", "x-relay-peer": "203.0.113.7" };
    expect((await w.local("/api/phone/pair", { method: "POST", body: { credential: "x" }, headers: fakeRelay })).status).toBe(404);
    expect((await w.local("/api/phone-relay/status", { headers: fakeRelay })).status).toBe(200);
  });

  it("hides local-only and management routes from a paired phone", async () => {
    const w = await world();
    const session = await pairPhone(w);
    const routes: Array<[string, string]> = [
      ["POST", "/api/mailbox"],
      ["GET", "/api/internal/agents"],
      ["PUT", "/api/internal/terminal-bridge"],
      ["GET", `/remote?key=${REMOTE_KEY}`],
      ["GET", "/api/remote-link"],
      ["POST", "/api/phone/pairing"],
      ["DELETE", "/api/phone/pairing"],
      ["GET", "/api/phone/devices"],
      ["DELETE", "/api/phone/devices/x"],
      ["GET", "/api/phone-relay/status"],
      ["PUT", "/api/phone-relay"],
      ["POST", "/api/phone-relay/enroll"],
    ];
    for (const [method, path] of routes) {
      const res = await viaRelay(w.r, path, {
        method,
        headers: { cookie: session, origin: w.origin, authorization: `Bearer ${COMMS}`, "x-openmausbot-mailbox": "secret" },
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(w.reached).toEqual([]);
  });

  it("refuses request targets that would break or bend URL parsing", async () => {
    const w = await world();
    for (const path of ["//", "/\\[", "/\\evil/api/internal/agents"]) {
      expect((await viaRelay(w.r, path)).status, path).toBe(400);
    }
    expect(w.reached).toEqual([]);
    expect((await viaRelay(w.r, "/api/health")).status).toBe(200);
  });

  it("says only ok on health and sends an unpaired phone to the pair page", async () => {
    const w = await world();
    expect(await viaRelay(w.r, "/api/health")).toMatchObject({ status: 200, body: '{"ok":true}' });
    for (const path of ["/", "/index.html", "/bots/abc"]) {
      const res = await viaRelay(w.r, path);
      expect(res.status, path).toBe(302);
      expect(res.headers.location).toBe("/pair");
    }
    expect(await viaRelay(w.r, "/assets/app.js")).toMatchObject({ status: 200, body: "APP JS" });
    expect((await viaRelay(w.r, "/manifest.json")).status).toBe(200);
  });

  it("serves linked files to the phone session only", async () => {
    const w = await world();
    const session = await pairPhone(w);
    const path = `/api/threads/t1/linked-file?path=${encodeURIComponent(join(w.linkedRoot, "clip.mp4"))}`;
    const ok = await viaRelay(w.r, path, { headers: { cookie: session } });
    expect(ok).toMatchObject({ status: 200, body: CLIP.toString() });
    const old = await viaRelay(w.r, path, { headers: { cookie: `orbit_remote=${REMOTE_KEY}`, authorization: `Bearer ${COMMS}` } });
    expect(old.status).toBe(401);
    expect(old.body).not.toContain(CLIP.toString());
  });

  it("applies the same rules to an upgrade request", async () => {
    const w = await world();
    const session = await pairPhone(w);
    const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
    expect((await viaRelay(w.r, "/api/bots", { headers: upgrade })).status).toBe(401);
    expect((await viaRelay(w.r, "/api/bots", { headers: { ...upgrade, host: "localhost", cookie: session } })).status).toBe(403);
    expect((await viaRelay(w.r, "/api/bots", { headers: { ...upgrade, cookie: session } })).status).toBe(200);
  });
});

describe("phone management", () => {
  it("revokes one phone, ending its live stream and nothing else", async () => {
    const w = await world();
    const a = await pairPhone(w, "A");
    const b = await pairPhone(w, "B");
    const streamA = await streamViaRelay(w.r, "/api/events", { cookie: a });
    const streamB = await streamViaRelay(w.r, "/api/events", { cookie: b });
    await once(streamA.res, "data");
    await once(streamB.res, "data");
    const { phones } = phonesSchema.parse(JSON.parse((await w.local("/api/phone/devices")).body));
    const idA = phones.find((phone) => phone.name === "A")!.id;

    const closed = new Promise((resolve) => streamA.res.once("close", resolve));
    expect((await w.local(`/api/phone/devices/${idA}`, { method: "DELETE" })).status).toBe(200);
    await closed;
    const next = once(streamB.res, "data");
    w.broadcast("after-revoke");
    expect(String((await next)[0])).toContain("after-revoke");
    expect((await viaRelay(w.r, "/api/bots", { headers: { cookie: a } })).status).toBe(401);
    expect((await viaRelay(w.r, "/api/bots", { headers: { cookie: b } })).status).toBe(200);
    expect((await w.local("/api/bots")).status).toBe(200);
    expect((await w.local(`/api/phone/devices/${idA}`, { method: "DELETE" })).status).toBe(404);
    streamB.socket.destroy();
  });

  it("lets no request through after a revoke that raced it", async () => {
    const w = await world();
    const session = await pairPhone(w, "A");
    const [phone] = phonesSchema.parse(JSON.parse((await w.local("/api/phone/devices")).body)).phones;
    await w.r.relay.until(() => w.r.relay.idleCount(w.r.identity.label) >= 3);
    const racing = Array.from({ length: 2 }, () =>
      viaRelay(w.r, "/api/bots", { headers: { cookie: session } }).then(
        (res) => res.status,
        () => 0,
      ),
    );
    expect((await w.local(`/api/phone/devices/${phone!.id}`, { method: "DELETE" })).status).toBe(200);
    for (const status of await Promise.all(racing)) expect([0, 200, 401]).toContain(status);
    expect((await viaRelay(w.r, "/api/bots", { headers: { cookie: session } })).status).toBe(401);
  });

  it("keeps the tailnet cookie and the desktop token working, relay on or off", async () => {
    const w = await world();
    const tailnet = { cookie: `orbit_remote=${REMOTE_KEY}` };
    expect((await w.local("/api/bots", { bearer: false, headers: tailnet })).status).toBe(200);
    expect((await w.local("/api/bots")).status).toBe(200);
    await w.local("/api/phone-relay", { method: "PUT", body: { enabled: false } });
    expect((await w.local("/api/bots", { bearer: false, headers: tailnet })).status).toBe(200);
    expect((await w.local("/api/bots")).status).toBe(200);
    expect((await w.local("/api/bots", { bearer: false })).status).toBe(401);
  });

  it("keeps management on the PC's own token", async () => {
    const w = await world();
    const res = await w.local("/api/phone-relay/status", { bearer: false, headers: { cookie: `orbit_remote=${REMOTE_KEY}` } });
    expect(res.status).toBe(403);
    expect((await w.local("/api/phone/pairing", { method: "POST", bearer: false, headers: { cookie: `orbit_remote=${REMOTE_KEY}` } })).status).toBe(403);
  });

  it("turns the relay off and on again from Settings", async () => {
    const w = await world();
    const off = await w.local("/api/phone-relay", { method: "PUT", body: { enabled: false } });
    expect(JSON.parse(off.body)).toMatchObject({ configured: true, enabled: false, state: "off" });
    await w.r.relay.until(() => !w.r.relay.hasControl(w.r.identity.label));
    expect((await w.local("/api/phone/pairing", { method: "POST" })).status).toBe(409);
    const back = w.statuses.next((s) => s.state === "connected");
    const on = await w.local("/api/phone-relay", { method: "PUT", body: { enabled: true } });
    expect(JSON.parse(on.body)).toMatchObject({ configured: true, enabled: true });
    await back;
    expect((await viaRelay(w.r, "/api/health")).status).toBe(200);
  });

  it("keeps keys, tickets and invites out of the status and enroll answers", async () => {
    const invite = `wki1.${"I".repeat(60)}.${"S".repeat(40)}`;
    const w = await world({
      config: { acmeAccounts: { "https://ca.example/d": { eab: { kid: "KID-SECRET", hmacKey: "HMAC-SECRET" } } } },
      enroll: async (value) => {
        throw new Error(`relay refused ${value}`);
      },
    });
    const status = await w.local("/api/phone-relay/status");
    expect(JSON.parse(status.body)).toMatchObject({ configured: true, enabled: true, state: "connected", host: w.r.host, problem: null });
    const { ticket } = z.object({ ticket: z.string() }).parse(JSON.parse(readFileSync(join(w.r.dataDir, "phone-relay", "ticket.json"), "utf8")));
    for (const secret of ["KID-SECRET", "HMAC-SECRET", ticket, "PRIVATE KEY", "wkt1."]) expect(status.body).not.toContain(secret);
    const enrolled = await w.local("/api/phone-relay/enroll", { method: "POST", body: { invite } });
    expect(enrolled.status).toBe(400);
    expect(enrolled.body).not.toContain("I".repeat(60));
    expect(enrolled.body).not.toContain("wki1.");
  });
});

describe("phone removal that fails to save", () => {
  const HOST = "abcdefghijklmnop.wink.test";

  function exchange(path: string, method = "GET") {
    const socket = new Socket();
    worlds.push(async () => {
      socket.destroy();
    });
    const req = new IncomingMessage(socket);
    req.url = path;
    req.method = method;
    req.headers = { host: HOST };
    req.rawHeaders = ["host", HOST];
    return { req, res: new ServerResponse(req), socket };
  }

  it("cuts the phone, refuses its cookie and succeeds on retry", async () => {
    const { dir, cleanup } = tempDataDir();
    worlds.push(async () => cleanup());
    const clock = new FakeClock();
    const phones = new PhoneDevices(dir, clock);
    const paired = phones.redeem(phones.openPairing().token, "Lost phone", undefined);
    if (!paired.ok) throw new Error(paired.error);
    const access = new PhoneAccess({
      dataDir: dir,
      env: {},
      staticDir: null,
      config: () => ({ base: "wink.test", enabled: true }),
      saveEnabled: () => {},
      clock,
      start: () => ({ status: () => ({ ...PHONE_RELAY_OFF, state: "connected", host: HOST }), stop: async () => {} }),
    });
    worlds.push(() => access.stop());
    await access.start(() => {});
    const cookie = phoneSetCookie(paired.token).split(";")[0];
    const phone = exchange("/api/events");
    phone.req.headers.cookie = cookie;
    markRelaySocket(phone.socket);
    expect(await access.gate(phone.req, phone.res)).toMatchObject({ handled: false, phone: { id: paired.phone.id } });

    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => {
      throw Object.assign(new Error("phone registry is busy"), { code: "EBUSY" });
    });
    const path = `/api/phone/devices/${paired.phone.id}`;
    const first = exchange(path, "DELETE");
    await expect(access.handle(first.req, first.res, path, "DELETE", true)).rejects.toThrow("phone registry is busy");
    expect(phone.socket.destroyed).toBe(true);

    const again = exchange("/api/events");
    again.req.headers.cookie = cookie;
    markRelaySocket(again.socket);
    expect(await access.gate(again.req, again.res)).toEqual({ handled: true });
    expect(again.res.statusCode).toBe(401);

    const retry = exchange(path, "DELETE");
    expect(await access.handle(retry.req, retry.res, path, "DELETE", true)).toBe(true);
    expect(retry.res.statusCode).toBe(200);
    expect(new PhoneDevices(dir, clock).authenticate(paired.token)).toBeNull();
  });
});

describe("dev boot", () => {
  it("loads the relay integration and the lazily loaded client under Node's own type stripping", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = [
      "server/phone-access.ts",
      "server/phone-auth.ts",
      "server/phone-devices.ts",
      "server/phone-relay/via.ts",
      "server/phone-relay/index.ts",
      "server/phone-relay/ingress.ts",
      "server/device-sync.ts",
      "server/config.ts",
    ];
    for (const file of files) {
      const href = pathToFileURL(join(root, file)).href;
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(href)});`], { encoding: "utf8" });
      expect(run.status, `${file}: ${run.stderr}`).toBe(0);
    }
  });
});

describe("no relay configured", () => {
  function idle(config: PhoneRelayConfig | undefined, env: NodeJS.ProcessEnv = {}) {
    const { dir, cleanup } = tempDataDir();
    worlds.push(async () => cleanup());
    let started = 0;
    const access = new PhoneAccess({
      dataDir: dir,
      env,
      staticDir: null,
      config: () => config,
      saveEnabled: () => {},
      start: () => {
        started++;
        throw new Error("must not start");
      },
    });
    return { dir, access, started: () => started };
  }

  async function ask(access: PhoneAccess, method: string, path: string) {
    const server = createServer(async (req, res) => {
      if (!(await access.handle(req, res, path, method, true))) send(res, 404, { error: "no route" });
    });
    const port = await listenLocal(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  }

  it("starts nothing and writes nothing without a base, when disabled, or with ORBIT_RELAY=0", async () => {
    for (const [config, env, configured, enabled] of [
      [undefined, {}, false, false],
      [{ enabled: true }, {}, false, false],
      [{ base: "wink.test" }, {}, true, false],
      [{ base: "wink.test", enabled: true }, { ORBIT_RELAY: "0" }, false, false],
    ] as const) {
      const world = idle(config, env);
      await world.access.start(() => {});
      expect(world.started()).toBe(0);
      const status = await ask(world.access, "GET", "/api/phone-relay/status");
      expect(status.body).toMatchObject({ configured, enabled, state: "off", host: null });
      expect((await ask(world.access, "POST", "/api/phone/pairing")).status).toBe(409);
      expect(readdirSync(world.dir)).toEqual([]);
      await world.access.stop();
    }
  });

  it("imports the relay client only once the relay is on", () => {
    const { dir, cleanup } = tempDataDir();
    worlds.push(async () => cleanup());
    const clientLoads = (config: PhoneRelayConfig) => {
      const script = `
        import { registerHooks } from "node:module";
        const loaded = [];
        registerHooks({ load: (url, context, next) => (loaded.push(url), next(url, context)) });
        const { PhoneAccess } = await import(${JSON.stringify(new URL("./phone-access.ts", import.meta.url).href)});
        const access = new PhoneAccess({
          dataDir: ${JSON.stringify(dir)},
          env: {},
          staticDir: null,
          config: () => (${JSON.stringify(config)}),
          saveEnabled() {},
          start: () => ({ status: () => ({}), stop: async () => {} }),
        });
        await access.start(() => {});
        await access.stop();
        console.log(JSON.stringify(loaded.filter((url) => /\\/phone-relay\\/(index|ingress)\\.ts$/.test(url))));
      `;
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      return z.array(z.string()).parse(JSON.parse(run.stdout));
    };
    expect(clientLoads({ enabled: true })).toEqual([]);
    expect(clientLoads({ base: "wink.test", enabled: true })).toHaveLength(2);
  });
});
