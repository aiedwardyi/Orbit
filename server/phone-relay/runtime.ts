// Wires identity, relay client, ingress, certificates and CT checks into the
// status contract of design section 7. Dependencies are injected so tests run
// against an in-process fake relay, a fake CA and a fake clock.

import { PHONE_RELAY_OFF, hostFor, type PhoneRelayStatus } from "../../shared/relay-protocol.ts";
import { CertManager, type CertManagerOptions } from "./acme.ts";
import { RelayClient, defaultConnector, type RelayConnector } from "./client.ts";
import { realClock, type Clock } from "./clock.ts";
import { CtWatch, crtShSource, type CtSource } from "./ct-watch.ts";
import type { PhoneRelay, PhoneRelayOptions } from "./index.ts";
import { RelayIngress, type IngressRejection } from "./ingress.ts";
import { relayHostFor, relayMode } from "./mode.ts";
import { readIdentity, readTicket, ticketProblem, writeTicket, type Identity } from "./store.ts";

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
  return { status: () => runtime.status(), stop: () => runtime.stop() };
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
        if (this.stopped || ticketProblem(next, identity, clock.now())) return false;
        writeTicket(dataDir, next);
        return true;
      },
      onChange: () => this.update(),
    });
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
    if (sameStatus(next, this.current)) return;
    this.current = next;
    this.options.onStatus({ ...next });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
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
    a.nextRetryAt === b.nextRetryAt
  );
}
