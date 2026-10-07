// Phone TLS ends here, inside Wink's own process (design sections 2, 3, 6).
// A data channel that received `go` carries the phone's raw TLS bytes. We
// peek the ClientHello, then terminate TLS with this PC's certificate (or the
// ACME challenge certificate for acme-tls/1) and hand the decrypted socket to
// an http.Server that never listens: no new port is opened.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { isIP } from "node:net";
import { Duplex } from "node:stream";
import { TLSSocket, createSecureContext, type SecureContext } from "node:tls";

import type { HarnessHandler } from "../early-listen.ts";
import { ALPN_ACME } from "../../shared/relay-protocol.ts";
import { parseClientHello, type ClientHelloInfo } from "../../shared/tls-client-hello.ts";
import { realClock, type Clock } from "./clock.ts";
import { markRelaySocket } from "./via.ts";

export const ALPN_HTTP1 = "http/1.1";
export const PEEK_TIMEOUT_MS = 10_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Matches the relay's idle timeout; SSE heartbeats every 15 s keep streams alive. */
export const IDLE_TIMEOUT_MS = 10 * 60_000;
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const MAX_PEER_LENGTH = 64;

const relayPeers = new WeakMap<Duplex, string>();

/**
 * The phone's address as reported by the relay's authenticated `go` frame,
 * for rate limits only. Keyed on socket identity, so no header can set it.
 */
export function relayPeerForRequest(req: IncomingMessage): string | null {
  return relayPeers.get(req.socket) ?? null;
}

function cleanPeer(peer: string): string | null {
  return peer.length <= MAX_PEER_LENGTH && isIP(peer) !== 0 ? peer : null;
}

/** Replays `head`, then the rest of `source`, with backpressure both ways. */
export class SpliceStream extends Duplex {
  private readonly source: Duplex;
  private pendingWrite: (() => void) | null = null;

  constructor(source: Duplex, head: Buffer) {
    super();
    this.source = source;
    if (head.length > 0) this.push(head);
    source.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) source.pause();
    });
    source.on("end", () => this.push(null));
    source.on("drain", () => {
      const done = this.pendingWrite;
      this.pendingWrite = null;
      done?.();
    });
    source.on("error", (error) => this.destroy(error));
    source.on("close", () => this.destroy());
  }

  override _read(): void {
    this.source.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.source.write(chunk)) done();
    else this.pendingWrite = done;
  }

  override _final(done: (error?: Error | null) => void): void {
    this.source.end();
    done();
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.pendingWrite = null;
    this.source.destroy();
    done(error);
  }
}

export type IngressRejection = "invalid-hello" | "wrong-sni" | "unsupported-alpn" | "no-certificate" | "no-challenge" | "timeout";

export interface IngressOptions {
  /** `<label>.<base>`, the only SNI this PC serves. */
  host: string;
  handler: HarnessHandler;
  clock?: Clock;
  /** Test hook: why a connection was refused before TLS. */
  onReject?: (reason: IngressRejection) => void;
}

export class RelayIngress {
  private readonly host: string;
  private readonly clock: Clock;
  private readonly onReject: (reason: IngressRejection) => void;
  private readonly http: Server;
  private phoneContext: SecureContext | null = null;
  private challengeContext: SecureContext | null = null;
  private readonly owned = new Set<Duplex>();
  private closed = false;

  constructor(options: IngressOptions) {
    this.host = options.host.toLowerCase();
    this.clock = options.clock ?? realClock;
    this.onReject = options.onReject ?? (() => {});
    this.http = createServer(options.handler);
    this.http.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    this.http.timeout = IDLE_TIMEOUT_MS;
  }

  get hasCertificate(): boolean {
    return this.phoneContext !== null;
  }

  /** Installs or swaps the phone certificate; new connections use it, open ones keep theirs. */
  setCertificate(keyPem: string, certPem: string): void {
    this.phoneContext = createSecureContext({ key: keyPem, cert: certPem });
  }

  setChallenge(keyPem: string, certPem: string): void {
    this.challengeContext = createSecureContext({ key: keyPem, cert: certPem });
  }

  clearChallenge(): void {
    this.challengeContext = null;
  }

