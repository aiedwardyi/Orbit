import { afterEach, describe, expect, it } from "vitest";
import { encodeFrame } from "../../shared/relay-protocol.ts";
import {
  captureClientHello,
  closed,
  event,
  makePc,
  openControl,
  openData,
  rawConnect,
  readAll,
  startRelay,
  type Harness,
} from "./fixtures.ts";
import { awaitGo, phoneConnect, serveInner } from "./pc-side.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const ALERT = (description: number) => Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, description]);
const CCS = Buffer.from([0x14, 0x03, 0x03, 0x00, 0x01, 0x01]);

describe("SNI routing", () => {
  it.each([{ alpn: ["http/1.1"] }, { alpn: [] }])("forwards fragmented ClientHello bytes exactly with ALPN $alpn", async ({ alpn }) => {
    h = await startRelay();
    const pc = makePc();
    const ctl = await openControl(h, pc);
    const data = await openData(h, ctl.ready.session, ctl.ready.poolToken);
    await h.waitLog(event("join", { label: pc.label }));

    const hello = await captureClientHello(`${pc.label}.${h.base}`, alpn);
    const phone = await rawConnect(h);
    const pieces = [hello.subarray(0, 3), hello.subarray(3, 50), Buffer.concat([hello.subarray(50), CCS])];
    const got = awaitGo(data);
    for (const piece of pieces) {
      phone.write(piece);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const { go, rest, firstChunk } = await got;
    expect(go).toEqual({ type: "go", peer: "127.0.0.1" });
    // go and every buffered phone byte arrive together and byte-exact.
    const goFrame = encodeFrame({ type: "go", peer: "127.0.0.1" });
    expect(firstChunk.subarray(0, goFrame.length).equals(goFrame)).toBe(true);
    const expected = Buffer.concat([hello, CCS]);
    let tail = rest;
    data.on("data", (c: Buffer) => (tail = Buffer.concat([tail, c])));
    data.resume();
    while (tail.length < expected.length) await new Promise<void>((resolve) => data.once("data", () => resolve()));
    expect(tail.equals(expected)).toBe(true);
    // No second go: what follows is the phone's raw stream.
    phone.write("raw-after");
    await new Promise<void>((resolve) => data.once("data", () => resolve()));
    expect(tail.subarray(expected.length).toString()).toBe("raw-after");
    phone.destroy();
    ctl.socket.destroy();
  });

  it("carries a real phone TLS session end to end without terminating it", async () => {
    h = await startRelay();
    const pc = makePc();
    const pcCert = await h.ca.issue(`${pc.label}.${h.base}`);
    const ctl = await openControl(h, pc);
    const data = await openData(h, ctl.ready.session, ctl.ready.poolToken);
    await h.waitLog(event("join", { label: pc.label }));

    const inner = serveInner(data, pcCert);
    const phone = await phoneConnect(h, pc.label);
    const pcSide = await inner;
    // The phone saw the PC's certificate, not the relay's.
    expect(phone.getPeerCertificate().subject.CN).toBe(`${pc.label}.${h.base}`);
    expect(phone.alpnProtocol).toBe("http/1.1");

    pcSide.on("data", (chunk: Buffer) => pcSide.write(`echo:${chunk}`));
    phone.write("GET /api/health");
    const reply = await new Promise<string>((resolve) => phone.once("data", (c: Buffer) => resolve(c.toString())));
    expect(reply).toBe("echo:GET /api/health");
    phone.end();
    await closed(phone);
    await h.waitLog(event("splice-end", { label: pc.label }));
    ctl.socket.destroy();
  });

  it("holds a phone on an empty pool, sends want, and splices when a channel joins", async () => {
    h = await startRelay();
    const pc = makePc();
    const pcCert = await h.ca.issue(`${pc.label}.${h.base}`);
    const ctl = await openControl(h, pc);
    const phoneP = phoneConnect(h, pc.label);
    expect(await ctl.reader.next()).toEqual({ type: "want", n: 1 });
    const data = await openData(h, ctl.ready.session, ctl.ready.poolToken);
    const inner = serveInner(data, pcCert);
    const phone = await phoneP;
    await inner;
    await h.waitLog(event("join", { label: pc.label, reason: "spliced" }));
    phone.destroy();
    ctl.socket.destroy();
  });

  it("gives up on a waiting phone after phoneWaitMs", async () => {
    h = await startRelay({ limits: { phoneWaitMs: 50 } });
    const pc = makePc();
    const ctl = await openControl(h, pc);
    const phone = await rawConnect(h);
    phone.write(await captureClientHello(`${pc.label}.${h.base}`));
    await closed(phone);
    await h.waitLog(event("phone-rejected", { label: pc.label, reason: "pool-timeout" }));
    ctl.socket.destroy();
  });

  it("answers an unknown host or an offline label with unrecognized_name", async () => {
    h = await startRelay();
    for (const sni of ["evil.example.org", `relay2.${h.base}`, `${makePc().label}.${h.base}`, `a.${makePc().label}.${h.base}`]) {
      const phone = await rawConnect(h);
      const bytes = readAll(phone);
      phone.write(await captureClientHello(sni));
      expect((await bytes).equals(ALERT(112))).toBe(true);
    }
  });

  it("closes connections without SNI and with non-TLS bytes", async () => {
    h = await startRelay();
    const noSni = await rawConnect(h);
    const noSniBytes = readAll(noSni);
    noSni.write(await captureClientHello(null));
    expect((await noSniBytes).length).toBe(0);
    await h.waitLog(event("phone-rejected", { reason: "no-sni" }));

    const http = await rawConnect(h);
    const httpBytes = readAll(http);
    http.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    expect((await httpBytes).length).toBe(0);
    await h.waitLog(event("handshake-rejected", { reason: "invalid" }));
  });

  it("validates ALPN on both routes", async () => {
    h = await startRelay();
    const pc = makePc();
    const ctl = await openControl(h, pc);
    // Relay host with an unknown protocol.
    const a = await rawConnect(h);
    const aBytes = readAll(a);
    a.write(await captureClientHello(`relay.${h.base}`, ["h2"]));
    expect((await aBytes).equals(ALERT(120))).toBe(true);
    // A label host asked for a relay-internal protocol.
    const b = await rawConnect(h);
    const bBytes = readAll(b);
    b.write(await captureClientHello(`${pc.label}.${h.base}`, ["wink-ctl/1"]));
    expect((await bBytes).equals(ALERT(120))).toBe(true);
    ctl.socket.destroy();
  });

  it("times out an incomplete ClientHello and rejects an oversize one", async () => {
    h = await startRelay({ limits: { handshakeTimeoutMs: 50 } });
    const slow = await rawConnect(h);
    slow.write((await captureClientHello(`relay.${h.base}`)).subarray(0, 10));
    await closed(slow);
    await h.waitLog(event("handshake-rejected", { reason: "timeout", bytesIn: 10 }));

    // Records that never finish a ClientHello within 16 KiB.
    const big = await rawConnect(h);
    const record = Buffer.alloc(5 + 16384);
    record.set([0x16, 0x03, 0x01, 0x40, 0x00, 0x01, 0x00, 0xff, 0xff]);
    big.write(record);
    big.write(record);
    await closed(big);
    await h.waitLog(event("handshake-rejected", { reason: "invalid" }));
    expect(h.relay.pendingHandshakes).toBe(0);
  });

  it("bounds concurrent incomplete handshakes", async () => {
    h = await startRelay({ limits: { maxPendingHandshakes: 1 } });
    const first = await rawConnect(h);
    first.write(Buffer.from([0x16, 0x03]));
    const second = await rawConnect(h);
    await closed(second);
    await h.waitLog(event("conn-rejected", { reason: "pending-limit" }));
    first.destroy();
  });

  it("caps total open connections", async () => {
    h = await startRelay({ limits: { maxConnections: 1 } });
    const first = await rawConnect(h);
    const second = await rawConnect(h);
    await closed(second);
    await h.waitLog(event("conn-rejected", { reason: "connection-limit" }));
    first.destroy();
  });

  it("rate limits new connections per source IP", async () => {
    h = await startRelay({ limits: { connPerIpPerSec: 0.001, connPerIpBurst: 2 } });
    const ok = [await rawConnect(h), await rawConnect(h)];
    const third = await rawConnect(h);
    await closed(third);
    await h.waitLog(event("conn-rejected", { reason: "rate-limited" }));
    for (const s of ok) s.destroy();
  });

  it("caps concurrent phones per label", async () => {
    h = await startRelay({ limits: { maxSplicedPerLabel: 1 } });
    const pc = makePc();
    const ctl = await openControl(h, pc);
    const datas = [];
    for (let i = 0; i < 2; i++) datas.push(await openData(h, ctl.ready.session, ctl.ready.poolToken));
    await h.waitLog(event("join", { label: pc.label }), 2);
    const hello = await captureClientHello(`${pc.label}.${h.base}`);
    const first = await rawConnect(h);
    const go = Promise.race(datas.map(awaitGo));
    first.write(hello);
    await go;
    const second = await rawConnect(h);
    second.write(hello);
    await closed(second);
    await h.waitLog(event("phone-rejected", { label: pc.label, reason: "label-limit" }));
    first.destroy();
    ctl.socket.destroy();
  });
});
