import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeFrame, signAuth, verifyTicket } from "../../shared/relay-protocol.ts";
import {
  FrameReader,
  closed,
  connectRelay,
  event,
  makePc,
  openControl,
  openData,
  startRelay,
  ticketFor,
  type Harness,
} from "./fixtures.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const rejected = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected rejection");
    },
    (error: Error & { frame?: unknown }) => error.frame ?? null,
  );

describe("control channel", () => {
  it("authenticates a PC over real TLS and reports it online", async () => {
    h = await startRelay();
    const pc = makePc();
    const ctl = await openControl(h, pc);
    expect(ctl.ready.pool).toEqual({ min: 3, max: 8 });
    expect(ctl.ready.ticket).toBeUndefined();
    expect(h.relay.hub.status(pc.label).online).toBe(true);
    ctl.socket.destroy();
    await h.waitLog(event("session-down", { label: pc.label }));
    expect(h.relay.hub.status(pc.label)).toMatchObject({ online: false });
  });

  it("answers ping and refreshes a ticket past half life", async () => {
    h = await startRelay();
    const pc = makePc();
    const now = Math.floor(Date.now() / 1000);
    const old = ticketFor(pc, h.operator, { iat: now - 200 * 86400, exp: now + 100 * 86400 });
    const ctl = await openControl(h, pc, { ticket: old });
    const fresh = verifyTicket(ctl.ready.ticket!, createPublicKey(h.operator));
    expect(fresh.ok && fresh.value.label).toBe(pc.label);
    ctl.socket.write(encodeFrame({ type: "ping" }));
    expect(await ctl.reader.next()).toEqual({ type: "pong" });
    ctl.socket.destroy();
  });

  it("rejects a bad auth signature", async () => {
    h = await startRelay();
    const pc = makePc();
    const other = makePc();
    await rejected(openControl(h, pc, { sign: (nonce) => signAuth(other.privateKey, nonce, pc.label) }));
    await h.waitLog(event("control-rejected", { reason: "bad-signature" }));
    expect(h.relay.hub.status(pc.label).online).toBe(false);
  });

  it("rejects a ticket for another label and a pk that is not the ticket's key", async () => {
    h = await startRelay();
    const pc = makePc();
    const other = makePc();
    // Ticket names `other`, auth claims `pc`.
    await rejected(openControl(h, pc, { ticket: ticketFor(other, h.operator) }));
    await h.waitLog(event("control-rejected", { reason: "label-mismatch" }));
    // Label and ticket match `other`, but the auth key is pc's own.
    await rejected(
      openControl(h, pc, {
        ticket: ticketFor(other, h.operator),
        label: other.label,
        sign: (nonce) => signAuth(pc.privateKey, nonce, other.label),
      }),
    );
    await h.waitLog(event("control-rejected", { reason: "key-mismatch" }));
  });

  it("rejects a ticket signed by another operator and an expired ticket with notice revoked", async () => {
    h = await startRelay();
    const pc = makePc();
    const stranger = generateKeyPairSync("ed25519").privateKey;
    expect(await rejected(openControl(h, pc, { ticket: ticketFor(pc, stranger) }))).toEqual({
      type: "notice",
      code: "revoked",
    });
    const now = Math.floor(Date.now() / 1000);
    const expired = ticketFor(pc, h.operator, { iat: now - 400 * 86400, exp: now - 3600 });
    expect(await rejected(openControl(h, pc, { ticket: expired }))).toEqual({ type: "notice", code: "revoked" });
    await h.waitLog(event("control-rejected", { reason: "ticket-expired" }));
  });

  it("rejects revoked labels at auth and cuts a live session on reload", async () => {
    const pcRevoked = makePc();
    const pcLive = makePc();
    const file = join(await mkdtemp(join(tmpdir(), "wink-revoked-")), "revoked-labels");
    await writeFile(file, `# revoked\n${pcRevoked.label}\n`);
    h = await startRelay({ revokedLabelsFile: file });
    expect(await rejected(openControl(h, pcRevoked))).toEqual({ type: "notice", code: "revoked" });

    const ctl = await openControl(h, pcLive);
    const data = await openData(h, ctl.ready.session, ctl.ready.poolToken);
    await h.waitLog(event("join", { label: pcLive.label }));
    await writeFile(file, `${pcRevoked.label}\n${pcLive.label}\n`);
    await h.relay.reloadRevocations();
    expect(await ctl.reader.next()).toEqual({ type: "notice", code: "revoked" });
    await closed(data);
    await closed(ctl.socket);
  });

  it("closes a control channel that never authenticates", async () => {
    h = await startRelay({ limits: { authTimeoutMs: 50 } });
    const socket = await connectRelay(h, "wink-ctl/1");
    const reader = new FrameReader(socket);
    expect((await reader.next())?.type).toBe("hello");
    expect(await reader.next()).toBeNull();
    await h.waitLog(event("control-rejected", { reason: "auth-timeout" }));
  });

  it("rate limits control auth attempts per IP", async () => {
    h = await startRelay({ limits: { controlAuthPerIpPerMin: 2 } });
    const pc = makePc();
    (await openControl(h, pc)).socket.destroy();
    (await openControl(h, pc)).socket.destroy();
    await rejected(openControl(h, pc));
    await h.waitLog(event("control-rejected", { reason: "rate-limited" }));
  });
});

