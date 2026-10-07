// Per-PC certificate for <label>.<base> via ACME TLS-ALPN-01 (design
// section 6). The CA reaches us through the relay like a phone does; the
// ingress hands acme-tls/1 connections the challenge certificate while one
// is active. The certificate key never leaves this PC. A failed renewal
// keeps the current certificate. Each CA directory has its own account key.

import { X509Certificate, createPrivateKey } from "node:crypto";

import acme from "acme-client";
import { z } from "zod";

import { CancelledError, sleep, type Cancel, type Clock } from "./clock.ts";
import {
  loadOrCreateAccountKey,
  newEcKeyPem,
  parseCertPair,
  readCert,
  rememberCertKey,
  spkiFingerprint,
  writeCert,
  type StoredCert,
} from "./store.ts";

export const DEFAULT_ACME_DIRECTORY = acme.directory.letsencrypt.production;
export const RENEW_CHECK_MS = 12 * 60 * 60_000;
export const RETRY_BASE_MS = 60 * 60_000;
export const RETRY_CAP_MS = 12 * 60 * 60_000;
export const FALLBACK_AFTER_MS = 3 * 24 * 60 * 60_000;
export const POLL_MS = 2_000;
export const MAX_POLLS = 30;
/** Per CA call; covers acme-client's own bounded 5xx/429 retries. */
export const STEP_TIMEOUT_MS = 120_000;

export interface AcmeExternalAccount {
  kid: string;
  /** base64url HMAC key from the CA. */
  hmacKey: string;
}

/** Optional per-directory account settings, only for CAs that require them. */
export interface AcmeAccountConfig {
  eab?: AcmeExternalAccount;
  /** e.g. ["mailto:ops@example.com"] */
  contact?: string[];
}

export interface ChallengeTarget {
  setCertificate(keyPem: string, certPem: string): void;
  setChallenge(keyPem: string, certPem: string): void;
  clearChallenge(): void;
}

export interface CertManagerOptions {
  dataDir: string;
  host: string;
  directories: string[];
  accounts: Record<string, AcmeAccountConfig>;
  clock: Clock;
  target: ChallengeTarget;
  onChange(): void;
  /** Tests only: allow a plain-http fake directory. */
  allowInsecureDirectories?: boolean;
  createClient?: (options: acme.ClientOptions) => acme.Client;
}

const tlsAlpnChallengeSchema = z.object({
  type: z.literal("tls-alpn-01"),
  url: z.string().min(1),
  token: z.string().regex(/^[A-Za-z0-9_-]+$/),
  status: z.string(),
});
type TlsAlpnChallenge = z.infer<typeof tlsAlpnChallengeSchema>;

/**
 * acme-client 5.4.0 handles tls-alpn-01 at runtime (getChallengeKeyAuthorization
 * returns token.thumbprint, completeChallenge posts to `url`), but its typings
 * list only http-01 and dns-01. Method parameters compare bivariantly, so the
 * client satisfies this view without an assertion.
 */
interface TlsAlpnClient {
  getChallengeKeyAuthorization(challenge: { type: string; url: string; token: string; status: string }): Promise<string>;
  completeChallenge(challenge: { type: string; url: string; token: string; status: string }): Promise<{ url: string }>;
}

export interface CertSnapshot {
  notAfter: number | null;
  valid: boolean;
  issuing: boolean;
  /** Last issuance failure, cleared by success. */
  error: string | null;
}

/** Checks the RFC 8737 challenge certificate before it is served. */
export function challengeCertProblem(certPem: string, host: string, keyAuthorization: string): string | null {
  try {
    const cert = new X509Certificate(certPem);
    if (cert.subjectAltName !== `DNS:${host}`) return "challenge certificate SAN is not exactly the host";
    if (!acme.crypto.isAlpnCertificateAuthorizationValid(certPem, keyAuthorization)) return "challenge digest mismatch";
    return null;
  } catch (cause) {
    return `challenge certificate unreadable: ${message(cause)}`;
  }
}

