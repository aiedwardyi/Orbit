// In-process stand-in for relay.<base> built on the shared protocol: SNI
// routing on one port, control and data channels, go splicing and the
// enroll API. It never decrypts phone traffic, like the real relay.

import { EventEmitter } from "node:events";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type LookupFunction, type Server, type Socket } from "node:net";
import { connect as tlsConnect, createServer as createTlsServer, type TLSSocket } from "node:tls";

import {
  ALPN_CONTROL,
  ALPN_DATA,
  FrameDecoder,
  encodeFrame,
  labelForPublicKey,
  labelFromHost,
  newNonce,
  publicKeyFromRaw,
  rawPublicKey,
  signTicket,
  verifyAuth,
  verifyInvite,
  verifyTicket,
  type ReadyMessage,
  type RelayMessage,
} from "../../../shared/relay-protocol.ts";
import { parseClientHello } from "../../../shared/tls-client-hello.ts";
import type { RelayConnector } from "../client.ts";
import { enrollPayload } from "../enroll.ts";
import { SpliceStream } from "../ingress.ts";
import { listenLocal } from "./net.ts";
import type { TestCa } from "./pki.ts";

export type GoMode = "coalesced" | "split";
export type AuthMode = "accept" | "close" | "revoke";

interface Control {
  label: string;
  session: string;
  poolToken: string;
  socket: TLSSocket;
}

export interface EnrollAnswer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

/** Loopback lookup that satisfies both single and `all` callers. */
export const loopbackLookup: LookupFunction = (_hostname, options, callback) => {
  if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
};

export class FakeRelay extends EventEmitter {
  readonly base: string;
  readonly relayHost: string;
  readonly operatorKey: KeyObject;
  readonly ca: TestCa;
  port = 0;
  pool = { min: 3, max: 8 };
  goMode: GoMode = "coalesced";
  peer = "203.0.113.7";
  authMode: AuthMode = "accept";
  refreshTicket: string | null = null;
  answerPings = true;
  enrollAnswer: ((body: string) => EnrollAnswer) | null = null;
  /** When set, enroll answers wait for it. */
  enrollGate: Promise<void> | null = null;
  readonly log: string[] = [];
  /** Every byte the relay spliced, both directions. */
  readonly spliced: Buffer[] = [];
  readonly enrollBodies: string[] = [];
  lookups = 0;
  private server: Server | null = null;
  private readonly controls = new Map<string, Control>();
  private readonly idle = new Map<string, TLSSocket[]>();
  private readonly sockets = new Set<Socket | TLSSocket>();
  private readonly relayTls: ReturnType<typeof createTlsServer>;
  private readonly http: ReturnType<typeof createHttpServer>;

  private constructor(base: string, ca: TestCa, relayCert: { keyPem: string; certPem: string }) {
    super();
    this.base = base;
    this.relayHost = `relay.${base}`;
    this.ca = ca;
    this.operatorKey = generateKeyPairSync("ed25519").privateKey;
    this.relayTls = createTlsServer({
      key: relayCert.keyPem,
      cert: relayCert.certPem,
      ALPNProtocols: [ALPN_CONTROL, ALPN_DATA, "http/1.1"],
    });
    this.relayTls.on("secureConnection", (socket) => this.onRelayTls(socket));
    this.relayTls.on("tlsClientError", () => {});
    this.http = createHttpServer((req, res) => this.onHttp(req, res));
  }

  static async start(base: string, ca: TestCa): Promise<FakeRelay> {
    const relay = new FakeRelay(base, ca, await ca.issue(`relay.${base}`));
    const server = createNetServer((socket) => relay.onRaw(socket));
    relay.server = server;
    relay.port = await listenLocal(server);
    return relay;
  }

  record(event: string): void {
    this.log.push(event);
    this.emit("event", event);
  }

  /** Resolves once `check()` holds, re-checking after every relay event. */
  until(check: () => boolean): Promise<void> {
    if (check()) return Promise.resolve();
    return new Promise((resolve) => {
      const listener = () => {
        if (!check()) return;
        this.off("event", listener);
        resolve();
      };
      this.on("event", listener);
    });
  }

  count(event: string): number {
    return this.log.filter((entry) => entry === event).length;
  }

