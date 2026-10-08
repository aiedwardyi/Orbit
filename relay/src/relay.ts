// The relay process: one plain TCP listener that peeks each ClientHello and
// either terminates TLS for relay.<base> or splices raw bytes to a PC
// (design section 5).

import { createPublicKey, type KeyObject } from "node:crypto";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { createSecureContext, createServer as createTlsServer, type SecureContext, type TLSSocket } from "node:tls";
import { ALPN_ACME, ALPN_CONTROL, ALPN_DATA, labelFromHost } from "../../shared/relay-protocol.ts";
import { parseClientHello } from "../../shared/tls-client-hello.ts";
import { CertManager, type AcmeClientLike } from "./acme.ts";
import { BASE_RE } from "./config.ts";
import { handleControl, handleData, type ChannelContext } from "./channels.ts";
import { Enroller, TICKET_TTL_SEC } from "./enroll.ts";
import { createApiServer } from "./http.ts";
import { Hub } from "./hub.ts";
import { InviteStore } from "./invites.ts";
import { DEFAULT_LIMITS, RateLimiter, type RelayLimits } from "./limits.ts";
import { silentLogger, type Logger } from "./log.ts";
import {
  ALERT_INTERNAL_ERROR,
  ALERT_NO_APPLICATION_PROTOCOL,
  ALERT_UNRECOGNIZED_NAME,
  peerAddress,
  peerPrefix,
  rateKey,
  sendAlert,
} from "./net-util.ts";
import { RevocationList } from "./revocation.ts";

/** ALPN ids served on relay.<base>, besides acme-tls/1. */
export const RELAY_ALPNS: readonly string[] = [ALPN_CONTROL, ALPN_DATA, "http/1.1"];
/** Explicit phone ALPN offers must include one of these. */
export const PHONE_ALPNS: readonly string[] = ["http/1.1", ALPN_ACME];

export interface RelayOptions {
  /** Base domain, e.g. from config. Never hardcoded. */
  base: string;
  operatorPrivateKey: KeyObject;
  /** /var/lib/wink-relay in production. */
  dataDir: string;
  revokedLabelsFile?: string;
  /** Fixed certificate for relay.<base>; when absent, `acme` must be set. */
  certificate?: { key: string | Buffer; cert: string | Buffer };
  acme?: {
    directoryUrl: string;
    email?: string;
    termsOfServiceAgreed: boolean;
    createClient?: (opts: { directoryUrl: string; accountKey: Buffer }) => AcmeClientLike;
  };
  limits?: Partial<RelayLimits>;
  log?: Logger;
  now?: () => number;
  ticketTtlSec?: number;
  revocationPollMs?: number;
}

export interface Relay {
  readonly relayHost: string;
  readonly hub: Hub;
  readonly certManager: CertManager | null;
  /** Count of sockets still reading their ClientHello. */
  readonly pendingHandshakes: number;
  listen(port: number, host?: string): Promise<AddressInfo>;
  /** Re-reads the revoked-labels file and cuts newly revoked labels. */
  reloadRevocations(): Promise<void>;
  /** Drains: PCs get `draining`, splices get the grace period, then everything closes. */
  close(): Promise<void>;
}

