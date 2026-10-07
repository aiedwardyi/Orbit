import { once } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Duplex, duplexPair } from "node:stream";
import { connect, type TLSSocket } from "node:tls";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { RelayIngress, relayPeerForRequest, type IngressRejection } from "./ingress.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { TestCa, leafFingerprint, type KeyAndCert } from "./testing/pki.ts";
import { isRelayRequest } from "./via.ts";

const HOST = "abcdefghijklmnop.wink.test";

let ca: TestCa;
let certA: KeyAndCert;
let certB: KeyAndCert;
let challenge: KeyAndCert;

beforeAll(async () => {
  ca = await TestCa.create();
  certA = await ca.issue(HOST);
  certB = await ca.issue(HOST);
  challenge = await ca.issue(HOST);
});

interface Seen {
  marked: boolean;
  peer: string | null;
  forwardedFor: string | undefined;
}

function makeIngress(clock = new FakeClock()) {
  const seen: Seen[] = [];
  const rejected: IngressRejection[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    seen.push({
      marked: isRelayRequest(req),
      peer: relayPeerForRequest(req),
      forwardedFor: req.headers["x-forwarded-for"] === undefined ? undefined : String(req.headers["x-forwarded-for"]),
    });
    res.end(`ok ${req.url}`);
  };
  const ingress = new RelayIngress({ host: HOST, handler, clock, onReject: (reason) => rejected.push(reason) });
  return { ingress, seen, rejected, clock };
}

/** A phone TLS client over an in-memory pipe; returns the PC end. */
function phonePipe(options: { servername?: string; alpn?: readonly string[]; trust?: boolean } = {}) {
  const [pcEnd, phoneEnd] = duplexPair();
  const tls = connect({
    socket: phoneEnd,
    servername: options.servername ?? HOST,
    ALPNProtocols: [...(options.alpn ?? ["h2", "http/1.1"])],
    ca: ca.certPem,
    rejectUnauthorized: options.trust ?? true,
  });
  tls.on("error", () => {});
  return { pcEnd, tls };
}

/** Reads the ClientHello off the PC end so a test can feed it back in pieces. */
async function takeHello(pcEnd: Duplex): Promise<Buffer> {
  const [chunk] = await once(pcEnd, "data");
  pcEnd.pause();
  return Buffer.from(chunk);
}

/** One keep-alive HTTP/1.1 exchange written by hand, so a connection can carry several. */
function get(tls: TLSSocket, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.subarray(0, end).toString("latin1");
      const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? "0");
      if (buf.length < end + 4 + length) return;
      tls.off("data", onData);
      resolve(buf.subarray(end + 4, end + 4 + length).toString("utf8"));
    };
    tls.on("data", onData);
    tls.once("close", () => reject(new Error("closed")));
    const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
    tls.write(`GET ${path} HTTP/1.1\r\nhost: ${HOST}\r\n${extra}\r\n`);
  });
}

function closed(stream: Duplex): Promise<void> {
  return stream.destroyed ? Promise.resolve() : once(stream, "close").then(() => {});
}

