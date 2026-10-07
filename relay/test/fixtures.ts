// Test-only certificates, keys, a relay on loopback and a fake PC / phone.
// Nothing here talks to a real CA or the network beyond 127.0.0.1.

import * as x509 from "@peculiar/x509";
import { generateKeyPairSync, webcrypto, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import {
  ALPN_CONTROL,
  ALPN_DATA,
  FrameDecoder,
  encodeFrame,
  labelForPublicKey,
  rawPublicKey,
  signAuth,
  signTicket,
  type ReadyMessage,
  type RelayMessage,
} from "../../shared/relay-protocol.ts";
import { createLogger } from "../src/log.ts";
import { createRelay, type Relay, type RelayOptions } from "../src/relay.ts";

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

const EC = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

export interface Ca {
  certPem: string;
  issue(host: string): Promise<{ key: string; cert: string }>;
  signCsr(csrPem: string): Promise<string>;
}

async function exportKey(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", key));
  return `-----BEGIN PRIVATE KEY-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
}

/** A throwaway CA. Certificates live one day. */
export async function makeCa(): Promise<Ca> {
  const keys = (await webcrypto.subtle.generateKey(EC, true, ["sign", "verify"])) as CryptoKeyPair;
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 24 * 3600_000);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=wink relay test CA",
    notBefore,
    notAfter,
    keys,
    signingAlgorithm: EC,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
    ],
  });
  let serial = 2;
  const leaf = async (host: string, publicKey: CryptoKey | x509.PublicKey) =>
    x509.X509CertificateGenerator.create({
      serialNumber: (serial++).toString(16).padStart(2, "0"),
      subject: `CN=${host}`,
      issuer: ca.subject,
      notBefore,
      notAfter,
      signingAlgorithm: EC,
      publicKey,
      signingKey: keys.privateKey,
      extensions: [
        new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }]),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      ],
    });
  return {
    certPem: ca.toString("pem"),
    async issue(host) {
      const pair = (await webcrypto.subtle.generateKey(EC, true, ["sign", "verify"])) as CryptoKeyPair;
      const cert = await leaf(host, pair.publicKey);
      return { key: await exportKey(pair.privateKey), cert: cert.toString("pem") };
    },
    async signCsr(csrPem) {
      const csr = new x509.Pkcs10CertificateRequest(csrPem);
      const cert = await leaf(csr.subject.replace(/^CN=/, ""), csr.publicKey);
      return `${cert.toString("pem")}\n${ca.toString("pem")}`;
    },
  };
}

export interface Pc {
  privateKey: KeyObject;
  pk: string;
  label: string;
}

export function makePc(): Pc {
  const { privateKey } = generateKeyPairSync("ed25519");
  const raw = rawPublicKey(privateKey);
  return { privateKey, pk: raw.toString("base64url"), label: labelForPublicKey(raw) };
}

export function makeOperator(): KeyObject {
  return generateKeyPairSync("ed25519").privateKey;
}

export function ticketFor(pc: Pc, operator: KeyObject, opts: { iat?: number; exp?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signTicket({ label: pc.label, pk: pc.pk, iat: opts.iat ?? now, exp: opts.exp ?? now + 365 * 86400 }, operator);
}

export const BASE = "relay-test.example";

export interface Harness {
  relay: Relay;
  port: number;
  base: string;
  ca: Ca;
  operator: KeyObject;
  dataDir: string;
  logs: string[];
  /** Resolves once `count` log entries match. Event driven, no polling. */
  waitLog(match: (entry: Record<string, unknown>) => boolean, count?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startRelay(overrides: Partial<RelayOptions> = {}, ca?: Ca): Promise<Harness> {
  const authority = ca ?? (await makeCa());
  const dataDir = await mkdtemp(join(tmpdir(), "wink-relay-test-"));
  const operator = overrides.operatorPrivateKey ?? makeOperator();
  const logs: string[] = [];
  const listeners = new Set<() => void>();
  const relay = await createRelay({
    base: BASE,
    operatorPrivateKey: operator,
    dataDir,
    certificate: overrides.acme ? undefined : await authority.issue(`relay.${BASE}`),
    log: createLogger((line) => {
      logs.push(line);
      for (const l of [...listeners]) l();
    }),
    ...overrides,
  });
  const { port } = await relay.listen(0, "127.0.0.1");
  return {
    relay,
    port,
    base: BASE,
    ca: authority,
    operator,
    dataDir,
    logs,
    waitLog(match, count = 1) {
      return new Promise((resolve) => {
        const check = () => {
          if (logs.filter((line) => match(JSON.parse(line))).length >= count) {
            listeners.delete(check);
            resolve();
          }
        };
        listeners.add(check);
        check();
      });
    },
    async close() {
      await relay.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Reads frames from a socket in order. */
export class FrameReader {
  private readonly decoder = new FrameDecoder();
  private readonly queue: RelayMessage[] = [];
  private waiters: Array<(m: RelayMessage | null) => void> = [];
  private ended = false;
  readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", this.onData);
    socket.once("close", () => {
      this.ended = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
  }

  private readonly onData = (chunk: Buffer) => {
    this.decoder.push(chunk);
    for (let m = this.decoder.next(); m; m = this.decoder.next()) {
      // Raw bytes follow `go`; stop framing so detach() can hand them out.
      if (m.type === "go") {
        this.socket.off("data", this.onData);
        this.socket.pause();
      }
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
      if (m.type === "go") return;
    }
  };

  /** Next frame, or null once the socket closed. */
  next(): Promise<RelayMessage | null> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Stops framing and returns the bytes buffered behind the last frame. */
  detach(): Buffer {
    this.socket.off("data", this.onData);
    return this.decoder.rest();
  }
}

export function connectRelay(h: Harness, alpn: string, servername = `relay.${h.base}`): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port: h.port, servername, ca: h.ca.certPem, ALPNProtocols: [alpn] });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function closed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
    socket.on("error", () => {});
  });
}

export interface Control {
  socket: TLSSocket;
  reader: FrameReader;
  ready: ReadyMessage;
}

/** Opens a control channel and authenticates. Rejects with the first non-ready frame or close. */
export async function openControl(
  h: Harness,
  pc: Pc,
  opts: { ticket?: string; label?: string; pk?: string; sign?: (nonce: string) => string } = {},
): Promise<Control> {
  const socket = await connectRelay(h, ALPN_CONTROL);
  socket.on("error", () => {});
  const reader = new FrameReader(socket);
  const hello = await reader.next();
  if (hello?.type !== "hello") throw new Error("no hello");
  const label = opts.label ?? pc.label;
  socket.write(
    encodeFrame({
      type: "auth",
      label,
      pk: opts.pk ?? pc.pk,
      ticket: opts.ticket ?? ticketFor(pc, h.operator),
      sig: opts.sign ? opts.sign(hello.nonce) : signAuth(pc.privateKey, hello.nonce, label),
    }),
  );
  const ready = await reader.next();
  if (ready?.type !== "ready") {
    const error = new Error(ready ? `got ${ready.type}` : "closed") as Error & { frame?: RelayMessage | null };
    error.frame = ready;
    throw error;
  }
  return { socket, reader, ready };
}

/** Opens a data channel and sends `join`. */
export async function openData(h: Harness, session: string, poolToken: string): Promise<TLSSocket> {
  const socket = await connectRelay(h, ALPN_DATA);
  socket.on("error", () => {});
  socket.write(encodeFrame({ type: "join", session, poolToken }));
  return socket;
}

export const event =
  (name: string, fields: Record<string, unknown> = {}) =>
  (entry: Record<string, unknown>) =>
    entry.event === name && Object.entries(fields).every(([k, v]) => entry[k] === v);

/** Raw TCP to the relay port. */
export function rawConnect(h: Harness): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port: h.port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Captures the exact ClientHello bytes a Node TLS client sends for `servername`. */
export async function captureClientHello(servername: string | null, alpn = ["http/1.1"]): Promise<Buffer> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => {
      sock.once("data", (chunk) => {
        resolve(chunk);
        sock.destroy();
        server.close();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const c = tlsConnect({
        host: "127.0.0.1",
        port,
        ...(servername ? { servername } : {}),
        ALPNProtocols: alpn,
        rejectUnauthorized: false,
      });
      c.on("error", () => {});
    });
    server.on("error", reject);
  });
}

export function readAll(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", () => {});
    socket.once("close", () => resolve(Buffer.concat(chunks)));
  });
}
