// Control (ALPN wink-ctl/1) and data (ALPN wink-data/1) channels after the
// outer TLS handshake (design sections 3 and 4).

import { createHash, timingSafeEqual, type KeyObject } from "node:crypto";
import type { TLSSocket } from "node:tls";
import {
  FrameDecoder,
  encodeFrame,
  newNonce,
  publicKeyFromRaw,
  rawPublicKey,
  verifyAuth,
  verifyTicket,
  signTicket,
  PROTOCOL_VERSION,
  type AuthMessage,
  type NoticeCode,
  type ReadyMessage,
  type RelayMessage,
} from "../../shared/relay-protocol.ts";
import type { Hub, Session } from "./hub.ts";
import type { RelayLimits } from "./limits.ts";
import type { Logger } from "./log.ts";
import { peerPrefix } from "./net-util.ts";
import type { RevocationList } from "./revocation.ts";

export const POOL = Object.freeze({ min: 3, max: 8 });

export interface ChannelContext {
  hub: Hub;
  limits: RelayLimits;
  log: Logger;
  revoked: RevocationList;
  operatorPublicKey: KeyObject;
  operatorPrivateKey: KeyObject;
  ticketTtlSec: number;
  now: () => number;
}

type Check = { ok: true; label: string; ticket?: string } | { ok: false; reason: string; notice?: NoticeCode };

/** Checks an `auth` frame against the hello nonce. Pure apart from the clock. */
export function checkAuth(ctx: ChannelContext, msg: AuthMessage, nonce: string): Check {
  const now = ctx.now();
  const ticket = verifyTicket(msg.ticket, ctx.operatorPublicKey, { now });
  if (!ticket.ok) {
    // An expired ticket or one the operator key no longer verifies needs a new invite.
    const gone = ticket.reason === "expired" || ticket.reason === "bad-signature";
    return { ok: false, reason: `ticket-${ticket.reason}`, notice: gone ? "revoked" : undefined };
  }
  const claims = ticket.value;
  if (claims.label !== msg.label) return { ok: false, reason: "label-mismatch" };
  const authKey = publicKeyFromRaw(msg.pk);
  const ticketKey = publicKeyFromRaw(claims.pk);
  if (!authKey || !ticketKey || !rawPublicKey(authKey).equals(rawPublicKey(ticketKey))) {
    return { ok: false, reason: "key-mismatch" };
  }
  if (!verifyAuth(msg.pk, nonce, msg.label, msg.sig)) return { ok: false, reason: "bad-signature" };
  if (ctx.revoked.has(claims.label)) return { ok: false, reason: "revoked", notice: "revoked" };

  // Past half life: hand back a fresh ticket for the same key.
  const nowSec = Math.floor(now / 1000);
  let refreshed: string | undefined;
  if (nowSec >= claims.iat + (claims.exp - claims.iat) / 2) {
    refreshed = signTicket(
      { label: claims.label, pk: rawPublicKey(ticketKey).toString("base64url"), iat: nowSec, exp: nowSec + ctx.ticketTtlSec },
      ctx.operatorPrivateKey,
    );
  }
  return { ok: true, label: claims.label, ticket: refreshed };
}

/** Control frames are tiny; a peer that stops reading is cut instead of buffered for. */
const MAX_CONTROL_BACKLOG = 64 * 1024;

function send(socket: TLSSocket, message: RelayMessage): void {
  if (socket.destroyed || !socket.writable) return;
  if (socket.writableLength > MAX_CONTROL_BACKLOG) {
    socket.destroy();
    return;
  }
  socket.write(encodeFrame(message));
}

