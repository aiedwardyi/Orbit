// Rules for requests that arrived through the phone relay (docs/phone-relay-design.md
// section 9). Transport comes from socket identity (isRelayRequest), never a header;
// relay traffic authenticates only with its __Host-wink_phone session.
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";

import type { PhoneRelayState } from "../shared/relay-protocol.ts";

export const PHONE_COOKIE = "__Host-wink_phone";
/** 400 days, the browser cap; the server re-sets it weekly and expires idle phones itself. */
export const PHONE_COOKIE_MAX_AGE_S = 34_560_000;

/** Routes that only the PC itself may use. */
const LOCAL_ONLY_EXACT = new Set(["/api/mailbox", "/remote", "/api/remote-link"]);
const LOCAL_ONLY_PREFIXES = ["/api/internal/", "/api/phone-relay/", "/api/phone/"];

export interface RelayRequestLine {
  method?: string;
  url?: string;
  rawHeaders: string[];
}

export type RelayVerdict =
  | { kind: "deny"; status: 400 | 403 | 404; error: string }
  | { kind: "health" }
  | { kind: "pair-page" }
  | { kind: "pair" }
  | { kind: "app" };

function headerValues(rawHeaders: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]!.toLowerCase() === name) values.push(rawHeaders[i + 1]!);
  }
  return values;
}

function localOnly(path: string): boolean {
  if (LOCAL_ONLY_EXACT.has(path) || path === "/api/internal" || path === "/api/phone-relay") return true;
  return path !== "/api/phone/pair" && LOCAL_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Host, Origin and route decision for one relay request, before any session check. */
export function relayVerdict(req: RelayRequestLine, relayHost: string): RelayVerdict {
  const target = req.url ?? "";
  // WHATWG URL reads "\" as "/" and throws on an empty authority, so only a plain path gets past here.
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return { kind: "deny", status: 400, error: "bad request" };
  const hosts = headerValues(req.rawHeaders, "host");
  if (hosts.length > 1) return { kind: "deny", status: 400, error: "bad request" };
  if (hosts[0]?.trim().toLowerCase() !== relayHost) return { kind: "deny", status: 403, error: "forbidden: relay host required" };
  const method = req.method ?? "GET";
  const origins = headerValues(req.rawHeaders, "origin");
  if (origins.length > 1 || (origins.length === 1 && origins[0] !== `https://${relayHost}`)) {
    return { kind: "deny", status: 403, error: "forbidden: cross-origin request" };
  }
  const read = method === "GET" || method === "HEAD";
  if (!origins.length && !read) return { kind: "deny", status: 403, error: "forbidden: origin required" };
  const path = new URL(target, "https://relay.invalid").pathname;
  if (localOnly(path)) return { kind: "deny", status: 404, error: "not found" };
  if (path === "/api/health" && read) return { kind: "health" };
  if (path === "/pair" && read) return { kind: "pair-page" };
  if (path === "/api/phone/pair") return method === "POST" ? { kind: "pair" } : { kind: "deny", status: 404, error: "not found" };
  return { kind: "app" };
}

/** An app page (not a file) that an unpaired phone should see as the pair page instead. */
export function shellNavigation(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (path === "/" || path === "/index.html") return true;
  return !/\.[A-Za-z0-9]+$/.test(path);
}

export function phoneSetCookie(token: string): string {
  return `${PHONE_COOKIE}=${token}; Path=/; Max-Age=${PHONE_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`;
}

/** The phone token, or null when absent, empty or sent more than once. */
export function phoneCookieToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const found: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0 && part.slice(0, eq).trim() === PHONE_COOKIE) found.push(part.slice(eq + 1).trim());
  }
  return found.length === 1 && found[0] ? found[0] : null;
}

/** Relay traffic never uses the boot token or the tailnet cookie; local traffic never uses a phone session. */
export function requestCredentials(relay: boolean, phoneSession: boolean, bearerOk: boolean, remoteKey: string | undefined) {
  return relay ? { bearerOk: false, remoteKey: undefined, phoneSession } : { bearerOk, remoteKey, phoneSession: false };
}

/** The VPS SSH viewer is loopback-only: refuse phones, including every relay request. */
export function refuseVpsJoin(headers: IncomingHttpHeaders, relay: boolean): boolean {
  return relay || headers["x-openmausbot-companion"] === "1";
}

/** Token bucket per key, for pairing attempts. The key map is bounded; the oldest key goes first. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly burst: number;
  private readonly perMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(burst: number, windowMs: number, now: () => number, maxKeys = 4096) {
    this.burst = burst;
    this.perMs = burst / windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  take(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
      bucket = { tokens: this.burst, at: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.at) * this.perMs);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

/** Rate-limit key for the relay's reported phone address: IPv4 as is, IPv6 by /64. */
export function rateKey(peer: string | null): string {
  if (!peer) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(peer);
  if (mapped) return mapped[1]!;
  if (isIP(peer) !== 6) return peer;
  const [head = "", tail] = peer.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** A relay error fit for Settings: no tickets, invites, tokens or long opaque strings. */
export function safeRelayError(text: string | null): string | null {
  if (text === null) return null;
  return text
    .replace(/\bwk[a-z0-9]{1,3}[._][A-Za-z0-9._-]*/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]")
    .slice(0, 200);
}

export type RelayProblem = "superseded" | "revoked" | "ticket-expired" | "unknown-certificate";

/** Starts every CtWatch alert. Kept here so the harness can match it without loading the relay client. */
export const CT_ALERT_PREFIX = "CT log shows";

/** Problems that need the user, from the client's status text. */
export function relayProblem(state: PhoneRelayState, lastError: string | null): RelayProblem | null {
  if (!lastError) return null;
  if (lastError.startsWith(CT_ALERT_PREFIX)) return "unknown-certificate";
  if (state !== "rejected") return null;
  if (lastError.startsWith("superseded:")) return "superseded";
  if (lastError.startsWith("revoked:")) return "revoked";
  if (lastError.startsWith("ticket expired")) return "ticket-expired";
  return null;
}
