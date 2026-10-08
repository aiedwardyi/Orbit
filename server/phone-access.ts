// Phone access from anywhere, inside the harness (docs/phone-relay-design.md
// sections 7 to 9): relay lifecycle, the gate in front of every relay request,
// pairing, and the PC-only management routes. Relay requests are known by
// socket identity; no header can make a request look like one.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";

import { PHONE_RELAY_OFF, SETUP_PREFIX, parseSetupCode, type PhoneRelayStatus, type SetupCodeProblem } from "../shared/relay-protocol.ts";
import type { HarnessHandler } from "./early-listen.ts";
import {
  RateLimiter,
  enrollError,
  phoneCookieToken,
  phoneSetCookie,
  rateKey,
  relayProblem,
  relayVerdict,
  safeRelayError,
  shellNavigation,
  type EnrollError,
  type RelayProblem,
} from "./phone-auth.ts";
import { PhoneDevices, type PairError, type PublicPhone } from "./phone-devices.ts";
import { realClock, type Clock } from "./phone-relay/clock.ts";
import type { PhoneRelay, PhoneRelayConfig, PhoneRelayEnrollOptions, PhoneRelayOptions } from "./phone-relay/index.ts";
import { relayMode } from "./phone-relay/mode.ts";
import { isRelayRequest } from "./phone-relay/via.ts";
import { parseJson } from "./schema.ts";

const MINUTE_MS = 60_000;
const MAX_BODY_BYTES = 4096;
/** States in which this PC holds a ticket for its relay host. */
const ENROLLED = new Set<PhoneRelayStatus["state"]>(["connected", "certifying", "reconnecting", "cert-error"]);
const PAIR_STATUS = {
  "no-pairing": 409,
  "wrong-credential": 401,
  "too-many-attempts": 401,
  "too-many-phones": 409,
  "save-failed": 500,
} satisfies Record<PairError, number>;
const DEVICE_ROUTE = /^\/api\/phone\/devices\/([\w-]{1,64})$/;
const MANAGEMENT_ROUTES = new Set(["/api/phone-relay", "/api/phone-relay/status", "/api/phone-relay/enroll", "/api/phone-relay/setup", "/api/phone/pairing", "/api/phone/devices"]);

const pairBodySchema = z.object({
  credential: z.string(),
  name: z.string().max(200).optional(),
  requestId: z.string().max(200).optional(),
});
const toggleBodySchema = z.object({ enabled: z.boolean() });
const enrollBodySchema = z.object({ invite: z.string().trim().min(1).max(4096) });
const setupBodySchema = z.object({ code: z.string().trim().min(1).max(4096) });
const SETUP_ERROR = {
  malformed: "that is not a setup code",
  "bad-base": "the setup code names an invalid relay address",
  "bad-invite": "the setup code holds an invalid invite",
} satisfies Record<SetupCodeProblem, string>;

export interface PhoneAccessOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  staticDir: string | null;
  config(): PhoneRelayConfig | undefined;
  saveEnabled(enabled: boolean): void;
  /** Saves `phoneRelay.base` with `enabled: true` and reloads the config. Without it, setup codes are refused. */
  saveSetup?(base: string): void;
  /** The relay status changed. */
  onChange?(): void;
  clock?: Clock;
  start?(options: PhoneRelayOptions): PhoneRelay;
  enroll?(options: PhoneRelayEnrollOptions): Promise<void>;
  loadClient?(): Promise<RelayClient>;
}

interface RelayClient {
  start(options: PhoneRelayOptions): PhoneRelay;
  enroll(options: PhoneRelayEnrollOptions): Promise<void>;
  peer(req: IncomingMessage): string | null;
}

/** Loaded only once the relay is on, so a PC without it never loads the client. */
export async function loadRelayClient(): Promise<RelayClient> {
  const [client, ingress] = await Promise.all([import("./phone-relay/index.ts"), import("./phone-relay/ingress.ts")]);
  return { start: client.startPhoneRelay, enroll: client.enrollPhoneRelay, peer: ingress.relayPeerForRequest };
}

export type RelayGate = { handled: true } | { handled: false; phone: PublicPhone | null };
const HANDLED: RelayGate = { handled: true };