  /** Number of streams this ingress still owns (test hook). */
  get openStreams(): number {
    return this.owned.size;
  }

  /** Takes over a data channel after `go`. `head` holds bytes already read past the frame. */
  accept(source: Duplex, head: Buffer, peer: string): void {
    if (this.closed) {
      source.destroy();
      return;
    }
    this.own(source);
    let buf = head;
    let done = false;
    const stopTimer = this.clock.schedule(PEEK_TIMEOUT_MS, () => finish("timeout"));
    const onData = (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      decide();
    };
    const finish = (reason: IngressRejection | null, info?: ClientHelloInfo) => {
      if (done) return;
      done = true;
      stopTimer();
      source.off("data", onData);
      source.pause();
      if (reason || !info) {
        this.reject(source, reason ?? "invalid-hello");
        return;
      }
      this.route(source, buf, info, peer);
    };
    const decide = () => {
      const info = parseClientHello(buf);
      if (info === "more") return;
      if (info === "invalid") finish("invalid-hello");
      else finish(null, info);
    };
    source.on("data", onData);
    source.once("close", () => {
      done = true;
      stopTimer();
    });
    source.on("error", () => source.destroy());
    if (buf.length > 0) decide();
    if (!done) source.resume();
  }

  /** Destroys every stream this ingress owns. Idempotent. */
  close(): void {
    this.closed = true;
    this.challengeContext = null;
    for (const stream of this.owned) stream.destroy();
    this.owned.clear();
  }

  private own(stream: Duplex): void {
    this.owned.add(stream);
    stream.once("close", () => this.owned.delete(stream));
  }

  private reject(source: Duplex, reason: IngressRejection): void {
    this.onReject(reason);
    source.destroy();
  }

  private route(source: Duplex, head: Buffer, info: ClientHelloInfo, peer: string): void {
    if (info.sni !== this.host) return this.reject(source, "wrong-sni");
    if (info.alpn.includes(ALPN_ACME)) {
      // RFC 8737 3: the validation server offers acme-tls/1 and nothing else.
      if (info.alpn.length !== 1) return this.reject(source, "unsupported-alpn");
      const context = this.challengeContext;
      if (!context) return this.reject(source, "no-challenge");
      return this.serveChallenge(source, head, context);
    }
    if (info.alpn.length > 0 && !info.alpn.includes(ALPN_HTTP1)) return this.reject(source, "unsupported-alpn");
    const context = this.phoneContext;
    if (!context) return this.reject(source, "no-certificate");
    this.servePhone(source, head, context, peer);
  }

  private terminate(source: Duplex, head: Buffer, context: SecureContext, alpn: string): TLSSocket {
    const stream = new SpliceStream(source, head);
    this.own(stream);
    const host = this.host;
    const tlsSocket = new TLSSocket(stream, {
      isServer: true,
      secureContext: context,
      ALPNProtocols: [alpn],
      SNICallback: (name, cb) => (name.toLowerCase() === host ? cb(null, context) : cb(new Error("wrong server name"), undefined)),
    });
    this.own(tlsSocket);
    tlsSocket.on("error", () => tlsSocket.destroy());
    const stopTimer = this.clock.schedule(HANDSHAKE_TIMEOUT_MS, () => tlsSocket.destroy());
    tlsSocket.once("secure", stopTimer);
    tlsSocket.once("close", stopTimer);
    return tlsSocket;
  }

  private serveChallenge(source: Duplex, head: Buffer, context: SecureContext): void {
    const tlsSocket = this.terminate(source, head, context, ALPN_ACME);
    // The validation server only reads our certificate, then closes.
    tlsSocket.resume();
    tlsSocket.once("secure", () => {
      const stop = this.clock.schedule(HANDSHAKE_TIMEOUT_MS, () => tlsSocket.destroy());
      tlsSocket.once("close", stop);
    });
  }

  private servePhone(source: Duplex, head: Buffer, context: SecureContext, peer: string): void {
    const tlsSocket = this.terminate(source, head, context, ALPN_HTTP1);
    const cleaned = cleanPeer(peer);
    if (cleaned) relayPeers.set(tlsSocket, cleaned);
    markRelaySocket(tlsSocket);
    this.http.emit("connection", tlsSocket);
  }
}
