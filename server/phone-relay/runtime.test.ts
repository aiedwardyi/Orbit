import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostFor } from "../../shared/relay-protocol.ts";
import { CT_FIRST_CHECK_MS, type CtSource } from "./ct-watch.ts";
import type { PhoneRelay } from "./index.ts";
import { relayPeerForRequest, type IngressRejection } from "./ingress.ts";
import { createPhoneRelay } from "./runtime.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { readIdentity, readTicket } from "./store.ts";
import { BASE, StatusLog, enroll, phoneRequest, phoneStream, rig, type Rig } from "./testing/harness.ts";
import { leafFingerprint } from "./testing/pki.ts";
import { isRelayRequest } from "./via.ts";

interface Seen {
  url: string;
  marked: boolean;
  peer: string | null;
  remoteAddress: string | undefined;
  forwardedFor: string | undefined;
  body: string;
}

const MARKER = "PLAINTEXT-MARKER-7f3a";

function harness() {
  const seen: Seen[] = [];
  let releaseSse: () => void = () => {};
  const sseGate = new Promise<void>((resolve) => (releaseSse = resolve));
  const download = { written: 0, waiting: false };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      seen.push({
        url: req.url ?? "",
        marked: isRelayRequest(req),
        peer: relayPeerForRequest(req),
        remoteAddress: req.socket.remoteAddress,
        forwardedFor: req.headers["x-forwarded-for"] === undefined ? undefined : String(req.headers["x-forwarded-for"]),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write("data: one\n\n");
        await sseGate;
        res.end("data: two\n\n");
        return;
      }
      if (req.url === "/download") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(64 * 1024, 7);
        while (download.written < 512 * 1024 * 1024 && !res.destroyed) {
          download.written += chunk.length;
          if (!res.write(chunk)) {
            download.waiting = true;
            await once(res, "drain").catch(() => {});
            download.waiting = false;
          }
        }
        res.end();
        return;
      }
      res.end(req.url === "/chat" ? "pong" : `hello-from-pc ${MARKER}-reply`);
    });
  };
  return { seen, handler, releaseSse, download };
}

