// Minimal RFC 8555 CA over plain http on loopback. It checks JWS signatures
// and EAB, offers http-01, dns-01 and tls-alpn-01, and asks a test-supplied
// validator to check the TLS-ALPN-01 answer before marking it valid.

import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, type webcrypto } from "node:crypto";

type JsonWebKey = webcrypto.JsonWebKey;
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { listenLocal } from "./net.ts";
import type { TestCa, Validity } from "./pki.ts";

export interface FakeAcmeOptions {
  ca: TestCa;
  /** Require external account binding with this key id and base64url HMAC key. */
  eab?: { kid: string; hmacKey: string };
}

/** Checks that `host` now presents a TLS-ALPN-01 certificate for `keyAuthorization`. */
export type AlpnValidator = (host: string, keyAuthorization: string) => Promise<boolean>;

interface Account {
  url: string;
  thumbprint: string;
  eabKid: string | null;
}

interface Order {
  id: number;
  host: string;
  status: string;
  authz: Authz;
  certPem: string | null;
}

interface Authz {
  id: number;
  host: string;
  status: string;
  token: string;
}

interface OrderBody {
  status: string;
  identifiers: Array<{ type: string; value: string }>;
  authorizations: string[];
  finalize: string;
  certificate?: string;
}

interface Jws {
  header: { alg: string; url: string; nonce?: string; kid?: string; jwk?: JsonWebKey };
  payload: string;
  account: Account | null;
  jwkThumbprint: string;
}

export function jwkThumbprint(jwk: JsonWebKey): string {
  const canonical = jwk.kty === "EC" ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("base64url");
}

export class FakeAcme {
  readonly ca: TestCa;
  readonly eab: FakeAcmeOptions["eab"];
  port = 0;
  validator: AlpnValidator = async () => false;
  validity: () => Validity = () => ({});
  /** "reject" fails every new order; "hold" parks finalize until release(). */
  mode: "ok" | "reject" | "hold" = "ok";
  readonly log: string[] = [];
  onHold: (() => void) | null = null;
  /** Thumbprints of every account key that signed a request. */
  readonly accountKeys = new Set<string>();
  /** EAB key ids seen on new-account requests. */
  readonly eabSeen: string[] = [];
  private server: Server | null = null;
  private readonly nonces = new Set<string>();
  private readonly accounts = new Map<string, Account>();
  private readonly orders = new Map<number, Order>();
  private readonly authzs = new Map<number, Authz>();
  private nextId = 1;
  private held: Array<() => void> = [];

  private constructor(options: FakeAcmeOptions) {
    this.ca = options.ca;
    this.eab = options.eab;
  }

  static async start(options: FakeAcmeOptions): Promise<FakeAcme> {
    const acme = new FakeAcme(options);
    const server = createServer((req, res) => void acme.handle(req, res));
    acme.server = server;
    acme.port = await listenLocal(server);
    return acme;
  }

  get directoryUrl(): string {
    return `${this.base}/directory`;
  }

  private get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  release(): void {
    const held = this.held;
    this.held = [];
    for (const resume of held) resume();
  }