/** Runs one control channel: hello, auth, ready, then ping/pong and notices. */
export function handleControl(ctx: ChannelContext, socket: TLSSocket): void {
  const { hub, limits, log } = ctx;
  const peer = peerPrefix(socket.remoteAddress);
  const decoder = new FrameDecoder();
  const nonce = newNonce();
  let session: Session | undefined;
  let lastSeen = ctx.now();
  let pinger: NodeJS.Timeout | undefined;
  let closing = false;
  let closeTimer: NodeJS.Timeout | undefined;

  const close = () => socket.destroy();
  const authTimer = setTimeout(() => {
    log.log("control-rejected", { peer, reason: "auth-timeout" });
    close();
  }, limits.authTimeoutMs);

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);
  socket.on("error", () => {});
  socket.once("close", () => {
    clearTimeout(authTimer);
    clearInterval(pinger);
    clearTimeout(closeTimer);
    if (session) hub.end(session);
  });

  const link = {
    notice: (code: NoticeCode) => send(socket, { type: "notice", code }),
    want: (n: number) => send(socket, { type: "want", n }),
    close: () => {
      if (closing) return;
      closing = true;
      clearTimeout(authTimer);
      clearInterval(pinger);
      if (!socket.destroyed) socket.end();
      closeTimer = setTimeout(() => socket.destroy(), 2_000);
    },
  };

  const onMessage = (msg: RelayMessage): boolean => {
    lastSeen = ctx.now();
    if (!session) {
      if (msg.type !== "auth") return false;
      clearTimeout(authTimer);
      const result = checkAuth(ctx, msg, nonce);
      if (!result.ok) {
        log.log("control-rejected", { peer, reason: result.reason });
        if (result.notice) link.notice(result.notice);
        link.close();
        return true;
      }
      if (!hub.canRegister(result.label) || hub.draining) {
        log.log("control-rejected", { peer, label: result.label, reason: "capacity" });
        link.notice("draining");
        link.close();
        return true;
      }
      session = hub.register(result.label, link);
      const ready: ReadyMessage = { type: "ready", session: session.id, poolToken: session.poolToken, pool: { ...POOL } };
      if (result.ticket) ready.ticket = result.ticket;
      send(socket, ready);
      const waiting = hub.waitingCount(result.label);
      if (waiting > 0) link.want(waiting);
      pinger = setInterval(() => {
        if (ctx.now() - lastSeen > limits.pingIntervalMs * 2.5) {
          log.log("control-dead", { label: session?.label, reason: "missed-pings" });
          close();
          return;
        }
        send(socket, { type: "ping" });
      }, limits.pingIntervalMs);
      return true;
    }
    if (msg.type === "ping") send(socket, { type: "pong" });
    else if (msg.type !== "pong") return false;
    return true;
  };

  socket.on("data", (chunk: Buffer) => {
    if (closing) return;
    decoder.push(chunk);
    try {
      for (let msg = decoder.next(); msg; msg = decoder.next()) {
        if (socket.destroyed) return;
        if (!onMessage(msg)) {
          log.log("control-rejected", { peer, label: session?.label, reason: "unexpected-frame" });
          close();
          return;
        }
        if (closing) return;
      }
    } catch {
      log.log("control-rejected", { peer, label: session?.label, reason: "bad-frame" });
      close();
    }
  });

  send(socket, { type: "hello", v: PROTOCOL_VERSION, nonce });
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();

/** Runs one data channel until it is parked or spliced. */
export function handleData(ctx: ChannelContext, socket: TLSSocket): void {
  const { hub, limits, log } = ctx;
  const peer = peerPrefix(socket.remoteAddress);
  const decoder = new FrameDecoder();
  const timer = setTimeout(() => {
    log.log("join-rejected", { peer, reason: "join-timeout" });
    socket.destroy();
  }, limits.joinTimeoutMs);
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);
  socket.on("error", () => {});
  socket.once("close", () => clearTimeout(timer));

  const reject = (reason: string) => {
    log.log("join-rejected", { peer, reason });
    socket.destroy();
  };
  const onData = (chunk: Buffer) => {
    decoder.push(chunk);
    let msg: RelayMessage | undefined;
    try {
      msg = decoder.next();
    } catch {
      reject("bad-frame");
      return;
    }
    if (!msg) return;
    clearTimeout(timer);
    socket.off("data", onData);
    // Nothing may follow `join` before `go`.
    if (msg.type !== "join" || decoder.buffered > 0) {
      reject("bad-frame");
      return;
    }
    const token = digest(msg.poolToken);
    const label = hub.labelOf(msg.session);
    const result = hub.join(msg.session, (session) => timingSafeEqual(token, digest(session.poolToken)), socket);
    if (result === "parked" || result === "spliced") log.log("join", { label, peer, reason: result });
    else reject(result);
  };
  socket.on("data", onData);
}