export class CertManager {
  private readonly opts: CertManagerOptions;
  private readonly clock: Clock;
  private readonly cancels = new Set<Cancel>();
  private cert: StoredCert | null = null;
  private issuing = false;
  private stopped = false;
  private connected = false;
  private error: string | null = null;
  private directoryIndex = 0;
  private failingSince: number | null = null;
  private failures = 0;
  private retryAt = 0;
  private timer: Cancel | null = null;

  constructor(options: CertManagerOptions) {
    this.opts = options;
    this.clock = options.clock;
  }

  snapshot(): CertSnapshot {
    const now = this.clock.now();
    return {
      notAfter: this.cert?.notAfter ?? null,
      valid: this.cert !== null && this.cert.notBefore <= now && now < this.cert.notAfter,
      issuing: this.issuing,
      error: this.error,
    };
  }

  /** Loads a stored certificate into the ingress. Reads files only. */
  start(): void {
    const stored = readCert(this.opts.dataDir, this.opts.host);
    if (stored.kind === "ok" && stored.value.notAfter > this.clock.now()) {
      this.cert = stored.value;
      this.opts.target.setCertificate(stored.value.keyPem, stored.value.certPem);
    } else if (stored.kind === "invalid") {
      this.error = stored.reason;
    }
    this.scheduleCheck(RENEW_CHECK_MS);
  }

