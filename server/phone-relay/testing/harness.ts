// Shared setup for relay tests: temp data dir, test CA, fake relay, fake ACME,
// an enrolled identity and helpers to talk HTTP through the relay as a phone.

import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";

import { hostFor, mintInvite, type PhoneRelayStatus } from "../../../shared/relay-protocol.ts";
import { enrollWith } from "../enroll.ts";
import type { PhoneRelayConfig } from "../index.ts";
import { readIdentity, type Identity } from "../store.ts";
import { FakeAcme } from "./fake-acme.ts";
import { FakeRelay, loopbackLookup } from "./fake-relay.ts";
import { TestCa, inspectChallengeCert } from "./pki.ts";

export const BASE = "wink.test";

export interface TempDir {
  dir: string;
  cleanup: () => void;
}

export function tempDataDir(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), "wink-relay-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface Rig {
  dataDir: string;
  ca: TestCa;
  relay: FakeRelay;
  acme: FakeAcme;
  identity: Identity;
  host: string;
  config: PhoneRelayConfig;
  close(): Promise<void>;
}

export async function enroll(dataDir: string, relay: FakeRelay, config: PhoneRelayConfig): Promise<void> {
  await enrollWith(
    { dataDir, config, invite: mintInvite(relay.operatorKey) },
    { https: { ca: relay.ca.certPem, port: relay.port, lookup: loopbackLookup }, env: {} },
  );
}

export async function rig(options: { enroll?: boolean } = {}): Promise<Rig> {
  const { dir, cleanup } = tempDataDir();
  const ca = await TestCa.create();
  const relay = await FakeRelay.start(BASE, ca);
  const acme = await FakeAcme.start({ ca });
  acme.validator = (host, keyAuthorization) => validateThroughRelay(relay, host, keyAuthorization);
  const config: PhoneRelayConfig = { base: BASE, enabled: true, acmeDirectories: [acme.directoryUrl] };
  if (options.enroll !== false) await enroll(dir, relay, config);
  const loaded = readIdentity(dir);
  const identity = loaded.kind === "ok" ? loaded.value : null;
  return {
    dataDir: dir,
    ca,
    relay,
    acme,
    // SAFETY: tests that skip enrollment never read identity or host.
    identity: identity as Identity,
    host: identity ? hostFor(identity.label, BASE) : "",
    config,
    async close() {
      await relay.close();
      await acme.close();
      cleanup();
    },
  };
}

/** What a CA does for TLS-ALPN-01: connect with acme-tls/1 and read the certificate. */
export async function validateThroughRelay(relay: FakeRelay, host: string, keyAuthorization: string): Promise<boolean> {
  const socket = relay.phone(host, ["acme-tls/1"], false);
  try {
    await once(socket, "secureConnect");
    const cert = socket.getPeerX509Certificate();
    if (!cert || socket.alpnProtocol !== "acme-tls/1") return false;
    const info = inspectChallengeCert(cert.toString());
    const digest = createHash("sha256").update(keyAuthorization).digest();
    const expected = Buffer.concat([Buffer.from([0x04, 0x20]), digest]);
    return info.critical && info.otherNames === 0 && info.dnsNames.length === 1 && info.dnsNames[0] === host && info.value.equals(expected);
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

export class StatusLog extends EventEmitter {
  readonly all: PhoneRelayStatus[] = [];

  push = (status: PhoneRelayStatus): void => {
    this.all.push(status);
    this.emit("status", status);
  };

  get last(): PhoneRelayStatus | undefined {
    return this.all.at(-1);
  }

  until(check: (status: PhoneRelayStatus) => boolean): Promise<PhoneRelayStatus> {
    const hit = this.all.find(check);
    if (hit) return Promise.resolve(hit);
    return this.next(check);
  }

  /** Like until(), but only for statuses reported from now on. */
  next(check: (status: PhoneRelayStatus) => boolean): Promise<PhoneRelayStatus> {
    return new Promise((resolve) => {
      const listener = (status: PhoneRelayStatus) => {
        if (!check(status)) return;
        this.off("status", listener);
        resolve(status);
      };
      this.on("status", listener);
    });
  }
}

export interface PhoneResponse {
  status: number;
  body: string;
  socket: TLSSocket;
}

/** One HTTP/1.1 request from a phone, TLS end to end with the PC through the relay. */
export function phoneRequest(
  relay: FakeRelay,
  host: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; alpn?: string[] } = {},
): Promise<PhoneResponse> {
  return new Promise((resolve, reject) => {
    const socket = relay.phone(host, init.alpn);
    socket.on("error", reject);
    const req = request(
      { method: init.method ?? "GET", host, path, headers: { host, ...init.headers }, createConnection: () => socket },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), socket }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

/** Starts a request and hands back the response without reading it. */
export function phoneStream(relay: FakeRelay, host: string, path: string): Promise<{ res: IncomingMessage; socket: TLSSocket }> {
  return new Promise((resolve, reject) => {
    const socket = relay.phone(host);
    socket.on("error", reject);
    const req = request({ host, path, headers: { host }, createConnection: () => socket }, (res) => resolve({ res, socket }));
    req.on("error", reject);
    req.end();
  });
}
