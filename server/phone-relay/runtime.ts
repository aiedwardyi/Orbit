// Wires identity, relay client, ingress, certificates and CT checks into the
// status contract of design section 7. Dependencies are injected so tests run
// against an in-process fake relay, a fake CA and a fake clock.

import { googleSubHash } from "../../shared/google-id-token.ts";
import { FrameError, PERSON_NAME_MAX, PHONE_RELAY_OFF, PC_NAME_MAX, encodeFrame, hostFor, type PhoneRelayStatus, type TeamSnag } from "../../shared/relay-protocol.ts";
import { ACCOUNT_TOKEN_MAX_AGE_MS, idTokenClaims, registerAccount } from "./account.ts";
import { CertManager, type CertManagerOptions } from "./acme.ts";
import { RelayClient, defaultConnector, type RelayConnector } from "./client.ts";
import { realClock, type Cancel, type Clock } from "./clock.ts";
import { CtWatch, crtShSource, type CtSource } from "./ct-watch.ts";
import type { HttpsDeps } from "./https.ts";
import type { PhoneRelay, PhoneRelayOptions, RelayAccountSource } from "./index.ts";
import { RelayIngress, type IngressRejection } from "./ingress.ts";
import { relayHostFor, relayMode } from "./mode.ts";
import {
  accountProblem,
  clearAccount,
  decodeAccountClaims,
  decodeTicketClaims,
  readAccount,
  readIdentity,
  readTicket,
  ticketProblem,
  writeAccount,
  writeTicket,
  type Identity,
} from "./store.ts";

export interface PhoneRelayDeps {
  clock: Clock;
  env: NodeJS.ProcessEnv;
  connector: RelayConnector;
  random?: () => number;
  /** null disables CT checks. */
  ctSource: CtSource | null;
  acmeInsecureDirectories?: boolean;
  createAcmeClient?: CertManagerOptions["createClient"];
  onIngressReject?: (reason: IngressRejection) => void;
  /** For the account registration call; tests point it at the fake relay. */
  https?: HttpsDeps;
}

export function defaultDeps(): PhoneRelayDeps {
  return { clock: realClock, env: process.env, connector: defaultConnector(), ctSource: crtShSource() };
}

const OFF_RELAY: PhoneRelay = { status: () => ({ ...PHONE_RELAY_OFF }), stop: async () => {} };

export function createPhoneRelay(options: PhoneRelayOptions, deps: PhoneRelayDeps): PhoneRelay {
  const mode = relayMode(options.config, deps.env);
  if (mode.kind === "off") return OFF_RELAY;
  const runtime = new RelayRuntime(options, deps);
  if (mode.kind === "invalid") runtime.fixed({ state: "rejected", lastError: mode.reason });
  else runtime.boot(mode.base);
  return {
    status: () => runtime.status(),
    stop: () => runtime.stop(),
    syncAccount: () => runtime.syncAccount(),
    reauth: () => runtime.reauth(),
    accountReady: () => runtime.accountReady(),
    sendSnag: (snag) => runtime.sendSnag(snag),
  };
}

/** At most one registration attempt, or ID token refresh, per PC this often. */
export const ACCOUNT_RETRY_MS = 60_000;

/** Ed25519 signature length in base64url, for sizing the auth frame a ticket must fit. */
const AUTH_SIG_CHARS = 86;

/** A refreshed ticket must name this key, outlive the current one and still fit the auth frame. */
function refreshAcceptable(next: string, current: string, identity: Identity, now: number): boolean {
  if (ticketProblem(next, identity, now)) return false;
  const nextExp = decodeTicketClaims(next)?.exp;
  const currentExp = decodeTicketClaims(current)?.exp;
  if (nextExp === undefined || (currentExp !== undefined && nextExp <= currentExp)) return false;
  try {
    encodeFrame({ type: "auth", label: identity.label, pk: identity.pk, ticket: next, sig: "A".repeat(AUTH_SIG_CHARS) });
  } catch (error) {
    if (error instanceof FrameError) return false;
    throw error;
  }
  return true;
}

class RelayRuntime {
  private readonly options: PhoneRelayOptions;
  private readonly deps: PhoneRelayDeps;
  private current: PhoneRelayStatus = { ...PHONE_RELAY_OFF, state: "reconnecting" };
  private stopped = false;
  private host: string | null = null;
  private client: RelayClient | null = null;
  private certs: CertManager | null = null;
  private ct: CtWatch | null = null;
  private ingress: RelayIngress | null = null;
  private ctAlert: string | null = null;
  private wasConnected = false;
  private base = "";
  private identity: Identity | null = null;
  private ticket = "";
  /** The wka1 sent in auth. */
  private account: string | null = null;
  /** Send `account: null` until the relay has seen it, after a sign-out or an account switch. */
  private dropAccount = false;
  private registering = false;
  /** A sync came in while registering. */
  private resync = false;
  private lastAttempt = -Infinity;
  private retry: Cancel | null = null;
  /** The last ID token tried, so a refused one is not sent again. */
  private triedToken: string | null = null;