describe("phone relay end to end", () => {
  let r: Rig | null = null;
  let relayHandle: PhoneRelay | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await relayHandle?.stop();
    relayHandle = null;
    await r?.close();
    r = null;
  });

  it("issues a certificate through the relay and ends phone TLS inside the PC", async () => {
    r = await rig();
    const { seen, handler, releaseSse, download } = harness();
    const statuses = new StatusLog();
    const rejections: IngressRejection[] = [];
    const listen = vi.spyOn(Server.prototype, "listen");
    relayHandle = createPhoneRelay(
      { dataDir: r.dataDir, config: r.config, handler, onStatus: statuses.push },
      {
        clock: new FakeClock(),
        env: {},
        connector: r.relay.connector(),
        ctSource: null,
        acmeInsecureDirectories: true,
        onIngressReject: (reason) => rejections.push(reason),
      },
    );
    expect(relayHandle.status().host).toBe(r.host);
    const connected = await statuses.until((s) => s.state === "connected");
    expect(statuses.all.some((s) => s.state === "certifying")).toBe(true);
    expect(connected.host).toBe(r.host);
    expect(connected.certNotAfter).toBeGreaterThan(Date.now());
    expect(r.acme.log).toContain("challenge:tls-alpn-01");
    expect(r.acme.log).not.toContain("challenge:http-01");
    expect(r.acme.log).toContain("validated:valid");
    await r.relay.until(() => r!.relay.idleCount(r!.identity.label) === 3);

    // A phone request with spoofed forwarding headers and a marker in path, header and body.
    const res = await phoneRequest(r.relay, r.host, `/hello?${MARKER}`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.66", via: "wink-relay", "x-marker": MARKER },
      body: `body ${MARKER}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(`hello-from-pc ${MARKER}-reply`);
    expect(res.socket.alpnProtocol).toBe("http/1.1");
    const stored = JSON.parse(readFileSync(join(r.dataDir, "phone-relay", "cert.json"), "utf8"));
    expect(res.socket.getPeerX509Certificate()?.fingerprint256).toBe(leafFingerprint(stored.certPem));
    res.socket.destroy();

    const hello = seen.find((entry) => entry.url.startsWith("/hello"));
    expect(hello).toMatchObject({ marked: true, peer: "203.0.113.7", forwardedFor: "198.51.100.66", body: `body ${MARKER}` });
    expect(hello?.remoteAddress).toBeUndefined();

    // The relay carried only ciphertext: no marker from either direction.
    const relayBytes = Buffer.concat(r.relay.spliced).toString("latin1");
    expect(relayBytes.length).toBeGreaterThan(0);
    expect(relayBytes).not.toContain(MARKER);
    expect(relayBytes).not.toContain("hello-from-pc");

    // go frame and ClientHello split across separate reads.
    r.relay.goMode = "split";
    const split = await phoneRequest(r.relay, r.host, "/chat");
    expect(split.body).toBe("pong");
    split.socket.destroy();
    r.relay.goMode = "coalesced";

    // SSE frames arrive before the handler finishes the response.
    const sse = await phoneStream(r.relay, r.host, "/sse");
    const first = await once(sse.res, "data");
    expect(String(first[0])).toBe("data: one\n\n");
    releaseSse();
    const second = await once(sse.res, "data");
    expect(String(second[0])).toBe("data: two\n\n");
    sse.socket.destroy();

    // A stalled download does not hold up chat on another connection.
    const slow = await phoneStream(r.relay, r.host, "/download");
    slow.res.pause();
    const chat = await phoneRequest(r.relay, r.host, "/chat");
    expect(chat.body).toBe("pong");
    chat.socket.destroy();
    const again = await phoneRequest(r.relay, r.host, "/chat");
    expect(again.body).toBe("pong");
    again.socket.destroy();
    expect(download.waiting).toBe(true);
    expect(download.written).toBeLessThan(96 * 1024 * 1024);
    slow.socket.destroy();

    // Unsupported ALPN is refused before TLS.
    const h2only = r.relay.phone(r.host, ["h2"]);
    const [error] = await once(h2only, "error").catch((cause) => [cause]);
    expect(error).toBeTruthy();
    expect(rejections).toContain("unsupported-alpn");

    // The PC never opened a listening socket for any of this.
    expect(listen).not.toHaveBeenCalled();

    // stop() closes the relay connection and silences status.
    const count = statuses.all.length;
    await relayHandle.stop();
    await relayHandle.stop();
    await r.relay.until(() => !r!.relay.hasControl(r!.identity.label));
    expect(statuses.all.length).toBe(count);
  });

  it("restarts with the same identity and stored certificate", async () => {
    r = await rig();
    const { handler } = harness();
    const deps = { clock: new FakeClock(), env: {}, connector: r.relay.connector(), ctSource: null, acmeInsecureDirectories: true };
    const first = new StatusLog();
    relayHandle = createPhoneRelay({ dataDir: r.dataDir, config: r.config, handler, onStatus: first.push }, deps);
    await first.until((s) => s.state === "connected");
    await relayHandle.stop();
    const orders = r.acme.log.filter((entry) => entry === "new-order").length;

    const second = new StatusLog();
    relayHandle = createPhoneRelay({ dataDir: r.dataDir, config: r.config, handler, onStatus: second.push }, deps);
    const status = await second.until((s) => s.state === "connected");
    expect(status.host).toBe(r.host);
    expect(r.acme.log.filter((entry) => entry === "new-order").length).toBe(orders);
    const res = await phoneRequest(r.relay, r.host, "/chat");
    expect(res.body).toBe("pong");
    res.socket.destroy();
  });
});

describe("phone relay runtime status", () => {
  let r: Rig | null = null;
  let relayHandle: PhoneRelay | null = null;

  afterEach(async () => {
    await relayHandle?.stop();
    relayHandle = null;
    await r?.close();
    r = null;
  });

  function deps(rr: Rig, clock = new FakeClock(), ctSource: CtSource | null = null) {
    return { clock, env: {}, connector: rr.relay.connector(), ctSource, acmeInsecureDirectories: true };
  }

  it("survives stop during enroll and connects with the same identity on restart", async () => {
    r = await rig({ enroll: false });
    const rr = r;
    const statuses = new StatusLog();
    relayHandle = createPhoneRelay({ dataDir: rr.dataDir, config: rr.config, handler: () => {}, onStatus: statuses.push }, deps(rr));
    expect(relayHandle.status().state).toBe("enrolling");
    let open: () => void = () => {};
    rr.relay.enrollGate = new Promise((resolve) => (open = resolve));
    const enrolling = enroll(rr.dataDir, rr.relay, rr.config);
    await rr.relay.until(() => rr.relay.count("enroll") === 1);
    await relayHandle.stop();
    open();
    await enrolling;
    expect(statuses.all).toEqual([]);

    const identity = readIdentity(rr.dataDir);
    expect(identity.kind).toBe("ok");
    const host = identity.kind === "ok" ? hostFor(identity.value.label, BASE) : "";
    const again = new StatusLog();
    relayHandle = createPhoneRelay({ dataDir: rr.dataDir, config: rr.config, handler: () => {}, onStatus: again.push }, deps(rr));
    const connected = await again.until((s) => s.state === "connected");
    expect(connected.host).toBe(host);
  });

  it("goes to rejected when the relay revokes access, and persists refreshed tickets", async () => {
    r = await rig();
    const rr = r;
    const fresh = rr.relay.ticketFor(rr.identity.pk, 2 * 365 * 24 * 3600);
    rr.relay.refreshTicket = fresh;
    const statuses = new StatusLog();
    relayHandle = createPhoneRelay({ dataDir: rr.dataDir, config: rr.config, handler: () => {}, onStatus: statuses.push }, deps(rr));
    await statuses.until((s) => s.state === "connected");
    const stored = readTicket(rr.dataDir);
    expect(stored.kind === "ok" && stored.value).toBe(fresh);

    rr.relay.send(rr.identity.label, { type: "notice", code: "revoked" });
    const rejected = await statuses.until((s) => s.state === "rejected");
    expect(rejected.lastError).toMatch(/^revoked/);
    expect(rejected.poolIdle).toBe(0);
  });

  it("reports reconnecting with the retry time and comes back", async () => {
    r = await rig();
    const rr = r;
    const clock = new FakeClock();
    const statuses = new StatusLog();
    relayHandle = createPhoneRelay(
      { dataDir: rr.dataDir, config: rr.config, handler: () => {}, onStatus: statuses.push },
      { ...deps(rr, clock), random: () => 0.5 },
    );
    await statuses.until((s) => s.state === "connected");
    const before = statuses.all.length;
    rr.relay.dropControl(rr.identity.label);
    const down = await statuses.until((s) => s.state === "reconnecting" && s.nextRetryAt !== null);
    expect(statuses.all.length).toBeGreaterThan(before);
    expect(down.lastError).toBe("connection to relay closed");
    expect(down.certNotAfter).not.toBeNull();
    const coming = statuses.next((s) => s.state === "connected");
    clock.advance((down.nextRetryAt ?? 0) - clock.now());
    const back = await coming;
    expect(back.lastError).toBeNull();
  });

  it("surfaces a CT alert in lastError", async () => {
    r = await rig();
    const rr = r;
    const rogue = await rr.ca.issue(rr.host);
    const clock = new FakeClock();
    const ct: CtSource = { list: async () => [99], fetch: async () => rogue.certPem };
    const statuses = new StatusLog();
    relayHandle = createPhoneRelay({ dataDir: rr.dataDir, config: rr.config, handler: () => {}, onStatus: statuses.push }, deps(rr, clock, ct));
    await statuses.until((s) => s.state === "connected");
    clock.advance(CT_FIRST_CHECK_MS);
    const alerted = await statuses.until((s) => (s.lastError ?? "").startsWith("CT log shows"));
    expect(alerted.state).toBe("connected");
  });
});
