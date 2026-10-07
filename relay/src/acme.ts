// Certificate for relay.<base> only, via ACME TLS-ALPN-01 answered by this
// process (design section 6). acme-client 5.4.0 ships createAlpnCertificate,
// so no X.509, JWS or ASN.1 code lives here.

import * as acme from "acme-client";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";
import type { Logger } from "./log.ts";

export interface AcmeClientLike {
  auto(opts: acme.ClientAutoOptions): Promise<string>;
}

export interface CertManagerOptions {
  host: string;
  /** Holds account.key, cert.key and cert.pem, all 0600. */
  dir: string;
  directoryUrl: string;
  email?: string;
  termsOfServiceAgreed: boolean;
  log: Logger;
  /** New serving context, also on startup with a stored certificate. */
  onCertificate: (context: SecureContext, notAfter: number) => void;
  /** Challenge context for ALPN acme-tls/1, or null when no challenge is open. */
  onChallenge: (context: SecureContext | null) => void;
  createClient?: (opts: { directoryUrl: string; accountKey: Buffer }) => AcmeClientLike;
  now?: () => number;
  /** How often the renewal check runs. */
  checkIntervalMs?: number;
}

const HOUR = 60 * 60 * 1000;
const RETRY_MIN_MS = HOUR;
const RETRY_MAX_MS = 12 * HOUR;

interface Stored {
  key: Buffer;
  cert: Buffer;
  notBefore: number;
  notAfter: number;
}

async function writePrivate(path: string, data: Buffer | string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class CertManager {
  private readonly opts: CertManagerOptions;
  private readonly now: () => number;
  private current: Stored | null = null;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(opts: CertManagerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  get notAfter(): number | null {
    return this.current?.notAfter ?? null;
  }

  /** Loads a stored certificate if it is valid for the host, then checks renewal. */
  async start(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    const [key, cert] = await Promise.all([
      readOptional(join(this.opts.dir, "cert.key")),
      readOptional(join(this.opts.dir, "cert.pem")),
    ]);
    if (key && cert) {
      const stored = this.validate(key, cert);
      if (stored) this.install(stored);
      else this.opts.log.log("cert-stored-invalid", {});
    }
    void this.check();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** True when there is no usable certificate or a third of its life is left. */
  needsRenewal(): boolean {
    const c = this.current;
    if (!c) return true;
    return this.now() >= c.notAfter - (c.notAfter - c.notBefore) / 3;
  }

  /** Runs one renewal check; resolves when any issuance attempt is done. */
  check(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      let delay = this.opts.checkIntervalMs ?? 12 * HOUR;
      if (this.needsRenewal()) {
        try {
          await this.issue();
          this.failures = 0;
        } catch (error) {
          this.failures += 1;
          delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (this.failures - 1));
          this.opts.log.log("cert-error", { reason: errorCode(error), count: this.failures });
        }
      }
      this.schedule(delay);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.check(), delay);
    this.timer.unref();
  }

  private async issue(): Promise<void> {
    const { host, dir } = this.opts;
    this.opts.log.log("cert-order", {});
    const accountPath = join(dir, "account.key");
    let accountKey = await readOptional(accountPath);
    if (!accountKey) {
      accountKey = await acme.crypto.createPrivateEcdsaKey();
      await writePrivate(accountPath, accountKey);
    }
    const client = (this.opts.createClient ?? defaultClient)({ directoryUrl: this.opts.directoryUrl, accountKey });
    const certKey = await acme.crypto.createPrivateEcdsaKey();
    const [, csr] = await acme.crypto.createCsr({ commonName: host, altNames: [host] }, certKey);
    const challengeKey = await acme.crypto.createPrivateEcdsaKey();

    const pem = await client.auto({
      csr,
      email: this.opts.email,
      termsOfServiceAgreed: this.opts.termsOfServiceAgreed,
      challengePriority: ["tls-alpn-01"],
      // The CA validates; a self check would need hairpin routing to our own public IP.
      skipChallengeVerification: true,
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        // acme-client 5.4.0 types list only http-01 and dns-01.
        if ((challenge.type as string) !== "tls-alpn-01" || authz.identifier.value !== host) {
          throw new Error("unsupported challenge");
        }
        const [, alpnCert] = await acme.crypto.createAlpnCertificate(authz, keyAuthorization, challengeKey);
        this.opts.onChallenge(createSecureContext({ key: challengeKey, cert: alpnCert }));
      },
      challengeRemoveFn: async () => {
        this.opts.onChallenge(null);
      },
    });
    this.opts.onChallenge(null);
    const cert = Buffer.from(pem);
    const stored = this.validate(certKey, cert);
    if (!stored) throw new Error("issued certificate does not match");
    await writePrivate(join(dir, "cert.key"), certKey);
    await writePrivate(join(dir, "cert.pem"), cert);
    this.install(stored);
  }

  private validate(key: Buffer, cert: Buffer): Stored | null {
    try {
      const info = acme.crypto.readCertificateInfo(cert);
      const names = [info.domains.commonName, ...info.domains.altNames].map((n) => n.toLowerCase());
      if (!names.includes(this.opts.host)) return null;
      const notAfter = info.notAfter.getTime();
      if (notAfter <= this.now()) return null;
      // Throws when the key does not match the certificate.
      createSecureContext({ key, cert });
      return { key, cert, notBefore: info.notBefore.getTime(), notAfter };
    } catch {
      return null;
    }
  }

  private install(stored: Stored): void {
    this.current = stored;
    this.opts.onCertificate(createSecureContext({ key: stored.key, cert: stored.cert }), stored.notAfter);
    this.opts.log.log("cert-installed", { notAfter: stored.notAfter });
  }
}

function defaultClient(opts: { directoryUrl: string; accountKey: Buffer }): AcmeClientLike {
  return new acme.Client({ directoryUrl: opts.directoryUrl, accountKey: opts.accountKey });
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code.toLowerCase() : "failed";
}