describe("relay ingress", () => {
  const open: RelayIngress[] = [];
  afterEach(() => {
    for (const ingress of open.splice(0)) ingress.close();
  });

  function setup(clock?: FakeClock) {
    const made = makeIngress(clock);
    made.ingress.setCertificate(certA.keyPem, certA.certPem);
    open.push(made.ingress);
    return made;
  }

  it.each([
    ["whole hello already read with go", (hello: Buffer) => [hello, Buffer.alloc(0)]],
    ["hello split between go read and socket", (hello: Buffer) => [hello.subarray(0, 7), hello.subarray(7)]],
    ["nothing read past go", (hello: Buffer) => [Buffer.alloc(0), hello]],
  ])("serves HTTP when the %s", async (_name, split) => {
    const { ingress, seen } = setup();
    const { pcEnd, tls } = phonePipe();
    const hello = await takeHello(pcEnd);
    const [head, rest] = split(hello);
    if (rest.length > 0) pcEnd.unshift(rest);
    ingress.accept(pcEnd, head, "203.0.113.9");
    await once(tls, "secureConnect");
    expect(tls.alpnProtocol).toBe("http/1.1");
    expect(tls.getPeerX509Certificate()?.fingerprint256).toBe(leafFingerprint(certA.certPem));
    expect(await get(tls, "/a", { "x-forwarded-for": "198.51.100.1" })).toBe("ok /a");
    expect(await get(tls, "/b")).toBe("ok /b");
    expect(seen).toEqual([
      { marked: true, peer: "203.0.113.9", forwardedFor: "198.51.100.1" },
      { marked: true, peer: "203.0.113.9", forwardedFor: undefined },
    ]);
    tls.destroy();
  });

  it("ignores a peer that is not an IP address", async () => {
    const { ingress, seen } = setup();
    const { pcEnd, tls } = phonePipe();
    ingress.accept(pcEnd, Buffer.alloc(0), "evil\r\nx-forwarded-for: 1.2.3.4");
    await once(tls, "secureConnect");
    await get(tls, "/");
    expect(seen[0]).toMatchObject({ marked: true, peer: null });
    tls.destroy();
  });

  it.each([
    ["wrong SNI", { servername: "zzzzzzzzzzzzzzzz.wink.test" }, "wrong-sni"],
    ["missing SNI", { servername: "" }, "wrong-sni"],
    ["only h2", { alpn: ["h2"] }, "unsupported-alpn"],
    ["acme mixed with http", { alpn: ["acme-tls/1", "http/1.1"] }, "unsupported-alpn"],
    ["acme without a challenge", { alpn: ["acme-tls/1"], trust: false }, "no-challenge"],
  ] as const)("refuses %s before TLS", async (_name, options, reason) => {
    const { ingress, rejected } = setup();
    const { pcEnd, tls } = phonePipe(options);
    ingress.accept(pcEnd, Buffer.alloc(0), "203.0.113.9");
    await closed(pcEnd);
    expect(rejected).toEqual([reason]);
    expect(ingress.openStreams).toBe(0);
    tls.destroy();
  });

  it("refuses a malformed ClientHello", async () => {
    const { ingress, rejected } = setup();
    const [pcEnd, other] = duplexPair();
    ingress.accept(pcEnd, Buffer.from("GET / HTTP/1.1\r\n\r\n"), "203.0.113.9");
    await closed(pcEnd);
    expect(rejected).toEqual(["invalid-hello"]);
    other.destroy();
  });

  it("refuses phone traffic until a certificate exists", async () => {
    const made = makeIngress();
    open.push(made.ingress);
    const { pcEnd, tls } = phonePipe();
    made.ingress.accept(pcEnd, Buffer.alloc(0), "203.0.113.9");
    await closed(pcEnd);
    expect(made.rejected).toEqual(["no-certificate"]);
    tls.destroy();
  });

  it("times out a ClientHello that never completes", async () => {
    const clock = new FakeClock();
    const { ingress, rejected } = setup(clock);
    const [pcEnd, other] = duplexPair();
    ingress.accept(pcEnd, Buffer.from([22, 3, 1, 0, 200]), "203.0.113.9");
    clock.advance(9_999);
    expect(pcEnd.destroyed).toBe(false);
    clock.advance(1);
    await closed(pcEnd);
    expect(rejected).toEqual(["timeout"]);
    other.destroy();
  });

  it("cuts a phone that never finishes its request headers", async () => {
    const clock = new FakeClock();
    const servers = new Set<Server>();
    const ingress = new RelayIngress({
      host: HOST,
      clock,
      handler: function (this: Server, req: IncomingMessage, res: ServerResponse) {
        servers.add(this);
        res.end(`ok ${req.url}`);
      },
    });
    ingress.setCertificate(certA.keyPem, certA.certPem);
    open.push(ingress);
    const { pcEnd, tls } = phonePipe();
    ingress.accept(pcEnd, Buffer.alloc(0), "203.0.113.9");
    await once(tls, "secureConnect");
    expect(await get(tls, "/warm")).toBe("ok /warm");
    expect(servers.size).toBe(1);
    // Node arms these only on a listening server; the ingress server never listens.
    for (const server of servers) {
      server.headersTimeout = 200;
      server.requestTimeout = 300;
    }
    tls.write(`GET /slow HTTP/1.1\r\nhost: ${HOST}\r\n`);
    clock.advance(60_000);
    const cut = await Promise.race([closed(pcEnd).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))]);
    expect(cut).toBe(true);
    tls.destroy();
  });

  it("gives the challenge certificate only to acme-tls/1", async () => {
    const { ingress } = setup();
    ingress.setChallenge(challenge.keyPem, challenge.certPem);
    const acme = phonePipe({ alpn: ["acme-tls/1"], trust: false });
    ingress.accept(acme.pcEnd, Buffer.alloc(0), "203.0.113.9");
    await once(acme.tls, "secureConnect");
    expect(acme.tls.alpnProtocol).toBe("acme-tls/1");
    expect(acme.tls.getPeerX509Certificate()?.fingerprint256).toBe(leafFingerprint(challenge.certPem));
    acme.tls.destroy();

    const phone = phonePipe();
    ingress.accept(phone.pcEnd, Buffer.alloc(0), "203.0.113.9");
    await once(phone.tls, "secureConnect");
    expect(phone.tls.getPeerX509Certificate()?.fingerprint256).toBe(leafFingerprint(certA.certPem));
    phone.tls.destroy();

    ingress.clearChallenge();
    const late = phonePipe({ alpn: ["acme-tls/1"], trust: false });
    ingress.accept(late.pcEnd, Buffer.alloc(0), "203.0.113.9");
    await closed(late.pcEnd);
    late.tls.destroy();
  });

  it("swaps certificates for new connections and keeps open ones working", async () => {
    const { ingress } = setup();
    const before = phonePipe();
    ingress.accept(before.pcEnd, Buffer.alloc(0), "203.0.113.9");
    await once(before.tls, "secureConnect");
    expect(await get(before.tls, "/1")).toBe("ok /1");

    ingress.setCertificate(certB.keyPem, certB.certPem);
    const after = phonePipe();
    ingress.accept(after.pcEnd, Buffer.alloc(0), "203.0.113.9");
    await once(after.tls, "secureConnect");
    expect(after.tls.getPeerX509Certificate()?.fingerprint256).toBe(leafFingerprint(certB.certPem));
    expect(before.tls.getPeerX509Certificate()?.fingerprint256).toBe(leafFingerprint(certA.certPem));
    expect(await get(before.tls, "/2")).toBe("ok /2");
    before.tls.destroy();
    after.tls.destroy();
  });

  it("close() ends only its own streams", async () => {
    const one = setup();
    const two = setup();
    const a = phonePipe();
    const b = phonePipe();
    one.ingress.accept(a.pcEnd, Buffer.alloc(0), "203.0.113.9");
    two.ingress.accept(b.pcEnd, Buffer.alloc(0), "203.0.113.9");
    await Promise.all([once(a.tls, "secureConnect"), once(b.tls, "secureConnect")]);
    one.ingress.close();
    await closed(a.pcEnd);
    expect(one.ingress.openStreams).toBe(0);
    expect(await get(b.tls, "/still")).toBe("ok /still");
    const late = phonePipe();
    one.ingress.accept(late.pcEnd, Buffer.alloc(0), "203.0.113.9");
    expect(late.pcEnd.destroyed).toBe(true);
    a.tls.destroy();
    b.tls.destroy();
    late.tls.destroy();
  });
});