  constructor(options: PhoneRelayOptions, deps: PhoneRelayDeps) {
    this.options = options;
    this.deps = deps;
  }

  status(): PhoneRelayStatus {
    return { ...this.current };
  }

  /** A terminal status with no sockets or timers. */
  fixed(patch: Pick<PhoneRelayStatus, "state" | "lastError">): void {
    this.current = { ...PHONE_RELAY_OFF, host: this.host, ...patch };
  }

  boot(base: string): void {
    const { dataDir } = this.options;
    const identity = readIdentity(dataDir);
    if (identity.kind === "missing") return this.fixed({ state: "enrolling", lastError: null });
    if (identity.kind === "invalid") return this.fixed({ state: "rejected", lastError: `identity: ${identity.reason}` });
    this.host = hostFor(identity.value.label, base);
    const ticket = readTicket(dataDir);
    if (ticket.kind !== "ok") {
      return this.fixed({ state: "enrolling", lastError: ticket.kind === "invalid" ? ticket.reason : null });
    }
    const problem = ticketProblem(ticket.value, identity.value, this.deps.clock.now());
    if (problem === "ticket expired") return this.fixed({ state: "rejected", lastError: "ticket expired, enter an invite" });
    if (problem) return this.fixed({ state: "enrolling", lastError: problem });
    this.wire(base, identity.value, ticket.value);
  }

  private wire(base: string, identity: Identity, ticket: string): void {
    const { dataDir, config, handler } = this.options;
    const { clock } = this.deps;
    const host = hostFor(identity.label, base);
    this.current = { ...this.current, host };
    this.base = base;
    this.identity = identity;
    this.ticket = ticket;
    const ingress = new RelayIngress({ host, handler, clock, onReject: this.deps.onIngressReject });
    this.ingress = ingress;
    this.certs = new CertManager({
      dataDir,
      host,
      directories: config.acmeDirectories ?? [],
      accounts: config.acmeAccounts ?? {},
      clock,
      target: ingress,
      onChange: () => this.update(),
      allowInsecureDirectories: this.deps.acmeInsecureDirectories,
      createClient: this.deps.createAcmeClient,
    });
    this.client = new RelayClient({
      relayHost: relayHostFor(base),
      identity,
      ticket,
      connector: this.deps.connector,
      clock,
      random: this.deps.random,
      onGo: (socket, head, peer) => ingress.accept(socket, head, peer),
      onTicket: (next) => {
        if (this.stopped || !refreshAcceptable(next, this.ticket, identity, clock.now())) return false;
        writeTicket(dataDir, next);
        this.ticket = next;
        return true;
      },
      account: () => this.authAccount(),
      onAccount: (next) => this.refreshAccount(next),
      onChange: () => this.update(),
    });
    this.syncAccount();
    if (this.deps.ctSource) {
      this.ct = new CtWatch({
        host,
        dataDir,
        clock,
        source: this.deps.ctSource,
        onAlert: (message) => {
          this.ctAlert = message;
          this.update();
        },
      });
    }
    queueMicrotask(() => {
      if (this.stopped) return;
      this.certs?.start();
      this.client?.start();
      this.ct?.start();
      this.update();
    });
  }

  accountReady(): boolean {
    return this.account !== null;
  }

  sendSnag(snag: TeamSnag): Promise<boolean> {
    return this.client?.sendSnag(snag) ?? Promise.resolve(false);
  }

  reauth(): void {
    this.client?.reauth();
  }

  /** What the next auth says about the account directory. */
  private authAccount(): { account: string; name: string; person?: string } | null | undefined {
    const person = (this.options.account?.person?.() ?? "").trim().slice(0, PERSON_NAME_MAX);
    if (this.account) {
      const entry = { account: this.account, name: (this.options.account?.name() ?? "").slice(0, PC_NAME_MAX) };
      return person ? { ...entry, person } : entry;
    }
    if (!this.dropAccount) return undefined;
    this.dropAccount = false;
    return null;
  }

