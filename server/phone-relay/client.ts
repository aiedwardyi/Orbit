// Outbound connection from this PC to relay.<base>:443 (design sections 3, 7).
// One control channel authenticates and stays registered; a small pool of
// idle data channels waits for `go`, after which the channel carries one
// phone connection's raw TLS bytes to the ingress. Every connection resolves
// DNS again. Callbacks from a replaced or stopped connection change nothing.

import { lookup as dnsLookup } from "node:dns/promises";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import {
  ALPN_CONTROL,
  ALPN_DATA,
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeFrame,
  signAuth,
  type RelayMessage,
} from "../../shared/relay-protocol.ts";
import type { Cancel, Clock } from "./clock.ts";
import type { Identity } from "./store.ts";

export const RELAY_PORT = 443;
export const CONNECT_TIMEOUT_MS = 15_000;
export const HEARTBEAT_MS = 30_000;
/** Two missed heartbeats, plus slack for one round trip. */
export const DEAD_AFTER_MS = 2 * HEARTBEAT_MS + 5_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
export const BACKOFF_LONG_CAP_MS = 15 * 60_000;
export const LONG_FAILURE_MS = 60 * 60_000;
export const STABLE_AFTER_MS = 60_000;
export const TICK_MS = 10_000;
export const SLEEP_GAP_MS = 30_000;
export const DRAIN_MIN_MS = 500;
export const DRAIN_MAX_MS = 2_000;
export const BURST_MS = 60_000;
export const MAX_POOL = 16;
export const MAX_PARALLEL_OPENS = 4;
export const REFILL_RETRY_BASE_MS = 1_000;
export const REFILL_RETRY_CAP_MS = 30_000;
/** A data channel that closes sooner than this counts as a failed open. */
const SHORT_LIVED_MS = 5_000;

export interface RelayConnector {
  /** Resolves the relay host. Called for every new connection; never cached here. */
  lookup(host: string): Promise<string>;
  /** Verified TLS to `address` with SNI `servername` and one ALPN id. */
  connect(address: string, servername: string, alpn: string): TLSSocket;
}

export function defaultConnector(port = RELAY_PORT, ca?: string | string[]): RelayConnector {
  return {
    async lookup(host) {
      const result = await dnsLookup(host, { verbatim: true });
      return result.address;
    },
    connect(address, servername, alpn) {
      return tlsConnect({ host: address, port, servername, ALPNProtocols: [alpn], ca, minVersion: "TLSv1.2" });
    },
  };
}

export type ClientState = "connecting" | "connected" | "backoff" | "rejected" | "stopped";

export interface ClientSnapshot {
  state: ClientState;
  rttMs: number | null;
  poolIdle: number;
  lastError: string | null;
  nextRetryAt: number | null;
}

export interface RelayClientOptions {
  /** relay.<base> */
  relayHost: string;
  identity: Identity;
  ticket: string;
  connector: RelayConnector;
  clock: Clock;
  random?: () => number;
  /** A phone arrived on a data channel. `head` holds bytes read past the go frame. */
  onGo(socket: TLSSocket, head: Buffer, peer: string): void;
  /** The relay sent a refreshed ticket. Return false to keep the current one. */
  onTicket(ticket: string): boolean;
  /** Something in snapshot() changed. */
  onChange(): void;
}

interface DataChannel {
  socket: TLSSocket | null;
  state: "opening" | "idle";
  openedAt: number;
}

interface Session {
  gen: number;
  socket: TLSSocket;
  ready: boolean;
  authSent: boolean;
  draining: boolean;
  /** Why this session ended, when we know better than "closed". */
  error: string | null;
  sessionId: string;
  poolToken: string;
  poolMin: number;
  poolMax: number;
  connectedAt: number;
  lastReceived: number;
  pingSentAt: number | null;
  channels: Set<DataChannel>;
  cancels: Set<Cancel>;
}

export class RelayClient {
  private readonly opts: RelayClientOptions;
  private readonly clock: Clock;
  private readonly random: () => number;
  private ticket: string;
  private state: ClientState = "connecting";
  private session: Session | null = null;
  private gen = 0;
  private attempts = 0;
  private failingSince: number | null = null;
  private retry: Cancel | null = null;
  private tick: Cancel | null = null;
  private lastTick = 0;
  private burstUntil = 0;
  private refillFailures = 0;
  private refillTimer: Cancel | null = null;
  private rttMs: number | null = null;
  private lastError: string | null = null;
  private nextRetryAt: number | null = null;