  /** The relay connection is up (true) or down. Issuance needs it for the challenge. */
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected) this.maybeIssue();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.timer?.();
    this.timer = null;
    for (const cancel of this.cancels) cancel();
    this.opts.target.clearChallenge();
  }

  private due(): boolean {
    const cert = this.cert;
    if (!cert) return true;
    // Renew with a third of the lifetime left.
    return this.clock.now() >= cert.notAfter - (cert.notAfter - cert.notBefore) / 3;
  }

  private scheduleCheck(ms: number): void {
    this.timer?.();
    this.timer = this.clock.schedule(ms, () => {
      this.timer = null;
      if (this.stopped) return;
      this.opts.onChange();
      this.maybeIssue();
      if (!this.timer) this.scheduleCheck(RENEW_CHECK_MS);
    });
  }

  private maybeIssue(): void {
    if (this.stopped || this.issuing || !this.connected || !this.due()) return;
    if (this.clock.now() < this.retryAt) return;
    void this.issue();
  }

  private async issue(): Promise<void> {
    this.issuing = true;
    this.opts.onChange();
    const directories = this.opts.directories.length > 0 ? this.opts.directories : [DEFAULT_ACME_DIRECTORY];
    const directory = directories[this.directoryIndex % directories.length];
    try {
      await this.order(directory);
      this.error = null;
      this.failingSince = null;
      this.failures = 0;
      this.retryAt = 0;
    } catch (cause) {
      if (cause instanceof CancelledError || this.stopped) return;
      const now = this.clock.now();
      this.error = `certificate request failed: ${message(cause)}`;
      this.failingSince ??= now;
      if (now - this.failingSince >= FALLBACK_AFTER_MS && directories.length > 1) {
        this.directoryIndex = (this.directoryIndex + 1) % directories.length;
        this.failingSince = now;
        this.failures = 0;
      }
      const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(this.failures, 10));
      this.failures++;
      this.retryAt = now + delay;
      this.scheduleCheck(delay);
    } finally {
      if (!this.stopped) {
        this.opts.target.clearChallenge();
        this.issuing = false;
        this.opts.onChange();
      }
    }
  }

  /** Awaits `work` with a deadline, then refuses to continue if stop() ran meanwhile. */
  private async step<T>(work: Promise<T>): Promise<T> {
    let cancel: Cancel = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      cancel = this.clock.schedule(STEP_TIMEOUT_MS, () => reject(new Error("CA did not answer in time")));
    });
    this.cancels.add(cancel);
    let value: T;
    try {
      value = await Promise.race([work, deadline]);
    } finally {
      cancel();
      this.cancels.delete(cancel);
    }
    if (this.stopped) throw new CancelledError();
    return value;
  }

  private async order(directoryUrl: string): Promise<void> {
    const { dataDir, host } = this.opts;
    const url = new URL(directoryUrl);
    if (url.protocol !== "https:" && !this.opts.allowInsecureDirectories) throw new Error("ACME directory must be https");
    const account = this.opts.accounts[directoryUrl];
    const create = this.opts.createClient ?? ((options: acme.ClientOptions) => new acme.Client(options));
    const client = create({
      directoryUrl,
      accountKey: loadOrCreateAccountKey(dataDir, directoryUrl),
      externalAccountBinding: account?.eab,
      backoffAttempts: 3,
      backoffMin: 1_000,
      backoffMax: 5_000,
    });
    await this.step(client.createAccount({ termsOfServiceAgreed: true, contact: account?.contact }));
    const order = await this.step(client.createOrder({ identifiers: [{ type: "dns", value: host }] }));
    const authzs = await this.step(client.getAuthorizations(order));
    if (authzs.length !== 1 || authzs[0].identifier.type !== "dns" || authzs[0].identifier.value !== host) {
      throw new Error("CA returned unexpected authorizations");
    }
    const authz = authzs[0];
    if (authz.status !== "valid") {
      let challenge: TlsAlpnChallenge | null = null;
      for (const candidate of authz.challenges) {
        const parsed = tlsAlpnChallengeSchema.safeParse(candidate);
        if (parsed.success) challenge = parsed.data;
      }
      if (!challenge) throw new Error("CA offered no tls-alpn-01 challenge");
      const alpnClient: TlsAlpnClient = client;
      const keyAuthorization = await this.step(alpnClient.getChallengeKeyAuthorization(challenge));
      const [challengeKey, challengeCert] = await this.step(
        acme.crypto.createAlpnCertificate(authz, keyAuthorization, newEcKeyPem()),
      );
      const problem = challengeCertProblem(challengeCert.toString(), host, keyAuthorization);
      if (problem) throw new Error(problem);
      this.opts.target.setChallenge(challengeKey.toString(), challengeCert.toString());
      await this.step(alpnClient.completeChallenge(challenge));
      await this.poll(async () => {
        const [latest] = await client.getAuthorizations(order);
        return latest?.status ?? "invalid";
      }, "authorization");
      this.opts.target.clearChallenge();
    }
    const keyPem = newEcKeyPem();
    rememberCertKey(dataDir, spkiFingerprint(createPrivateKey(keyPem)));
    const [, csr] = await this.step(acme.crypto.createCsr({ commonName: host, altNames: [host] }, keyPem));
    let finalized = await this.step(client.finalizeOrder(order, csr));
    if (finalized.status !== "valid") {
      await this.poll(async () => {
        finalized = await client.getOrder(finalized);
        return finalized.status;
      }, "order");
    }
    const chain = await this.step(client.getCertificate(finalized));
    const cert = parseCertPair(keyPem, chain, host);
    if (!cert) throw new Error("CA returned a certificate that does not match the request");
    if (this.stopped) throw new CancelledError();
    writeCert(dataDir, keyPem, chain);
    this.cert = cert;
    this.opts.target.setCertificate(keyPem, chain);
  }

  private async poll(read: () => Promise<string>, what: string): Promise<void> {
    for (let i = 0; i < MAX_POLLS; i++) {
      const status = await this.step(read());
      if (status === "valid") return;
      if (status === "invalid" || status === "deactivated" || status === "expired" || status === "revoked") {
        throw new Error(`${what} ${status}`);
      }
      await sleep(this.clock, POLL_MS, this.cancels);
      if (this.stopped) throw new CancelledError();
    }
    throw new Error(`${what} still pending after ${MAX_POLLS} checks`);
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
