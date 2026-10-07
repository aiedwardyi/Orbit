import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CertManager, FALLBACK_AFTER_MS, RETRY_BASE_MS, STEP_TIMEOUT_MS, type AcmeAccountConfig, type ChallengeTarget } from "./acme.ts";
import { readCert, readKeyHistory, relayDir, spkiFingerprint, writeCert } from "./store.ts";
import { FakeAcme } from "./testing/fake-acme.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { tempDataDir } from "./testing/harness.ts";
import { listenLocal } from "./testing/net.ts";
import { TestCa, inspectChallengeCert, leafFingerprint, type KeyAndCert } from "./testing/pki.ts";

const HOST = "abcdefghijklmnop.wink.test";
const DAY = 24 * 60 * 60_000;

class Target implements ChallengeTarget {
  cert: KeyAndCert | null = null;
  challenge: KeyAndCert | null = null;
  readonly challenges: KeyAndCert[] = [];
  readonly installs: string[] = [];

  setCertificate(keyPem: string, certPem: string): void {
    this.cert = { keyPem, certPem };
    this.installs.push(leafFingerprint(certPem));
  }

  setChallenge(keyPem: string, certPem: string): void {
    this.challenge = { keyPem, certPem };
    this.challenges.push(this.challenge);
  }

  clearChallenge(): void {
    this.challenge = null;
  }
}

/** Validator for the fake CA that reads the target directly, recording what it saw. */
function directValidator(target: Target, seen: Array<{ keyAuthorization: string; ok: boolean }>) {
  return async (host: string, keyAuthorization: string) => {
    const current = target.challenge;
    let ok = false;
    if (current) {
      const info = inspectChallengeCert(current.certPem);
      const expected = Buffer.concat([Buffer.from([0x04, 0x20]), createHash("sha256").update(keyAuthorization).digest()]);
      ok = info.critical && info.otherNames === 0 && info.dnsNames.length === 1 && info.dnsNames[0] === host && info.value.equals(expected);
    }
    seen.push({ keyAuthorization, ok });
    return ok;
  };
}