/** GET /api/phone-relay/status: the section 7 status plus what Settings needs. Never keys, tickets or invites. */
export interface PhoneAccessStatus extends PhoneRelayStatus {
  /** False when ORBIT_RELAY=0: Settings shows nothing, not even the setup card. */
  available: boolean;
  configured: boolean;
  /** The configured relay base domain. */
  base: string | null;
  enabled: boolean;
  problem: RelayProblem | null;
}

type Reply =
  | { error: string }
  | { ok: true; phone?: Pick<PublicPhone, "id" | "name"> }
  | PhoneAccessStatus
  | { phones: PublicPhone[] }
  | { url: string; code: string; expiresAt: number };

function send(res: ServerResponse, status: number, body: Reply, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/** The request body parsed by `schema`, or null when it is too large, not JSON or the wrong shape. */
function readBody<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: T | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return finish(null);
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = schema.safeParse(parseJson(Buffer.concat(chunks).toString("utf8")));
        finish(parsed.success ? parsed.data : null);
      } catch {
        finish(null);
      }
    });
    req.on("error", () => finish(null));
  });
}

export class PhoneAccess {
  private readonly options: PhoneAccessOptions;
  private readonly clock: Clock;
  private handler: HarnessHandler | null = null;
  private relay: PhoneRelay | null = null;
  private queue: Promise<void> = Promise.resolve();
  private registry: PhoneDevices | null = null;
  private client: RelayClient | null = null;
  /** Why the relay client last failed to load or start. */
  private failure: string | null = null;
  private readonly sockets = new Map<string, Set<Duplex>>();
  private readonly peerLimit: RateLimiter;
  private readonly pcLimit: RateLimiter;

  constructor(options: PhoneAccessOptions) {
    this.options = options;
    this.clock = options.clock ?? realClock;
    const now = () => this.clock.now();
    this.peerLimit = new RateLimiter(10, MINUTE_MS, now);
    this.pcLimit = new RateLimiter(30, MINUTE_MS, now);
  }

  /** Created on first use, so a PC without the relay never reads or writes phone files. */
  private get phones(): PhoneDevices {
    this.registry ??= new PhoneDevices(this.options.dataDir, this.clock);
    return this.registry;
  }

  /** Starts the relay, once the real request handler exists. */
  start(handler: HarnessHandler): Promise<void> {
    this.handler = handler;
    return this.restart();
  }

  stop(): Promise<void> {
    this.handler = null;
    return this.restart();
  }

  /** Stops the running relay before starting one for the current config. */
  restart(): Promise<void> {
    const next = this.queue.then(() => this.swap());
    this.queue = next.catch(() => {});
    return next;
  }

  private async swap(): Promise<void> {
    const old = this.relay;
    this.relay = null;
    this.failure = null;
    if (old) {
      await old.stop();
      this.options.onChange?.();
    }
    const config = this.options.config() ?? {};
    const handler = this.handler;
    if (!handler || relayMode(config, this.options.env).kind === "off") return;
    try {
      this.client ??= await (this.options.loadClient ?? loadRelayClient)();
      const relay: PhoneRelay = (this.options.start ?? this.client.start)({
        dataDir: this.options.dataDir,
        config,
        handler,
        onStatus: () => {
          if (this.relay === relay) this.options.onChange?.();
        },
      });
      this.relay = relay;
    } catch (cause) {
      this.failure = cause instanceof Error ? cause.message : String(cause);
      console.error(`[phone-relay] start failed: ${this.failure}`);
    }
    this.options.onChange?.();
  }

  status(): PhoneRelayStatus {
    return this.relay?.status() ?? { ...PHONE_RELAY_OFF, lastError: this.failure };
  }

  /** This PC's relay host while it holds a ticket, for the device picker. */
  presenceHost(): string | null {
    const status = this.status();
    return status.host && ENROLLED.has(status.state) ? status.host : null;
  }

  /** The base a relay phone's device picker is limited to. */
  base(): string | null {
    const mode = relayMode(this.options.config() ?? {}, this.options.env);
    return mode.kind === "on" ? mode.base : null;
  }

