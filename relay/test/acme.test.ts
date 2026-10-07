import * as acme from "acme-client";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import type { AcmeClientLike } from "../src/acme.ts";
import {
  BASE,
  closed,
  connectRelay,
  event,
  makeCa,
  makeOperator,
  makePc,
  openControl,
  rawConnect,
  readAll,
  startRelay,
  captureClientHello,
  type Ca,
  type Harness,
} from "./fixtures.ts";

const HOST = `relay.${BASE}`;
let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Fetches the certificate the relay presents for ALPN acme-tls/1, as a CA validator would. */
function fetchAlpnCert(port: number, servername = HOST): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: "127.0.0.1", port, servername, ALPNProtocols: ["acme-tls/1"], rejectUnauthorized: false },
      () => {
        resolve(socket.getPeerX509Certificate()!.toString());
        socket.destroy();
      },
    );
    socket.once("error", reject);
  });
}

interface FakeCa {
  createClient: (opts: { directoryUrl: string; accountKey: Buffer }) => AcmeClientLike;
  orders: number;
  validated: boolean[];
  port: (p: number) => void;
  identifier?: string;
}

/** A stand-in ACME server: drives the challenge callbacks, validates over TLS-ALPN-01, signs the CSR. */
function fakeCa(ca: Ca): FakeCa {
  let setPort: (p: number) => void = () => {};
  const port = new Promise<number>((resolve) => (setPort = resolve));
  const fake: FakeCa = {
    orders: 0,
    validated: [],
    port: (p) => setPort(p),
    createClient: () => ({
      async auto(opts) {
        fake.orders += 1;
        expect(opts.challengePriority).toEqual(["tls-alpn-01"]);
        const value = fake.identifier ?? HOST;
        const authz = {
          identifier: { type: "dns", value },
          status: "pending",
          expires: "",
          challenges: [],
          url: "https://ca.invalid/authz/1",
        } as unknown as acme.Authorization;
        const challenge = { type: "tls-alpn-01", url: "https://ca.invalid/chall/1", status: "pending", token: "tok" };
        const keyAuthorization = `tok.thumbprint-${fake.orders}`;
        await opts.challengeCreateFn(authz, challenge as never, keyAuthorization);
        const presented = await fetchAlpnCert(await port);
        fake.validated.push(acme.crypto.isAlpnCertificateAuthorizationValid(presented, keyAuthorization));
        await opts.challengeRemoveFn(authz, challenge as never, keyAuthorization);
        return ca.signCsr(opts.csr.toString());
      },
    }),
  };
  return fake;
}

describe("relay certificate via ACME TLS-ALPN-01", () => {
  it("gets a first certificate with none on disk, serves the challenge, then serves relay traffic", async () => {
    const ca = await makeCa();
    const fake = fakeCa(ca);
    const dataDir = await mkdtemp(join(tmpdir(), "wink-acme-"));
    dirs.push(dataDir);
    const operator = makeOperator();
    const acmeOpts = {
      directoryUrl: "https://ca.invalid/directory",
      termsOfServiceAgreed: true,
      createClient: fake.createClient,
    };
    h = await startRelay({ dataDir, operatorPrivateKey: operator, acme: acmeOpts }, ca);
    // Before issuance there is no certificate: relay.<base> fails closed with an alert.
    const early = await rawConnect(h);
    const earlyBytes = readAll(early);
    early.write(await captureClientHello(HOST, ["wink-ctl/1"]));
    expect((await earlyBytes).equals(Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 80]))).toBe(true);

    fake.port(h.port);
    await h.waitLog(event("cert-installed"));
    expect(fake.orders).toBe(1);
    expect(fake.validated).toEqual([true]);

    // Real TLS to relay.<base> now validates against the CA.
    const ctl = await openControl(h, makePc());
    ctl.socket.destroy();
    // The challenge is gone: acme-tls/1 is refused again.
    await expect(fetchAlpnCert(h.port)).rejects.toThrow();
    // Windows has no POSIX mode bits; the files still exist there.
    for (const file of ["account.key", "cert.key", "cert.pem"]) {
      const { mode } = await stat(join(dataDir, "acme", file));
      if (process.platform !== "win32") expect(mode & 0o077).toBe(0);
    }
    expect(h.relay.certManager!.notAfter).toBeGreaterThan(Date.now());

    // A restart reuses the stored certificate without a new order.
    await h.relay.close();
    h = undefined;
    const again = fakeCa(ca);
    h = await startRelay({ dataDir, operatorPrivateKey: operator, acme: { ...acmeOpts, createClient: again.createClient } }, ca);
    await h.waitLog(event("cert-installed"));
    const socket = await connectRelay(h, "wink-ctl/1");
    socket.destroy();
    expect(again.orders).toBe(0);
  });

  it("renews once a third of the lifetime is left", async () => {
    const ca = await makeCa();
    const fake = fakeCa(ca);
    let now = Date.now();
    h = await startRelay(
      {
        now: () => now,
        acme: { directoryUrl: "https://ca.invalid/d", termsOfServiceAgreed: true, createClient: fake.createClient },
      },
      ca,
    );
    fake.port(h.port);
    await h.waitLog(event("cert-installed"));
    const manager = h.relay.certManager!;
    // Let the startup check settle before driving the next one.
    await manager.check();
    expect(fake.orders).toBe(1);
    expect(manager.needsRenewal()).toBe(false);
    now = manager.notAfter! - 60_000;
    expect(manager.needsRenewal()).toBe(true);
    await manager.check();
    expect(fake.orders).toBe(2);
    await h.waitLog(event("cert-installed"), 2);
  });

  it("refuses to answer a challenge for any name but relay.<base>", async () => {
    const ca = await makeCa();
    const fake = fakeCa(ca);
    fake.identifier = `${makePc().label}.${BASE}`;
    h = await startRelay(
      { acme: { directoryUrl: "https://ca.invalid/d", termsOfServiceAgreed: true, createClient: fake.createClient } },
      ca,
    );
    fake.port(h.port);
    await h.waitLog(event("cert-error"));
    expect(h.relay.certManager!.notAfter).toBeNull();
    const probe = await rawConnect(h);
    probe.write(await captureClientHello(HOST, ["acme-tls/1"]));
    await closed(probe);
  });
});