  constructor(options: RelayClientOptions) {
    this.opts = options;
    this.clock = options.clock;
    this.random = options.random ?? Math.random;
    this.ticket = options.ticket;
  }

  snapshot(): ClientSnapshot {
    let poolIdle = 0;
    if (this.session?.ready) for (const channel of this.session.channels) if (channel.state === "idle") poolIdle++;
    return { state: this.state, rttMs: this.rttMs, poolIdle, lastError: this.lastError, nextRetryAt: this.nextRetryAt };
  }

  start(): void {
    if (this.state === "stopped") return;
    this.lastTick = this.clock.now();
    this.scheduleTick();
    void this.attempt();
  }

  /** Idempotent. Cancels timers, closes owned sockets and silences callbacks. */
  stop(): void {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.gen++;
    this.retry?.();
    this.retry = null;
    this.tick?.();
    this.tick = null;
    this.endSession();
  }

  private get stopped(): boolean {
    return this.state === "stopped";
  }

  private changed(): void {
    if (!this.stopped) this.opts.onChange();
  }

  private scheduleTick(): void {
    this.tick = this.clock.schedule(TICK_MS, () => {
      if (this.stopped) return;
      const now = this.clock.now();
      const gap = now - this.lastTick - TICK_MS;
      this.lastTick = now;
      this.scheduleTick();
      if (gap > SLEEP_GAP_MS) this.wake();
    });
  }

  /** After OS sleep: the old TCP connection is likely dead, so start over now. */
  private wake(): void {
    if (this.state === "rejected") return;
    this.retry?.();
    this.retry = null;
    this.attempts = 0;
    this.failingSince = null;
    this.endSession();
    void this.attempt();
  }

  private async attempt(): Promise<void> {
    if (this.stopped || this.state === "rejected") return;
    const gen = ++this.gen;
    this.retry = null;
    this.state = "connecting";
    this.nextRetryAt = null;
    this.changed();
    let address: string;
    try {
      address = await this.opts.connector.lookup(this.opts.relayHost);
    } catch (error) {
      if (gen === this.gen) this.fail(gen, `cannot resolve ${this.opts.relayHost}: ${message(error)}`);
      return;
    }
    if (gen !== this.gen || this.stopped) return;
    const socket = this.opts.connector.connect(address, this.opts.relayHost, ALPN_CONTROL);
    const session: Session = {
      gen,
      socket,
      ready: false,
      authSent: false,
      draining: false,
      error: null,
      sessionId: "",
      poolToken: "",
      poolMin: 0,
      poolMax: 0,
      connectedAt: 0,
      lastReceived: this.clock.now(),
      pingSentAt: null,
      channels: new Set(),
      cancels: new Set(),
    };
    this.session = session;
    const decoder = new FrameDecoder();
    session.cancels.add(
      this.clock.schedule(CONNECT_TIMEOUT_MS, () => {
        if (!session.ready) this.closeSession(session, "relay did not answer in time");
      }),
    );
    socket.once("secureConnect", () => {
      if (socket.alpnProtocol !== ALPN_CONTROL) {
        this.closeSession(session, "relay did not accept the control protocol");
        return;
      }
      socket.setNoDelay(true);
      socket.setKeepAlive(true, HEARTBEAT_MS);
    });
    socket.on("data", (chunk: Buffer) => {
      if (session !== this.session) return;
      session.lastReceived = this.clock.now();
      decoder.push(chunk);
      try {
        for (let msg = decoder.next(); msg; msg = decoder.next()) {
          this.onControl(session, msg);
          if (session !== this.session) return;
        }
      } catch (error) {
        this.closeSession(session, `relay protocol error: ${message(error)}`);
      }
    });
    socket.on("error", (error) => {
      session.error ??= message(error);
    });
    socket.once("close", () => this.onControlClosed(session));
  }

  private send(socket: TLSSocket, msg: RelayMessage): void {
    if (!socket.destroyed) socket.write(encodeFrame(msg));
  }