  private describe(): PhoneAccessStatus {
    const config = this.options.config() ?? {};
    const available = this.options.env.ORBIT_RELAY !== "0";
    const base = config.base?.trim().toLowerCase() || null;
    const configured = Boolean(base) && available;
    const status = this.status();
    return {
      available,
      configured,
      base: configured ? base : null,
      enabled: configured && config.enabled === true,
      ...status,
      lastError: safeRelayError(status.lastError),
      problem: relayProblem(status.state, status.lastError),
    };
  }

  /** Runs before any route for a relay request. `phone` is null only for public files. */
  async gate(req: IncomingMessage, res: ServerResponse): Promise<RelayGate> {
    const host = this.relay?.status().host ?? null;
    if (!host) {
      send(res, 503, { error: "phone access is off" });
      return HANDLED;
    }
    const verdict = relayVerdict(req, host);
    switch (verdict.kind) {
      case "deny":
        send(res, verdict.status, { error: verdict.error });
        return HANDLED;
      case "health":
        send(res, 200, { ok: true });
        return HANDLED;
      case "pair-page":
        this.pairPage(res);
        return HANDLED;
      case "pair":
        await this.pair(req, res);
        return HANDLED;
    }
    const phone = this.session(req, res);
    if (phone) return { handled: false, phone };
    const path = new URL(req.url ?? "/", "https://relay.invalid").pathname;
    if (path.startsWith("/api/")) {
      send(res, 401, { error: "unauthorized" });
      return HANDLED;
    }
    if (shellNavigation(req.method ?? "GET", path)) {
      res.writeHead(302, { location: "/pair", "cache-control": "no-store" });
      res.end();
      return HANDLED;
    }
    return { handled: false, phone: null };
  }

  private session(req: IncomingMessage, res: ServerResponse): PublicPhone | null {
    const token = phoneCookieToken(req.headers.cookie);
    const auth = token ? this.phones.authenticate(token) : null;
    if (!token || !auth) return null;
    this.track(auth.phone.id, req.socket);
    if (auth.refreshCookie) res.setHeader("set-cookie", phoneSetCookie(token));
    return auth.phone;
  }

  /** Remembers which sockets a phone used, so revoking it can cut them. */
  private track(id: string, socket: Duplex): void {
    let open = this.sockets.get(id);
    if (!open) {
      open = new Set();
      this.sockets.set(id, open);
    }
    if (open.has(socket)) return;
    const set = open;
    set.add(socket);
    socket.once("close", () => {
      set.delete(socket);
      if (!set.size && this.sockets.get(id) === set) this.sockets.delete(id);
    });
  }

