// Per-PC certificate for <label>.<base> via ACME TLS-ALPN-01 (design
// section 6). The CA reaches us through the relay like a phone does; the
// ingress hands acme-tls/1 connections the challenge certificate while one
// is active. The certificate key never leaves this PC. A failed renewal
// keeps the current certificate. Each CA directory has its own account key.

import { AsyncLocalStorage } from "node:async_hooks";
import { X509Certificate, createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

import * as x509 from "@peculiar/x509";
import acme from "acme-client";
import { z } from "zod";

import { CancelledError, sleep, type Cancel, type Clock } from "./clock.ts";
import {
  loadOrCreateAccountKey,
  newEcKeyPem,
  parseCertPair,
  readAcmeState,
  readCert,
  readKeyHistory,
  rememberCertKey,
  spkiFingerprint,
  writeAcmeState,
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
/** Per HTTP request to a CA. */
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * acme-client 5.4.0 sends everything through one shared axios instance with no
 * timeout, no size cap, redirects on and its own Retry-After waits that nothing
 * can cancel. Bound it here; our own backoff handles retries. Each request picks
 * up the agents and abort signal of the CertManager it runs for, so stop() can
 * end it.
 */
interface RequestScope {
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
  signal: AbortSignal;
}
const requestScope = new AsyncLocalStorage<RequestScope>();
acme.axios.defaults.timeout = REQUEST_TIMEOUT_MS;
acme.axios.defaults.maxContentLength = MAX_RESPONSE_BYTES;
acme.axios.defaults.maxBodyLength = MAX_RESPONSE_BYTES;
acme.axios.defaults.maxRedirects = 0;
// acme-client's untyped settings, as 5.4.0 ships them except for no retries.
Object.assign(acme.axios.defaults, {
  acmeSettings: { httpChallengePort: 80, httpsChallengePort: 443, tlsAlpnChallengePort: 443, retryMaxAttempts: 0, retryDefaultDelay: 5 },
});
acme.axios.interceptors.request.use((config) => {
  const scope = requestScope.getStore();
  if (scope) {
    if (scope.signal.aborted) throw new CancelledError();
    config.httpAgent = scope.httpAgent;
    config.httpsAgent = scope.httpsAgent;
    config.signal = scope.signal;
  }
  return config;
});

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

x509.cryptoProvider.set(crypto);
const CHALLENGE_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
/** Challenge certificate validity on each side of now, for CA clock skew. */
const CHALLENGE_VALIDITY_MS = 60 * 60_000;

/** RFC 8737 challenge certificate. Not acme-client's: Electron's BoringSSL refuses its CA-only key usage. */
async function createChallengeCert(host: string, keyAuthorization: string, now: number): Promise<{ keyPem: string; certPem: string }> {
  const keyPem = newEcKeyPem();
  const privateKey = createPrivateKey(keyPem);
  const digest = createHash("sha256").update(keyAuthorization).digest();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: `CN=${host}`,
    notBefore: new Date(now - CHALLENGE_VALIDITY_MS),
    notAfter: new Date(now + CHALLENGE_VALIDITY_MS),
    keys: {
      privateKey: await crypto.subtle.importKey("pkcs8", privateKey.export({ format: "der", type: "pkcs8" }), CHALLENGE_ALG, false, ["sign"]),
      publicKey: await crypto.subtle.importKey("spki", createPublicKey(privateKey).export({ format: "der", type: "spki" }), CHALLENGE_ALG, true, ["verify"]),
    },
    signingAlgorithm: CHALLENGE_ALG,
    extensions: [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }]),
      // id-pe-acmeIdentifier: the digest as a DER OCTET STRING.
      new x509.Extension("1.3.6.1.5.5.7.1.31", true, Buffer.concat([Buffer.from([0x04, 0x20]), digest])),
    ],
  });
  return { keyPem, certPem: cert.toString("pem") };
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

interface Der {
  tag: number;
  start: number;
  end: number;
}

/** One DER element at `offset` within `limit`, or null when it does not fit. */
function derAt(buf: Buffer, offset: number, limit: number): Der | null {
  if (offset + 2 > limit) return null;
  const tag = buf[offset];
  let length = buf[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count < 1 || count > 4 || start + count > limit) return null;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[start + i];
    start += count;
  }
  const end = start + length;
  return end <= limit ? { tag, start, end } : null;
}

function derChildren(buf: Buffer, parent: Der): Der[] {
  const children: Der[] = [];
  for (let offset = parent.start; offset < parent.end; ) {
    const child = derAt(buf, offset, parent.end);
    if (!child) return [];
    children.push(child);
    offset = child.end;
  }
  return children;
}

const AKI_OID = Buffer.from([0x55, 0x1d, 0x23]);

/** RFC 9773 certID: base64url(AKI keyIdentifier) "." base64url(serial DER content), or null without an AKI. */
export function ariCertId(certPem: string): string | null {
  try {
    const raw = new X509Certificate(certPem).raw;
    const cert = derAt(raw, 0, raw.length);
    const tbs = cert && derChildren(raw, cert)[0];
    if (!tbs) return null;
    const fields = derChildren(raw, tbs);
    const serial = fields.find((field) => field.tag === 0x02);
    const extensions = fields.find((field) => field.tag === 0xa3);
    if (!serial || !extensions) return null;
    const list = derChildren(raw, extensions)[0];
    for (const extension of list ? derChildren(raw, list) : []) {
      const parts = derChildren(raw, extension);
      if (parts[0]?.tag !== 0x06 || !raw.subarray(parts[0].start, parts[0].end).equals(AKI_OID)) continue;
      const value = parts.at(-1);
      const aki = value?.tag === 0x04 ? derAt(raw, value.start, value.end) : null;
      const keyId = aki ? derChildren(raw, aki).find((part) => part.tag === 0x80) : undefined;
      if (!keyId || keyId.end === keyId.start) return null;
      const id = raw.subarray(keyId.start, keyId.end).toString("base64url");
      return `${id}.${raw.subarray(serial.start, serial.end).toString("base64url")}`;
    }
    return null;
  } catch {
    return null;
  }
}