  private onControl(session: Session, msg: RelayMessage): void {
    switch (msg.type) {
      case "hello": {
        if (session.authSent) throw new Error("unexpected hello");
        if (msg.v !== PROTOCOL_VERSION) throw new Error(`unsupported relay protocol ${msg.v}`);
        const { label, pk, privateKey } = this.opts.identity;
        this.send(session.socket, { type: "auth", label, pk, ticket: this.ticket, sig: signAuth(privateKey, msg.nonce, label) });
        session.authSent = true;
        return;
      }
      case "ready":
        if (!session.authSent || session.ready) throw new Error("unexpected ready");
        this.onReady(session, msg.session, msg.poolToken, msg.pool.min, msg.pool.max, msg.ticket);
        return;
      case "want":
        if (!session.ready) throw new Error("unexpected want");
        if (msg.n > 0) this.burst(session);
        return;
      case "ping":
        this.send(session.socket, { type: "pong" });
        return;
      case "pong":
        if (session.pingSentAt !== null) {
          this.rttMs = Math.max(0, this.clock.now() - session.pingSentAt);
          session.pingSentAt = null;
          this.changed();
        }
        return;
      case "notice":
        if (msg.code === "draining") {
          session.draining = true;
          session.socket.destroy();
          return;
        }
        this.reject(msg.code === "superseded" ? "superseded: this phone address is in use on another computer" : "revoked: relay access removed, enter an invite");
        return;
      default:
        throw new Error(`unexpected ${msg.type} on control channel`);
    }
  }

  private onReady(session: Session, sessionId: string, poolToken: string, min: number, max: number, ticket?: string): void {
    session.ready = true;
    session.sessionId = sessionId;
    session.poolToken = poolToken;
    session.poolMax = Math.min(max, MAX_POOL);
    session.poolMin = Math.min(min, session.poolMax);
    session.connectedAt = this.clock.now();
    if (ticket && ticket !== this.ticket && this.opts.onTicket(ticket)) this.ticket = ticket;
    this.state = "connected";
    this.lastError = null;
    this.nextRetryAt = null;
    this.refillFailures = 0;
    this.scheduleHeartbeat(session);
    this.changed();
    this.refill();
  }

  private scheduleHeartbeat(session: Session): void {
    const cancel = this.clock.schedule(HEARTBEAT_MS, () => {
      session.cancels.delete(cancel);
      if (session !== this.session) return;
      if (this.clock.now() - session.lastReceived > DEAD_AFTER_MS) {
        this.closeSession(session, "relay stopped answering heartbeats");
        return;
      }
      session.pingSentAt = this.clock.now();
      this.send(session.socket, { type: "ping" });
      this.scheduleHeartbeat(session);
    });
    session.cancels.add(cancel);
  }

  private reject(reason: string): void {
    this.state = "rejected";
    this.lastError = reason;
    this.nextRetryAt = null;
    this.gen++;
    this.endSession();
    this.opts.onChange();
  }

  private closeSession(session: Session, reason: string): void {
    if (session !== this.session) return;
    session.error ??= reason;
    session.socket.destroy();
  }

  /** Tears down the current session's control socket and unspliced data channels. */
  private endSession(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.refillTimer?.();
    this.refillTimer = null;
    for (const cancel of session.cancels) cancel();
    session.cancels.clear();
    for (const channel of session.channels) channel.socket?.destroy();
    session.channels.clear();
    session.socket.destroy();
  }

  private onControlClosed(session: Session): void {
    if (session !== this.session || this.stopped) return;
    const connectedFor = session.ready ? this.clock.now() - session.connectedAt : 0;
    const refused = !session.ready && session.authSent;
    this.lastError = session.error ?? (refused ? "relay refused authentication" : "connection to relay closed");
    this.endSession();
    if (session.draining) {
      this.lastError = "relay restarting";
      this.scheduleRetry(DRAIN_MIN_MS + this.random() * (DRAIN_MAX_MS - DRAIN_MIN_MS));
      return;
    }
    this.backoff(connectedFor);
  }

  private fail(gen: number, reason: string): void {
    if (gen !== this.gen || this.stopped) return;
    this.lastError = reason;
    this.endSession();
    this.backoff(0);
  }

  private backoff(connectedFor: number): void {
    const now = this.clock.now();
    if (connectedFor >= STABLE_AFTER_MS) {
      this.attempts = 0;
      this.failingSince = null;
    }
    this.failingSince ??= now;
    const cap = now - this.failingSince >= LONG_FAILURE_MS ? BACKOFF_LONG_CAP_MS : BACKOFF_CAP_MS;
    const ceiling = Math.min(cap, BACKOFF_BASE_MS * 2 ** Math.min(this.attempts, 20));
    this.attempts++;
    this.scheduleRetry(this.random() * ceiling);
  }