  idleCount(label: string): number {
    return this.idle.get(label)?.length ?? 0;
  }

  hasControl(label: string): boolean {
    return this.controls.has(label);
  }

  operatorPublicKey(): KeyObject {
    return this.operatorKey;
  }

  /** Mints a ticket for a raw public key, as the operator would. */
  ticketFor(pk: string, lifetimeSec = 365 * 24 * 3600, now = Date.now()): string {
    const label = labelForPublicKey(Buffer.from(pk, "base64url"));
    const iat = Math.floor(now / 1000);
    return signTicket({ label, pk, iat, exp: iat + lifetimeSec }, this.operatorKey);
  }

  connector(addressFor: () => string = () => "127.0.0.1", onConnect?: (address: string, alpn: string) => void): RelayConnector {
    return {
      lookup: async () => {
        this.lookups++;
        return addressFor();
      },
      connect: (address, servername, alpn) => {
        onConnect?.(address, alpn);
        return tlsConnect({ host: "127.0.0.1", port: this.port, servername, ALPNProtocols: [alpn], ca: this.ca.certPem });
      },
    };
  }

  /** A phone: raw TCP to the relay port, TLS end to end with the PC. */
  phone(servername: string, alpn: string[] = ["h2", "http/1.1"], verifyPeer = true): TLSSocket {
    return tlsConnect({
      host: "127.0.0.1",
      port: this.port,
      servername,
      ALPNProtocols: alpn,
      ca: this.ca.certPem,
      rejectUnauthorized: verifyPeer,
    });
  }

  send(label: string, message: RelayMessage): void {
    this.controls.get(label)?.socket.write(encodeFrame(message));
  }

  dropControl(label: string): void {
    this.controls.get(label)?.socket.destroy();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private track<T extends Socket | TLSSocket>(socket: T): T {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  }

  private onRaw(socket: Socket): void {
    this.track(socket);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const info = parseClientHello(buf);
      if (info === "more") return;
      socket.off("data", onData);
      socket.pause();
      if (info === "invalid" || !info.sni) return socket.destroy();
      if (info.sni === this.relayHost) {
        this.relayTls.emit("connection", new SpliceStream(socket, buf));
        return;
      }
      const label = labelFromHost(info.sni, this.base);
      if (!label || !this.controls.has(label)) {
        this.record("phone:unrouted");
        return socket.destroy();
      }
      void this.splice(label, socket, buf);
    };
    socket.on("data", onData);
  }

  private async takeIdle(label: string): Promise<TLSSocket | null> {
    const ready = this.idle.get(label)?.shift();
    if (ready) return ready;
    this.send(label, { type: "want", n: 1 });
    this.record("want");
    await this.until(() => this.idleCount(label) > 0 || !this.controls.has(label));
    return this.idle.get(label)?.shift() ?? null;
  }