const directorySchema = z.object({ renewalInfo: z.string().optional() });
const renewalInfoSchema = z.object({ suggestedWindow: z.object({ start: z.string(), end: z.string() }) });

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
  /** When the CA's ARI window says to renew, if it said. */
  private renewAt: number | null = null;
  private checkingRenewalInfo = false;
  private readonly abort = new AbortController();
  private readonly requests: RequestScope;

  constructor(options: CertManagerOptions) {
    this.opts = options;
    this.clock = options.clock;
    this.requests = {
      httpAgent: new HttpAgent({ keepAlive: false }),
      httpsAgent: new HttpsAgent({ keepAlive: false }),
      signal: this.abort.signal,
    };
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
    const state = readAcmeState(this.opts.dataDir);
    if (state.kind === "ok") {
      this.directoryIndex = state.value.directoryIndex;
      this.failingSince = state.value.failingSince;
      this.failures = state.value.failures;
    } else if (state.kind === "invalid") {
      // Logged, not this.error: Settings reads that as a failed renewal, and fresh retry state is safe.
      console.warn(`phone relay: ACME retry state not loaded (${state.reason})`);
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
    this.abort.abort();
    this.requests.httpAgent.destroy();
    this.requests.httpsAgent.destroy();
    this.opts.target.clearChallenge();
  }

  private due(): boolean {
    const cert = this.cert;
    if (!cert) return true;
    if (this.renewAt !== null && this.clock.now() >= this.renewAt) return true;
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
      void this.checkRenewalInfo();
      if (!this.timer) this.scheduleCheck(RENEW_CHECK_MS);
    });
  }

  private maybeIssue(): void {
    if (this.stopped || this.issuing || !this.connected || !this.due()) return;
    if (this.clock.now() < this.retryAt) return;
    void this.issue();
  }

  private directories(): string[] {
    return this.opts.directories.length > 0 ? this.opts.directories : [DEFAULT_ACME_DIRECTORY];
  }

  private saveState(): void {
    try {
      writeAcmeState(this.opts.dataDir, {
        directoryIndex: this.directoryIndex,
        failingSince: this.failingSince,
        failures: this.failures,
      });
    } catch {
      /* the in-memory state still applies until restart */
    }
  }

  /** RFC 9773 ARI: asks the CA when to renew, and renews early inside its window. */
  private async checkRenewalInfo(): Promise<void> {
    const cert = this.cert;
    if (!cert || this.checkingRenewalInfo || this.issuing || this.due()) return;
    const certId = ariCertId(cert.certPem);
    if (!certId) return;
    const directories = this.directories();
    const directoryUrl = directories[this.directoryIndex % directories.length];
    this.checkingRenewalInfo = true;
    try {
      const window = await requestScope.run(this.requests, async () => {
        const directory = directorySchema.safeParse((await acme.axios.get(this.checkedUrl(directoryUrl))).data);
        if (!directory.success || !directory.data.renewalInfo) return null;
        const base = this.checkedUrl(directory.data.renewalInfo).replace(/\/+$/, "");
        const info = renewalInfoSchema.safeParse((await acme.axios.get(`${base}/${certId}`)).data);
        return info.success ? info.data.suggestedWindow : null;
      });
      if (!window || this.stopped || this.cert !== cert) return;
      const start = Date.parse(window.start);
      const end = Date.parse(window.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
      this.renewAt = start + Math.random() * (end - start);
    } catch {
      return;
    } finally {
      this.checkingRenewalInfo = false;
    }
    this.maybeIssue();
  }

  private checkedUrl(raw: string): string {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !this.opts.allowInsecureDirectories) throw new Error("ACME directory must be https");
    return url.href;
  }

  private async issue(): Promise<void> {
    this.issuing = true;
    this.opts.onChange();
    const directories = this.directories();
    const directory = directories[this.directoryIndex % directories.length];
    try {
      await requestScope.run(this.requests, () => this.order(directory));
      this.error = null;
      this.failingSince = null;
      this.failures = 0;
      this.retryAt = 0;
      this.renewAt = null;
      this.saveState();
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
      this.saveState();
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
    this.checkedUrl(directoryUrl);
    // Refuse before asking the CA, rather than lose older keys CT watch relies on.
    readKeyHistory(dataDir);
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
      const { keyPem: challengeKey, certPem: challengeCert } = await this.step(createChallengeCert(host, keyAuthorization, this.clock.now()));
      const problem = challengeCertProblem(challengeCert, host, keyAuthorization);
      if (problem) throw new Error(problem);
      this.opts.target.setChallenge(challengeKey, challengeCert);
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
    const now = this.clock.now();
    if (!(cert.notBefore <= now && now < cert.notAfter)) throw new Error("CA returned a certificate that is not valid now");
    if (this.cert && cert.notAfter < this.cert.notAfter) throw new Error("CA returned a certificate that expires before the current one");
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