  /** Matches the held wka1 to the signed-in account: keeps it, drops it, or registers for a new one. */
  syncAccount(): void {
    const source = this.options.account;
    const identity = this.identity;
    if (!source || !identity || this.stopped) return;
    const { dataDir } = this.options;
    const sub = source.sub();
    // Pending at boot: keep the stored wka1 until the desktop names the account.
    if (sub === undefined) return;
    if (!sub) this.cancelRetry();
    const before = this.account;
    const stored = readAccount(dataDir);
    if (sub && stored.kind === "ok" && !accountProblem(stored.value, identity, googleSubHash(sub), this.deps.clock.now())) {
      this.account = stored.value;
    } else {
      if (stored.kind !== "missing") clearAccount(dataDir);
      this.account = null;
      if (sub) this.register(source, sub);
    }
    if (before && before !== this.account) this.dropAccount = true;
    if (before !== this.account) this.client?.reauth();
  }

  /** Registers with the held ID token, or a freshly refreshed one when it is missing, stale or tried. */
  private register(source: RelayAccountSource, sub: string): void {
    const identity = this.identity;
    if (!identity) return;
    if (this.registering) {
      this.resync = true;
      return;
    }
    const wait = this.lastAttempt + ACCOUNT_RETRY_MS - this.deps.clock.now();
    if (wait > 0) {
      this.retry ??= this.deps.clock.schedule(wait, () => {
        this.retry = null;
        this.syncAccount();
      });
      return;
    }
    this.lastAttempt = this.deps.clock.now();
    this.registering = true;
    this.resync = false;
    const held = source.idToken();
    const token = held && this.usable(held, sub) ? Promise.resolve(held) : source.freshIdToken();
    token
      .then((fresh) => (fresh && !this.stopped && source.sub() === sub && this.usable(fresh, sub) ? this.send(identity, fresh, sub).then(() => true) : this.resync))
      .catch(() => true)
      .then((again) => {
        this.registering = false;
        if (again) this.syncAccount();
      });
  }

  private usable(idToken: string, sub: string): boolean {
    const claims = idTokenClaims(idToken);
    return idToken !== this.triedToken && claims?.sub === sub && this.deps.clock.now() - claims.iat <= ACCOUNT_TOKEN_MAX_AGE_MS;
  }

  private send(identity: Identity, idToken: string, sub: string): Promise<void> {
    this.triedToken = idToken;
    const { dataDir } = this.options;
    return registerAccount({ base: this.base, identity, ticket: this.ticket, idToken, sub, now: this.deps.clock.now() }, this.deps.https).then(
      (account) => {
        if (!this.stopped && this.options.account?.sub() === sub) writeAccount(dataDir, account);
      },
      (error) => console.error(`[phone-relay] account registration failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  private cancelRetry(): void {
    this.retry?.();
    this.retry = null;
  }

  /** A wka1 refreshed past half life: same PC and account, later expiry. */
  private refreshAccount(next: string): void {
    const sub = this.options.account?.sub();
    const current = this.account ? decodeAccountClaims(this.account) : null;
    const claims = decodeAccountClaims(next);
    if (this.stopped || !sub || !this.identity || !current || !claims || claims.exp <= current.exp) return;
    if (accountProblem(next, this.identity, googleSubHash(sub), this.deps.clock.now())) return;
    writeAccount(this.options.dataDir, next);
    this.account = next;
  }

  private update(): void {
    if (this.stopped || !this.client || !this.certs) return;
    const link = this.client.snapshot();
    const cert = this.certs.snapshot();
    const connected = link.state === "connected";
    if (connected !== this.wasConnected) {
      this.wasConnected = connected;
      this.certs.setConnected(connected);
      return this.update();
    }
    let state: PhoneRelayStatus["state"];
    if (link.state === "rejected") state = "rejected";
    else if (!connected) state = "reconnecting";
    else if (cert.valid) state = "connected";
    else if (cert.error && !cert.issuing) state = "cert-error";
    else state = "certifying";
    const linkError = connected ? null : link.lastError;
    const next: PhoneRelayStatus = {
      state,
      host: this.host,
      relayRttMs: connected ? link.rttMs : null,
      poolIdle: link.poolIdle,
      certNotAfter: cert.notAfter,
      lastError: this.ctAlert ?? linkError ?? cert.error,
      nextRetryAt: link.nextRetryAt,
    };
    if (connected && link.snags) next.snags = true;
    if (sameStatus(next, this.current)) return;
    this.current = next;
    this.options.onStatus({ ...next });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRetry();
    this.client?.stop();
    this.certs?.stop();
    this.ct?.stop();
    this.ingress?.close();
  }
}

function sameStatus(a: PhoneRelayStatus, b: PhoneRelayStatus): boolean {
  return (
    a.state === b.state &&
    a.host === b.host &&
    a.relayRttMs === b.relayRttMs &&
    a.poolIdle === b.poolIdle &&
    a.certNotAfter === b.certNotAfter &&
    a.lastError === b.lastError &&
    a.nextRetryAt === b.nextRetryAt &&
    a.snags === b.snags
  );
}