  private async splice(label: string, phone: Socket, hello: Buffer): Promise<void> {
    const data = await this.takeIdle(label);
    if (!data || phone.destroyed) {
      phone.destroy();
      return;
    }
    const go = encodeFrame({ type: "go", peer: this.peer });
    if (this.goMode === "coalesced") {
      data.write(Buffer.concat([go, hello]));
    } else {
      // Split the go frame itself and the ClientHello across separate records.
      const pieces = [go.subarray(0, 3), go.subarray(3), hello.subarray(0, 7), hello.subarray(7)];
      for (const piece of pieces) {
        data.write(piece);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    this.record("go");
    phone.on("data", (chunk: Buffer) => this.spliced.push(Buffer.from(chunk)));
    data.on("data", (chunk: Buffer) => this.spliced.push(Buffer.from(chunk)));
    phone.pipe(data);
    data.pipe(phone);
    phone.once("close", () => data.destroy());
    data.once("close", () => phone.destroy());
    phone.resume();
  }

  private onRelayTls(socket: TLSSocket): void {
    this.track(socket);
    if (socket.alpnProtocol === ALPN_CONTROL) return this.onControl(socket);
    if (socket.alpnProtocol === ALPN_DATA) return this.onData(socket);
    this.http.emit("connection", socket);
  }

  private onControl(socket: TLSSocket): void {
    this.record("control:open");
    const nonce = newNonce();
    const decoder = new FrameDecoder();
    let control: Control | null = null;
    socket.write(encodeFrame({ type: "hello", v: 1, nonce }));
    socket.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      for (let msg = safeNext(decoder); msg; msg = safeNext(decoder)) {
        if (msg === "error") return socket.destroy();
        if (msg.type === "auth") {
          this.record("control:auth");
          if (this.authMode === "close") return socket.destroy();
          if (this.authMode === "revoke") {
            socket.write(encodeFrame({ type: "notice", code: "revoked" }));
            return;
          }
          const ok = verifyAuth(msg.pk, nonce, msg.label, msg.sig) && verifyTicket(msg.ticket, this.operatorKey).ok;
          if (!ok) {
            this.record("control:bad-auth");
            return socket.destroy();
          }
          control = { label: msg.label, session: newNonce(), poolToken: newNonce(), socket };
          const old = this.controls.get(msg.label);
          this.controls.set(msg.label, control);
          if (old) old.socket.write(encodeFrame({ type: "notice", code: "superseded" }));
          const ready: ReadyMessage = { type: "ready", session: control.session, poolToken: control.poolToken, pool: this.pool };
          if (this.refreshTicket) ready.ticket = this.refreshTicket;
          socket.write(encodeFrame(ready));
          this.record("control:ready");
        } else if (msg.type === "ping") {
          this.record("ping");
          if (this.answerPings) socket.write(encodeFrame({ type: "pong" }));
        } else if (msg.type === "pong") {
          this.record("pong");
        }
      }
    });
    socket.once("close", () => {
      if (control && this.controls.get(control.label) === control) {
        this.controls.delete(control.label);
        for (const idle of this.idle.get(control.label) ?? []) idle.destroy();
        this.idle.delete(control.label);
      }
      this.record("control:close");
    });
  }

  private onData(socket: TLSSocket): void {
    const decoder = new FrameDecoder();
    const onData = (chunk: Buffer) => {
      decoder.push(chunk);
      const msg = safeNext(decoder);
      if (!msg) return;
      socket.off("data", onData);
      if (msg === "error" || msg.type !== "join") return socket.destroy();
      const control = [...this.controls.values()].find((c) => c.session === msg.session && c.poolToken === msg.poolToken);
      if (!control) {
        this.record("data:bad-join");
        return socket.destroy();
      }
      const list = this.idle.get(control.label) ?? [];
      list.push(socket);
      this.idle.set(control.label, list);
      socket.once("close", () => {
        const current = this.idle.get(control.label);
        if (current) this.idle.set(control.label, current.filter((s) => s !== socket));
        this.record("data:close");
      });
      this.record("data:join");
    };
    socket.on("data", onData);
  }

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method !== "POST" || req.url !== "/v1/enroll") {
        res.writeHead(404).end();
        return;
      }
      this.enrollBodies.push(body);
      this.record("enroll");
      if (this.enrollGate) await this.enrollGate;
      const answer = this.enrollAnswer ? this.enrollAnswer(body) : this.defaultEnroll(body);
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers }).end(answer.body);
    });
  }

  private defaultEnroll(body: string): EnrollAnswer {
    let parsed: { invite?: string; pk?: string; sig?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, body: JSON.stringify({ error: "bad-json" }) };
    }
    const { invite, pk, sig } = parsed;
    if (!invite || !pk || !sig) return { status: 400, body: JSON.stringify({ error: "missing-field" }) };
    if (!verifyInvite(invite, this.operatorKey).ok) return { status: 403, body: JSON.stringify({ error: "bad-invite" }) };
    const key = publicKeyFromRaw(pk);
    if (!key || !verify(null, enrollPayload(invite, pk), key, Buffer.from(sig, "base64url"))) {
      return { status: 403, body: JSON.stringify({ error: "bad-signature" }) };
    }
    rawPublicKey(key);
    return { status: 200, body: JSON.stringify({ ticket: this.ticketFor(pk) }) };
  }
}

function safeNext(decoder: FrameDecoder): RelayMessage | "error" | undefined {
  try {
    return decoder.next();
  } catch {
    return "error";
  }
}