  private pairPage(res: ServerResponse): void {
    let page: Buffer;
    try {
      if (!this.options.staticDir) throw new Error("no UI");
      page = readFileSync(join(this.options.staticDir, "pair.html"));
    } catch {
      return send(res, 404, { error: "not found" });
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    });
    res.end(page);
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The peer comes from the relay's authenticated go frame; it limits, never authorizes.
    if (!this.peerLimit.take(rateKey(this.client?.peer(req) ?? null)) || !this.pcLimit.take("pc")) {
      return send(res, 429, { error: "rate-limited" });
    }
    const body = await readBody(req, pairBodySchema);
    if (!body) return send(res, 400, { error: "bad-request" });
    const result = this.phones.redeem(body.credential, body.name, body.requestId);
    if (!result.ok) return send(res, PAIR_STATUS[result.error], { error: result.error });
    send(res, 200, { ok: true, phone: { id: result.phone.id, name: result.phone.name } }, { "set-cookie": phoneSetCookie(result.token) });
  }

  /** Trades `invite` for a ticket. The failure reason, or null once enrolled. */
  private async enroll(invite: string): Promise<EnrollError | null> {
    try {
      this.client ??= await (this.options.loadClient ?? loadRelayClient)();
      await (this.options.enroll ?? this.client.enroll)({ dataDir: this.options.dataDir, config: this.options.config() ?? {}, invite });
      return null;
    } catch (cause) {
      const reason = safeRelayError(cause instanceof Error ? cause.message : String(cause)) ?? "enrollment failed";
      console.error(`[phone-relay] enroll failed: ${reason}`);
      return enrollError(reason);
    }
  }

  /** Whether this PC stored a ticket from some relay. Reads only; never creates a key. */
  private async holdsTicket(): Promise<boolean> {
    const { readTicket } = await import("./phone-relay/store.ts");
    return readTicket(this.options.dataDir).kind !== "missing";
  }

  /** PC-only management routes. False when `path` is not one of them. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, method: string, bearerOk: boolean): Promise<boolean> {
    const device = DEVICE_ROUTE.exec(path);
    if (!MANAGEMENT_ROUTES.has(path) && !device) return false;
    const reply = (status: number, body: Reply) => {
      send(res, status, body);
      return true;
    };
    if (isRelayRequest(req)) return reply(404, { error: "not found" });
    if (!bearerOk) return reply(403, { error: "manage phone access on this PC" });

    if (method === "GET" && path === "/api/phone-relay/status") return reply(200, this.describe());
    if (method === "PUT" && path === "/api/phone-relay") {
      const body = await readBody(req, toggleBodySchema);
      if (!body) return reply(400, { error: "enabled must be a boolean" });
      if (!this.describe().configured) return reply(409, { error: "phone access is not set up on this PC" });
      this.options.saveEnabled(body.enabled);
      await this.restart();
      return reply(200, this.describe());
    }
    if (method === "POST" && path === "/api/phone-relay/enroll") {
      const body = await readBody(req, enrollBodySchema);
      if (!body) return reply(400, { error: "enter an invite" });
      const status = this.describe();
      if (!status.enabled) return reply(409, { error: "turn on phone access first" });
      let invite = body.invite;
      if (invite.startsWith(`${SETUP_PREFIX}:`)) {
        const code = parseSetupCode(invite);
        if (!code.ok) return reply(400, { error: SETUP_ERROR[code.reason] });
        if (code.value.base !== status.base) return reply(400, { error: `this setup code is for ${code.value.base}, but this PC uses ${status.base}` });
        invite = code.value.invite;
      }
      const failed = await this.enroll(invite);
      if (failed) return reply(400, { error: failed });
      await this.restart();
      return reply(200, this.describe());
    }
    if (method === "POST" && path === "/api/phone-relay/setup") {
      const body = await readBody(req, setupBodySchema);
      if (!body) return reply(400, { error: "enter a setup code" });
      if (this.options.env.ORBIT_RELAY === "0" || !this.options.saveSetup) return reply(409, { error: "phone access is turned off on this PC" });
      const code = parseSetupCode(body.code);
      if (!code.ok) return reply(400, { error: SETUP_ERROR[code.reason] });
      const current = this.describe().base;
      if (current && current !== code.value.base && (await this.holdsTicket())) {
        return reply(409, { error: `this PC already uses the relay at ${current}` });
      }
      this.options.saveSetup(code.value.base);
      // A failed enroll keeps the saved base, so Settings asks for a new code.
      const failed = await this.enroll(code.value.invite);
      await this.restart();
      return reply(failed ? 400 : 200, failed ? { error: failed } : this.describe());
    }
    if (path === "/api/phone/pairing") {
      if (method === "DELETE") {
        this.registry?.closePairing();
        return reply(200, { ok: true });
      }
      if (method !== "POST") return reply(405, { error: "method not allowed" });
      const status = this.status();
      if (status.state !== "connected" || !status.host) return reply(409, { error: "phone access is not connected" });
      const window = this.phones.openPairing();
      return reply(200, { url: `https://${status.host}/pair#k=${window.token}`, code: window.code, expiresAt: window.expiresAt });
    }
    if (method === "GET" && path === "/api/phone/devices") return reply(200, { phones: this.describe().enabled ? this.phones.list() : [] });
    if (method === "DELETE" && device) {
      const id = device[1]!;
      try {
        if (!this.phones.revoke(id)) return reply(404, { error: "no such phone" });
      } finally {
        // A revoke whose write failed still refuses the phone, so cut it either way.
        for (const socket of this.sockets.get(id) ?? []) socket.destroy();
        this.sockets.delete(id);
      }
      return reply(200, { ok: true });
    }
    return reply(405, { error: "method not allowed" });
  }
}
