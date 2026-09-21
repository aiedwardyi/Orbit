// Opt-in phone access over the user's Tailscale tailnet.
//
// The harness is loopback-only by default: a non-loopback Host or Origin is
// rejected and every /api/* call needs the per-boot COMMS_TOKEN. Setting
// ORBIT_REMOTE_HOST to a tailnet hostname (served via Tailscale Serve)
// widens exactly three checks to that one hostname: the Host gate, the
// Origin gate, and /api/* auth, which also accepts a cookie minted by a
// one-time GET /remote?key=<remote key> handshake. The key is generated
// once, kept in DATA_DIR/remote-key.json, and never logged; setting
// ORBIT_REMOTE_ROTATE_KEY at boot regenerates it, invalidating old cookies.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { parseJson, type JsonValue } from "./schema.ts";

export const REMOTE_KEY_FILE = "remote-key.json";
export const REMOTE_COOKIE = "orbit_remote";
const REMOTE_KEY_RE = /^[a-f0-9]{64}$/;
const remoteKeyFileSchema = z.object({ key: z.string().regex(REMOTE_KEY_RE) });
// Anything a DNS hostname cannot contain; such a value fails closed to off.
const NOT_A_HOSTNAME = /[\s/:?#@[\]]/;

/** Tailnet hostname remote mode is bound to, or undefined when off. */
export function resolveRemoteHost(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.ORBIT_REMOTE_HOST?.trim().toLowerCase();
  if (!raw || NOT_A_HOSTNAME.test(raw)) return undefined;
  return raw;
}

/** Host-header hostname with any :port stripped; undefined when malformed. */
function stripPort(host: string): string | undefined {
  if (host.startsWith("[")) return undefined;
  const first = host.indexOf(":");
  if (first < 0) return host;
  if (first !== host.lastIndexOf(":") || !/^\d+$/.test(host.slice(first + 1))) return undefined;
  return host.slice(0, first);
}

/** Exact tailnet-hostname match on the Host header, ignoring any :port. */
export function hostMatchesRemote(host: string | undefined, remoteHost: string | undefined): boolean {
  if (!host || !remoteHost) return false;
  return stripPort(host.trim().toLowerCase()) === remoteHost;
}

/** Origin must be exactly https://<tailnet host>: cookies ignore ports, so no http or explicit port. */
export function originAllowedByRemote(origin: string | undefined | null, remoteHost: string | undefined): boolean {
  if (!origin || !remoteHost) return false;
  return origin.trim().toLowerCase() === `https://${remoteHost}`;
}

function storedKey(value: JsonValue): string | undefined {
  const parsed = remoteKeyFileSchema.safeParse(value);
  return parsed.success ? parsed.data.key : undefined;
}

/** Stable remote key, generated once and reused across boots. */
export function loadOrCreateRemoteKey(dataDir: string): string {
  const path = join(dataDir, REMOTE_KEY_FILE);
  try {
    const key = storedKey(parseJson(readFileSync(path, "utf8")));
    if (key) return key;
  } catch {
    // Missing, unreadable, or corrupt: fall through and mint a fresh key.
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32).toString("hex");
  writeFileAtomic(path, `${JSON.stringify({ key })}\n`, { mode: 0o600 });
  return key;
}

/** Constant-time handshake-key compare. */
export function remoteKeyMatches(provided: string | undefined | null, expected: string): boolean {
  if (!provided) return false;
  const got = Buffer.from(provided);
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Value of the remote cookie in a Cookie header, if present. */
export function remoteCookieValue(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === REMOTE_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Set-Cookie value minting remote access. */
export function buildRemoteSetCookie(key: string): string {
  return `${REMOTE_COOKIE}=${key}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** True when the request carries the remote cookie with the current key. */
export function remoteCookieAuthorized(cookieHeader: string | undefined, remoteKey: string | undefined): boolean {
  if (remoteKey === undefined) return false;
  return remoteKeyMatches(remoteCookieValue(cookieHeader), remoteKey);
}

/** /api/* accepts the boot token or, when remote mode is on, the cookie. */
export function apiRequestAuthorized(
  bearerOk: boolean,
  cookieHeader: string | undefined,
  remoteKey: string | undefined,
): boolean {
  return bearerOk || remoteCookieAuthorized(cookieHeader, remoteKey);
}

const FALSY_FLAG = new Set(["", "0", "false", "no", "off"]);

/** Resolves remote mode at boot, rotating the key on request; the log line never carries the key. */
export function initRemoteAccess(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  log: (line: string) => void = console.log,
): { host: string | undefined; key: string | undefined } {
  const host = resolveRemoteHost(env);
  if (host === undefined) return { host, key: undefined };
  const path = resolve(dataDir, REMOTE_KEY_FILE);
  if (!FALSY_FLAG.has(env.ORBIT_REMOTE_ROTATE_KEY?.trim().toLowerCase() ?? "")) rmSync(path, { force: true });
  const key = loadOrCreateRemoteKey(dataDir);
  log(`Remote mode on: https://${host}/remote?key=<redacted> (key in ${path})`);
  return { host, key };
}