describe("sessions and pools", () => {
  it("newest control wins and the superseded session loses every idle data socket", async () => {
    h = await startRelay();
    const pc = makePc();
    const first = await openControl(h, pc);
    const idle = [
      await openData(h, first.ready.session, first.ready.poolToken),
      await openData(h, first.ready.session, first.ready.poolToken),
    ];
    await h.waitLog(event("join", { label: pc.label, reason: "parked" }), 2);
    expect(h.relay.hub.idleCount(pc.label)).toBe(2);

    const second = await openControl(h, pc);
    expect(await first.reader.next()).toEqual({ type: "notice", code: "superseded" });
    await Promise.all([closed(first.socket), ...idle.map(closed)]);
    expect(h.relay.hub.idleCount(pc.label)).toBe(0);
    expect(h.relay.hub.status(pc.label).online).toBe(true);

    // The old session's token no longer parks anything.
    const stale = await openData(h, first.ready.session, first.ready.poolToken);
    await closed(stale);
    await h.waitLog(event("join-rejected", { reason: "unknown-session" }));
    const fresh = await openData(h, second.ready.session, second.ready.poolToken);
    await h.waitLog(event("join", { label: pc.label, reason: "parked" }), 3);
    expect(h.relay.hub.idleCount(pc.label)).toBe(1);
    fresh.destroy();
    second.socket.destroy();
  });

  it("rejects a pool token from another label's session", async () => {
    h = await startRelay();
    const a = await openControl(h, makePc());
    const b = await openControl(h, makePc());
    const cross = await openData(h, a.ready.session, b.ready.poolToken);
    await closed(cross);
    await h.waitLog(event("join-rejected", { reason: "bad-token" }));
    a.socket.destroy();
    b.socket.destroy();
  });

  it("caps idle data channels per label", async () => {
    h = await startRelay({ limits: { maxIdlePerLabel: 2 } });
    const pc = makePc();
    const ctl = await openControl(h, pc);
    const sockets = [];
    for (let i = 0; i < 3; i++) sockets.push(await openData(h, ctl.ready.session, ctl.ready.poolToken));
    await closed(sockets[2]);
    await h.waitLog(event("join-rejected", { reason: "pool-full" }));
    expect(h.relay.hub.idleCount(pc.label)).toBe(2);
    ctl.socket.destroy();
  });

  it("drops a parked data channel that sends bytes before go", async () => {
    h = await startRelay();
    const pc = makePc();
    const ctl = await openControl(h, pc);
    const data = await openData(h, ctl.ready.session, ctl.ready.poolToken);
    await h.waitLog(event("join", { label: pc.label }));
    data.write("early");
    await closed(data);
    await h.waitLog(event("data-protocol-error", { reason: "bytes-before-go" }));
    expect(h.relay.hub.idleCount(pc.label)).toBe(0);
    ctl.socket.destroy();
  });

  it("closes a data channel that never joins", async () => {
    h = await startRelay({ limits: { joinTimeoutMs: 50 } });
    const socket = await connectRelay(h, "wink-data/1");
    await closed(socket);
    await h.waitLog(event("join-rejected", { reason: "join-timeout" }));
  });

  it("drains on close: control gets notice draining", async () => {
    h = await startRelay();
    const ctl = await openControl(h, makePc());
    const closing = h.relay.close();
    expect(await ctl.reader.next()).toEqual({ type: "notice", code: "draining" });
    await closing;
  });
});