export async function createRelay(opts: RelayOptions): Promise<Relay> {
  const base = opts.base.toLowerCase();
  const relayHost = hostForRelay(base);
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const log = opts.log ?? silentLogger;
  const now = opts.now ?? Date.now;
  const operatorPublicKey = createPublicKey(opts.operatorPrivateKey);
  if (operatorPublicKey.asymmetricKeyType !== "ed25519") throw new Error("operator key must be Ed25519");

  const hub = new Hub({ limits, log, now });
  const revoked = new RevocationList(opts.revokedLabelsFile, log);
  await revoked.load();
  const store = await InviteStore.open(opts.dataDir, now);
  const ticketTtlSec = opts.ticketTtlSec ?? TICKET_TTL_SEC;
  const enroller = new Enroller({
    operatorPrivateKey: opts.operatorPrivateKey,
    operatorPublicKey,
    store,
    isRevoked: (label) => revoked.has(label),
    now,
    ticketTtlSec,
  });
  const ctx: ChannelContext = {
    hub,
    limits,
    log,
    revoked,
    operatorPublicKey,
    operatorPrivateKey: opts.operatorPrivateKey,
    ticketTtlSec,
    now,
  };

  let serving: SecureContext | null = null;
  let challenge: SecureContext | null = null;
  const connLimit = new RateLimiter(limits.connPerIpPerSec, limits.connPerIpBurst, now);
  const authLimit = RateLimiter.perMinute(limits.controlAuthPerIpPerMin, now);

  const api = createApiServer({ base, relayHost, hub, enroller, limits, log, now });

  const relayTls = createTlsServer({
    SNICallback: (name, cb) => (name === relayHost && serving ? cb(null, serving) : cb(new Error("no certificate"))),
    ALPNCallback: ({ protocols }) => protocols.find((p) => RELAY_ALPNS.includes(p)),
    handshakeTimeout: limits.tlsHandshakeTimeoutMs,
    minVersion: "TLSv1.2",
  });
  relayTls.on("secureConnection", (socket: TLSSocket) => {
    socket.on("error", () => {});
    switch (socket.alpnProtocol || "http/1.1") {
      case ALPN_CONTROL:
        if (!authLimit.take(rateKey(socket.remoteAddress))) {
          log.log("control-rejected", { peer: peerPrefix(socket.remoteAddress), reason: "rate-limited" });
          socket.destroy();
          return;
        }
        handleControl(ctx, socket);
        return;
      case ALPN_DATA:
        handleData(ctx, socket);
        return;
      case "http/1.1":
        api.emit("connection", socket);
        return;
      default:
        socket.destroy();
    }
  });
  relayTls.on("tlsClientError", (error: NodeJS.ErrnoException, socket: TLSSocket) => {
    log.log("tls-error", { peer: peerPrefix(socket.remoteAddress), reason: tlsReason(error) });
    socket.destroy();
  });

  const acmeTls = createTlsServer({
    SNICallback: (name, cb) => (name === relayHost && challenge ? cb(null, challenge) : cb(new Error("no challenge"))),
    ALPNProtocols: [ALPN_ACME],
    handshakeTimeout: limits.tlsHandshakeTimeoutMs,
  });
  acmeTls.on("secureConnection", (socket: TLSSocket) => {
    log.log("acme-challenge-served", {});
    socket.on("error", () => {});
    socket.end();
  });
  acmeTls.on("tlsClientError", (_error: Error, socket: TLSSocket) => socket.destroy());

  let certManager: CertManager | null = null;
  if (opts.certificate) {
    serving = createSecureContext({ key: opts.certificate.key, cert: opts.certificate.cert });
  } else if (opts.acme) {
    certManager = new CertManager({
      host: relayHost,
      dir: join(opts.dataDir, "acme"),
      directoryUrl: opts.acme.directoryUrl,
      email: opts.acme.email,
      termsOfServiceAgreed: opts.acme.termsOfServiceAgreed,
      createClient: opts.acme.createClient,
      log,
      now,
      onCertificate: (context) => {
        serving = context;
      },
      onChallenge: (context) => {
        challenge = context;
      },
    });
  } else {
    throw new Error("either certificate or acme is required");
  }

  const sockets = new Set<Socket>();
  const pending = new Set<Socket>();
  let closing = false;

  const route = (socket: Socket, buffered: Buffer, sni: string | null, alpn: string[]) => {
    const peer = peerPrefix(socket.remoteAddress);
    if (sni === null) {
      log.log("phone-rejected", { peer, reason: "no-sni" });
      socket.destroy();
      return;
    }
    if (sni === relayHost) {
      if (alpn.includes(ALPN_ACME)) {
        if (!challenge) {
          socket.destroy();
          return;
        }
        handOff(socket, buffered, acmeTls);
        return;
      }
      // A client without ALPN gets the HTTP API, like any plain HTTPS client.
      const proto = alpn.length === 0 ? "http/1.1" : alpn.find((p) => RELAY_ALPNS.includes(p));
      if (!proto) {
        log.log("relay-rejected", { peer, reason: "alpn" });
        sendAlert(socket, ALERT_NO_APPLICATION_PROTOCOL);
        return;
      }
      if (!serving) {
        log.log("relay-rejected", { peer, reason: "no-certificate" });
        sendAlert(socket, ALERT_INTERNAL_ERROR);
        return;
      }
      handOff(socket, buffered, relayTls);
      return;
    }
    const label = labelFromHost(sni, base);
    if (!label) {
      log.log("phone-rejected", { peer, reason: "unknown-sni" });
      sendAlert(socket, ALERT_UNRECOGNIZED_NAME);
      return;
    }
    if (alpn.length > 0 && !alpn.some((p) => PHONE_ALPNS.includes(p))) {
      log.log("phone-rejected", { label, peer, reason: "alpn" });
      sendAlert(socket, ALERT_NO_APPLICATION_PROTOCOL);
      return;
    }
    hub.dispatchPhone(label, socket, buffered, peerAddress(socket.remoteAddress));
  };

  const server = createNetServer({ noDelay: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (closing) {
      socket.destroy();
      return;
    }
    const peer = peerPrefix(socket.remoteAddress);
    if (!connLimit.take(rateKey(socket.remoteAddress))) {
      log.log("conn-rejected", { peer, reason: "rate-limited" });
      socket.destroy();
      return;
    }
    if (sockets.size > limits.maxConnections) {
      log.log("conn-rejected", { peer, reason: "connection-limit" });
      socket.destroy();
      return;
    }
    if (pending.size >= limits.maxPendingHandshakes) {
      log.log("conn-rejected", { peer, reason: "pending-limit" });
      socket.destroy();
      return;
    }
    pending.add(socket);
    let buffered: Buffer = Buffer.alloc(0);
    const done = () => {
      pending.delete(socket);
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", done);
    };
    const timer = setTimeout(() => {
      done();
      log.log("handshake-rejected", { peer, reason: "timeout", bytesIn: buffered.length });
      socket.destroy();
    }, limits.handshakeTimeoutMs);
    const onData = (chunk: Buffer) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const info = parseClientHello(buffered);
      if (info === "more") return;
      done();
      socket.pause();
      if (info === "invalid") {
        log.log("handshake-rejected", { peer, reason: "invalid", bytesIn: buffered.length });
        socket.destroy();
        return;
      }
      route(socket, buffered, info.sni, info.alpn);
    };
    socket.on("data", onData);
    socket.once("close", done);
  });

  let revocationTimer: NodeJS.Timeout | undefined;
  // SIGHUP forces a re-read; the poll only re-reads on a new mtime.
  const reloadRevocations = async (force = true) => {
    for (const label of await revoked.reload(force)) {
      log.log("label-revoked", { label });
      hub.revoke(label);
    }
  };

  return {
    relayHost,
    hub,
    certManager,
    get pendingHandshakes() {
      return pending.size;
    },
    async listen(port, host) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      revocationTimer = setInterval(() => void reloadRevocations(false), opts.revocationPollMs ?? 60_000);
      revocationTimer.unref();
      await certManager?.start();
      log.log("relay-listening", {});
      // SAFETY: the server listens on TCP, so address() is an AddressInfo, not a pipe name or null.
      return server.address() as AddressInfo;
    },
    reloadRevocations,
    async close() {
      if (closing) return;
      closing = true;
      log.log("relay-draining", { count: hub.sessionCount });
      clearInterval(revocationTimer);
      certManager?.stop();
      const listening = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of pending) socket.destroy();
      hub.drain();
      api.close();
      api.closeIdleConnections();
      await hub.whenSplicesDone(limits.drainGraceMs);
      hub.destroySplices();
      api.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await listening;
      log.log("relay-closed", {});
    },
  };
}

function hostForRelay(base: string): string {
  if (!BASE_RE.test(base)) {
    throw new Error("invalid base domain");
  }
  return `relay.${base}`;
}

function handOff(socket: Socket, buffered: Buffer, server: ReturnType<typeof createTlsServer>): void {
  socket.unshift(buffered);
  server.emit("connection", socket);
}

function tlsReason(error: NodeJS.ErrnoException): string {
  const code = String(error.code ?? "").toLowerCase();
  return /^[a-z0-9_]{1,32}$/.test(code) ? code : "handshake";
}