  async close(): Promise<void> {
    this.release();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private nonce(): string {
    const value = randomBytes(16).toString("base64url");
    this.nonces.add(value);
    return value;
  }

  /** `json` is already serialized. */
  private send(res: ServerResponse, status: number, json: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "replay-nonce": this.nonce(), "content-type": "application/json", ...headers }).end(json);
  }

  private sendPem(res: ServerResponse, pem: string): void {
    res.writeHead(200, { "replay-nonce": this.nonce(), "content-type": "application/pem-certificate-chain" }).end(pem);
  }

  private problem(res: ServerResponse, status: number, type: string, detail: string): void {
    this.log.push(`error:${type}`);
    res
      .writeHead(status, { "replay-nonce": this.nonce(), "content-type": "application/problem+json" })
      .end(JSON.stringify({ type: `urn:ietf:params:acme:error:${type}`, detail }));
  }

  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }

  private parseJws(text: string, url: string): { ok: true; jws: Jws } | { ok: false; error: string } {
    const fail = (error: string) => ({ ok: false as const, error });
    let jws: { protected: string; payload: string; signature: string };
    try {
      jws = JSON.parse(text);
    } catch {
      return fail("malformed");
    }
    const header: Jws["header"] = JSON.parse(Buffer.from(jws.protected, "base64url").toString("utf8"));
    if (header.url !== url) return fail("url mismatch");
    if (!header.nonce || !this.nonces.delete(header.nonce)) return fail("badNonce");
    let jwk: JsonWebKey | undefined = header.jwk;
    let account: Account | null = null;
    if (header.kid) {
      account = [...this.accounts.values()].find((candidate) => candidate.url === header.kid) ?? null;
      if (!account) return fail("accountDoesNotExist");
      jwk = this.keyOf.get(account.thumbprint);
    }
    if (!jwk) return fail("no key");
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const ok = verify("sha256", Buffer.from(`${jws.protected}.${jws.payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(jws.signature, "base64url"));
    if (!ok) return fail("bad signature");
    const thumbprint = jwkThumbprint(jwk);
    this.accountKeys.add(thumbprint);
    return { ok: true, jws: { header, payload: Buffer.from(jws.payload, "base64url").toString("utf8"), account, jwkThumbprint: thumbprint } };
  }

  private readonly keyOf = new Map<string, JsonWebKey>();

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? "/";
    if (path === "/directory") {
      this.send(
        res,
        200,
        JSON.stringify({
          newNonce: `${this.base}/new-nonce`,
          newAccount: `${this.base}/new-account`,
          newOrder: `${this.base}/new-order`,
          meta: { externalAccountRequired: Boolean(this.eab) },
        }),
      );
      return;
    }
    if (path === "/new-nonce") {
      res.writeHead(200, { "replay-nonce": this.nonce(), "cache-control": "no-store" }).end();
      return;
    }
    if (req.method !== "POST") return this.problem(res, 405, "malformed", "POST only");
    const parsed = this.parseJws(await this.body(req), `${this.base}${path}`);
    if (!parsed.ok) return this.problem(res, 400, parsed.error === "badNonce" ? "badNonce" : "malformed", parsed.error);
    const jws = parsed.jws;
    const payload = jws.payload ? JSON.parse(jws.payload) : null;

    if (path === "/new-account") return this.newAccount(res, jws, payload);
    if (!jws.account) return this.problem(res, 401, "unauthorized", "kid required");
    this.log.push(`${jws.account.url} ${path}`);
    if (path === jws.account.url.slice(this.base.length)) return this.send(res, 200, JSON.stringify({ status: "valid" }));
    if (path === "/new-order") return this.newOrder(res, payload);

    const authzMatch = /^\/authz\/(\d+)$/.exec(path);
    if (authzMatch) {
      const authz = this.authzs.get(Number(authzMatch[1]));
      if (!authz) return this.problem(res, 404, "malformed", "no authz");
      return this.send(res, 200, JSON.stringify(this.authzBody(authz)));
    }
    const challengeMatch = /^\/chall\/(\d+)\/([a-z0-9-]+)$/.exec(path);
    if (challengeMatch) {
      const authz = this.authzs.get(Number(challengeMatch[1]));
      if (!authz) return this.problem(res, 404, "malformed", "no authz");
      const type = challengeMatch[2];
      this.log.push(`challenge:${type}`);
      if (type === "tls-alpn-01" && authz.status === "pending") {
        const keyAuthorization = `${authz.token}.${jws.jwkThumbprint}`;
        let valid = false;
        try {
          valid = await this.validator(authz.host, keyAuthorization);
        } catch {
          valid = false;
        }
        authz.status = valid ? "valid" : "invalid";
        this.log.push(`validated:${authz.status}`);
      }
      return this.send(res, 200, JSON.stringify({ type, url: `${this.base}${path}`, status: authz.status, token: authz.token }));
    }
    const orderMatch = /^\/order\/(\d+)(\/finalize)?$/.exec(path);
    if (orderMatch) {
      const order = this.orders.get(Number(orderMatch[1]));
      if (!order) return this.problem(res, 404, "malformed", "no order");
      if (orderMatch[2]) return this.finalize(res, order, payload);
      return this.send(res, 200, JSON.stringify(this.orderBody(order)));
    }
    const certMatch = /^\/cert\/(\d+)$/.exec(path);
    if (certMatch) {
      const order = this.orders.get(Number(certMatch[1]));
      if (!order?.certPem) return this.problem(res, 404, "malformed", "no cert");
      return this.sendPem(res, order.certPem);
    }
    this.problem(res, 404, "malformed", `unknown ${path}`);
  }

  private newAccount(res: ServerResponse, jws: Jws, payload: { externalAccountBinding?: { protected: string; payload: string; signature: string } }): void {
    const jwk = jws.header.jwk;
    if (!jwk) return this.problem(res, 400, "malformed", "jwk required");
    const existing = this.accounts.get(jws.jwkThumbprint);
    if (existing) return this.send(res, 200, JSON.stringify({ status: "valid" }), { location: existing.url });
    let eabKid: string | null = null;
    const binding = payload?.externalAccountBinding;
    if (this.eab) {
      if (!binding) return this.problem(res, 400, "externalAccountRequired", "EAB required");
      const header = JSON.parse(Buffer.from(binding.protected, "base64url").toString("utf8"));
      const mac = createHmac("sha256", Buffer.from(this.eab.hmacKey, "base64url")).update(`${binding.protected}.${binding.payload}`).digest();
      const bound = JSON.parse(Buffer.from(binding.payload, "base64url").toString("utf8"));
      const sig = Buffer.from(binding.signature, "base64url");
      if (header.kid !== this.eab.kid || sig.length !== mac.length || !timingSafeEqual(sig, mac) || jwkThumbprint(bound) !== jws.jwkThumbprint) {
        return this.problem(res, 400, "unauthorized", "EAB invalid");
      }
      eabKid = header.kid;
    }
    if (binding) this.eabSeen.push(eabKid ?? "unchecked");
    const account: Account = { url: `${this.base}/acct/${this.nextId++}`, thumbprint: jws.jwkThumbprint, eabKid };
    this.accounts.set(jws.jwkThumbprint, account);
    this.keyOf.set(jws.jwkThumbprint, jwk);
    this.log.push("new-account");
    this.send(res, 201, JSON.stringify({ status: "valid" }), { location: account.url });
  }

  private newOrder(res: ServerResponse, payload: { identifiers?: Array<{ type: string; value: string }> }): void {
    if (this.mode === "reject") return this.problem(res, 403, "rejectedIdentifier", "test rejects orders");
    const ids = payload?.identifiers ?? [];
    if (ids.length !== 1 || ids[0].type !== "dns") return this.problem(res, 400, "malformed", "one dns identifier");
    const authz: Authz = { id: this.nextId++, host: ids[0].value, status: "pending", token: randomBytes(32).toString("base64url") };
    this.authzs.set(authz.id, authz);
    const order: Order = { id: this.nextId++, host: ids[0].value, status: "pending", authz, certPem: null };
    this.orders.set(order.id, order);
    this.log.push("new-order");
    this.send(res, 201, JSON.stringify(this.orderBody(order)), { location: `${this.base}/order/${order.id}` });
  }

  private async finalize(res: ServerResponse, order: Order, payload: { csr?: string }): Promise<void> {
    if (order.authz.status !== "valid") return this.problem(res, 403, "orderNotReady", "authorization not valid");
    if (this.mode === "hold") {
      this.log.push("finalize:held");
      this.onHold?.();
      await new Promise<void>((resolve) => this.held.push(resolve));
    }
    try {
      const { certPem, host } = await this.ca.signCsr(payload?.csr ?? "", this.validity());
      if (host !== order.host) return this.problem(res, 400, "badCSR", "CSR names another host");
      order.certPem = certPem;
      order.status = "valid";
      this.log.push("issued");
    } catch (cause) {
      return this.problem(res, 400, "badCSR", String(cause));
    }
    this.send(res, 200, JSON.stringify(this.orderBody(order)));
  }

  private authzBody(authz: Authz) {
    const url = (type: string) => `${this.base}/chall/${authz.id}/${type}`;
    return {
      identifier: { type: "dns", value: authz.host },
      status: authz.status,
      challenges: ["http-01", "dns-01", "tls-alpn-01"].map((type) => ({ type, url: url(type), status: authz.status, token: authz.token })),
    };
  }

  private orderBody(order: Order): OrderBody {
    const body: OrderBody = {
      status: order.status === "valid" ? "valid" : order.authz.status === "valid" ? "ready" : "pending",
      identifiers: [{ type: "dns", value: order.host }],
      authorizations: [`${this.base}/authz/${order.authz.id}`],
      finalize: `${this.base}/order/${order.id}/finalize`,
    };
    if (order.certPem) body.certificate = `${this.base}/cert/${order.id}`;
    return body;
  }
}