  private scheduleRetry(delay: number): void {
    this.gen++;
    this.state = "backoff";
    this.nextRetryAt = this.clock.now() + delay;
    this.retry?.();
    this.retry = this.clock.schedule(delay, () => void this.attempt());
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Data channel pool

  private burst(session: Session): void {
    this.burstUntil = this.clock.now() + BURST_MS;
    const trim = this.clock.schedule(BURST_MS, () => {
      session.cancels.delete(trim);
      if (session === this.session) this.trim(session);
    });
    session.cancels.add(trim);
    this.refill();
  }

  /** After a burst, close idle channels above the steady minimum. */
  private trim(session: Session): void {
    if (this.clock.now() < this.burstUntil) return;
    let idle = 0;
    for (const channel of session.channels) {
      if (channel.state !== "idle") continue;
      idle++;
      if (idle > session.poolMin) {
        session.channels.delete(channel);
        channel.socket?.destroy();
      }
    }
    this.changed();
  }

  private refill(): void {
    const session = this.session;
    if (!session?.ready || this.stopped || this.refillTimer) return;
    const target = this.clock.now() < this.burstUntil ? session.poolMax : session.poolMin;
    let idle = 0;
    let opening = 0;
    for (const channel of session.channels) {
      if (channel.state === "idle") idle++;
      else opening++;
    }
    while (idle + opening < target && opening < MAX_PARALLEL_OPENS) {
      opening++;
      void this.openData(session);
    }
  }

  private scheduleRefill(): void {
    if (this.refillTimer || this.stopped) return;
    const delay = Math.min(REFILL_RETRY_CAP_MS, REFILL_RETRY_BASE_MS * 2 ** Math.min(this.refillFailures, 10));
    this.refillFailures++;
    this.refillTimer = this.clock.schedule(delay, () => {
      this.refillTimer = null;
      this.refill();
    });
  }

  private async openData(session: Session): Promise<void> {
    const channel: DataChannel = { socket: null, state: "opening", openedAt: this.clock.now() };
    session.channels.add(channel);
    let address: string;
    try {
      address = await this.opts.connector.lookup(this.opts.relayHost);
    } catch {
      address = "";
    }
    if (session !== this.session || !session.channels.has(channel)) return;
    if (!address) {
      session.channels.delete(channel);
      this.scheduleRefill();
      return;
    }
    const socket = this.opts.connector.connect(address, this.opts.relayHost, ALPN_DATA);
    channel.socket = socket;
    const decoder = new FrameDecoder();
    const stopTimer = this.clock.schedule(CONNECT_TIMEOUT_MS, () => {
      if (channel.state === "opening") socket.destroy();
    });
    session.cancels.add(stopTimer);
    const onData = (chunk: Buffer) => {
      decoder.push(chunk);
      let msg: RelayMessage | undefined;
      try {
        msg = decoder.next();
      } catch {
        socket.destroy();
        return;
      }
      if (!msg) return;
      if (msg.type !== "go" || channel.state !== "idle" || session !== this.session) {
        socket.destroy();
        return;
      }
      socket.off("data", onData);
      socket.pause();
      session.channels.delete(channel);
      this.refillFailures = 0;
      this.opts.onGo(socket, decoder.rest(), msg.peer);
      let idle = 0;
      for (const other of session.channels) if (other.state === "idle") idle++;
      if (idle === 0) this.burst(session);
      else this.refill();
      this.changed();
    };
    socket.once("secureConnect", () => {
      stopTimer();
      session.cancels.delete(stopTimer);
      if (session !== this.session || socket.alpnProtocol !== ALPN_DATA) {
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);
      socket.setKeepAlive(true, HEARTBEAT_MS);
      this.send(socket, { type: "join", session: session.sessionId, poolToken: session.poolToken });
      channel.state = "idle";
      this.changed();
      this.refill();
    });
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      stopTimer();
      session.cancels.delete(stopTimer);
      if (!session.channels.delete(channel) || session !== this.session) return;
      const shortLived = channel.state === "opening" || this.clock.now() - channel.openedAt < SHORT_LIVED_MS;
      this.changed();
      if (shortLived) {
        this.scheduleRefill();
        return;
      }
      this.refillFailures = 0;
      this.refill();
    });
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