describe("ACME certificate manager", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(options: { directories?: FakeAcme[]; accounts?: Record<string, AcmeAccountConfig>; clock?: FakeClock } = {}) {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const ca = await TestCa.create();
    const acmes = options.directories ?? [await FakeAcme.start({ ca })];
    for (const acme of acmes) cleanups.push(() => acme.close());
    const clock = options.clock ?? new FakeClock();
    const target = new Target();
    const events = new EventEmitter();
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: acmes.map((acme) => acme.directoryUrl),
      accounts: options.accounts ?? {},
      clock,
      target,
      onChange: () => events.emit("change"),
      allowInsecureDirectories: true,
    });
    cleanups.push(() => certs.stop());
    /** Resolves when the next issuance attempt has started and finished. */
    const settled = () =>
      new Promise<void>((resolve) => {
        let started = false;
        const check = () => {
          if (certs.snapshot().issuing) started = true;
          if (!started || certs.snapshot().issuing) return;
          events.off("change", check);
          resolve();
        };
        events.on("change", check);
      });
    return { dir, ca, acmes, clock, target, certs, events, settled };
  }

  it("issues through tls-alpn-01 with an RFC 8737 challenge certificate and cleans up", async () => {
    const { dir, acmes, target, certs, settled } = await setup();
    const seen: Array<{ keyAuthorization: string; ok: boolean }> = [];
    acmes[0].validator = directValidator(target, seen);
    certs.start();
    const done = settled();
    certs.setConnected(true);
    await done;

    expect(seen).toHaveLength(1);
    expect(seen[0].ok).toBe(true);
    const [challenge] = target.challenges;
    const info = inspectChallengeCert(challenge.certPem);
    expect(info.dnsNames).toEqual([HOST]);
    expect(info.otherNames).toBe(0);
    expect(info.critical).toBe(true);
    expect(info.value.subarray(0, 2)).toEqual(Buffer.from([0x04, 0x20]));
    expect(info.value.subarray(2)).toEqual(createHash("sha256").update(seen[0].keyAuthorization).digest());
    expect(new X509Certificate(challenge.certPem).checkPrivateKey(createPrivateKey(challenge.keyPem))).toBe(true);

    expect(acmes[0].log).toContain("challenge:tls-alpn-01");
    expect(acmes[0].log).not.toContain("challenge:http-01");
    expect(acmes[0].log).not.toContain("challenge:dns-01");
    expect(target.challenge).toBeNull();

    const stored = readCert(dir, HOST);
    expect(stored.kind).toBe("ok");
    if (stored.kind !== "ok") return;
    expect(target.cert?.certPem).toBe(stored.value.certPem);
    expect(readKeyHistory(dir)).toContain(spkiFingerprint(createPrivateKey(stored.value.keyPem)));
    expect(certs.snapshot()).toMatchObject({ valid: true, issuing: false, error: null, notAfter: stored.value.notAfter });
    if (process.platform !== "win32") {
      expect(statSync(relayDir(dir)).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(relayDir(dir))) expect(statSync(join(relayDir(dir), name)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the current certificate when renewal fails, then renews without a restart", async () => {
    const { dir, ca, acmes, clock, target, certs, settled } = await setup();
    acmes[0].validator = directValidator(target, []);
    const old = await ca.issue(HOST, { notBefore: new Date(clock.now() - 80 * DAY), notAfter: new Date(clock.now() + 10 * DAY) });
    writeCert(dir, old.keyPem, old.certPem);
    const oldFile = readFileSync(join(relayDir(dir), "cert.json"), "utf8");
    certs.start();
    expect(target.installs).toEqual([leafFingerprint(old.certPem)]);

    acmes[0].mode = "reject";
    let done = settled();
    certs.setConnected(true);
    await done;
    expect(certs.snapshot()).toMatchObject({ valid: true });
    expect(certs.snapshot().error).toContain("certificate request failed");
    expect(target.installs).toEqual([leafFingerprint(old.certPem)]);
    expect(readFileSync(join(relayDir(dir), "cert.json"), "utf8")).toBe(oldFile);
    expect(target.challenge).toBeNull();

    acmes[0].mode = "ok";
    clock.advance(RETRY_BASE_MS - 1);
    expect(acmes[0].log.filter((entry) => entry === "new-order")).toHaveLength(0);
    done = settled();
    clock.advance(1);
    await done;
    expect(certs.snapshot().error).toBeNull();
    expect(target.installs).toHaveLength(2);
    expect(target.installs[1]).not.toBe(target.installs[0]);
  });

  it("reports an invalid challenge and clears it", async () => {
    const { acmes, target, certs, settled } = await setup();
    acmes[0].validator = async () => false;
    certs.start();
    const done = settled();
    certs.setConnected(true);
    await done;
    expect(certs.snapshot()).toMatchObject({ valid: false, error: "certificate request failed: authorization invalid" });
    expect(target.challenges).toHaveLength(1);
    expect(target.challenge).toBeNull();
    expect(target.cert).toBeNull();
  });

  it("falls back to the next CA after three days, with separate account keys and EAB only where configured", async () => {
    const ca = await TestCa.create();
    const eab = { kid: "kid-123", hmacKey: Buffer.alloc(32, 9).toString("base64url") };
    const first = await FakeAcme.start({ ca });
    const second = await FakeAcme.start({ ca, eab });
    first.mode = "reject";
    const { dir, clock, target, certs, settled } = await setup({
      directories: [first, second],
      accounts: { [second.directoryUrl]: { eab, contact: ["mailto:ops@wink.test"] } },
    });
    second.validator = directValidator(target, []);
    certs.start();
    let done = settled();
    certs.setConnected(true);
    await done;
    const start = clock.now();
    while (clock.now() - start < FALLBACK_AFTER_MS + 13 * 60 * 60_000 && target.cert === null) {
      const next = clock.nextAt;
      if (next === null) break;
      done = settled();
      clock.advance(next - clock.now());
      await done;
    }
    expect(target.cert).not.toBeNull();
    expect(first.log.filter((entry) => entry === "error:rejectedIdentifier").length).toBeGreaterThanOrEqual(3);
    expect(second.log).toContain("issued");
    expect(first.eabSeen).toEqual([]);
    expect(second.eabSeen).toEqual(["kid-123"]);
    expect(first.accountKeys.size).toBe(1);
    expect(second.accountKeys.size).toBe(1);
    expect([...first.accountKeys][0]).not.toBe([...second.accountKeys][0]);
    expect(readdirSync(relayDir(dir)).filter((name) => name.startsWith("acme-account-"))).toHaveLength(2);
  });

  it("stop() during a renewal writes nothing and goes quiet", async () => {
    const { dir, acmes, clock, target, certs, events } = await setup();
    acmes[0].validator = directValidator(target, []);
    acmes[0].mode = "hold";
    const held = new Promise<void>((resolve) => (acmes[0].onHold = resolve));
    certs.start();
    certs.setConnected(true);
    await held;
    certs.stop();
    let changes = 0;
    events.on("change", () => changes++);
    acmes[0].release();
    await new Promise<void>((resolve) => {
      const check = () => (acmes[0].log.includes("issued") ? resolve() : setImmediate(check));
      check();
    });
    clock.advance(30 * DAY);
    expect(changes).toBe(0);
    expect(readCert(dir, HOST).kind).toBe("missing");
    expect(target.cert).toBeNull();
    expect(target.challenge).toBeNull();
    expect(clock.pending).toBe(0);
  });

  it("refuses a plain-http directory outside tests", async () => {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const target = new Target();
    const events = new EventEmitter();
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: ["http://127.0.0.1:9/directory"],
      accounts: {},
      clock: new FakeClock(),
      target,
      onChange: () => events.emit("change"),
    });
    cleanups.push(() => certs.stop());
    certs.start();
    const done = new Promise<void>((resolve) => events.on("change", () => certs.snapshot().error && resolve()));
    certs.setConnected(true);
    await done;
    expect(certs.snapshot().error).toBe("certificate request failed: ACME directory must be https");
  });
});

describe("ACME step deadline", () => {
  it("gives up on a CA that never answers and retries later", async () => {
    const { dir, cleanup } = tempDataDir();
    const silent = createServer(() => {});
    const port = await listenLocal(silent);
    const clock = new FakeClock();
    const events = new EventEmitter();
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: [`http://127.0.0.1:${port}/directory`],
      accounts: {},
      clock,
      target: new Target(),
      onChange: () => events.emit("change"),
      allowInsecureDirectories: true,
    });
    try {
      certs.start();
      const failed = new Promise<void>((resolve) => events.on("change", () => certs.snapshot().error && resolve()));
      certs.setConnected(true);
      await new Promise<void>((resolve) => silent.once("request", () => resolve()));
      clock.advance(STEP_TIMEOUT_MS);
      await failed;
      expect(certs.snapshot()).toMatchObject({ issuing: false, error: "certificate request failed: CA did not answer in time" });
      expect(clock.nextAt).toBe(clock.now() + RETRY_BASE_MS);
    } finally {
      certs.stop();
      silent.closeAllConnections();
      silent.close();
      cleanup();
    }
  });
});
