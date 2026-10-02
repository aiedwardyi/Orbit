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
// Unset, a running logged-in Tailscale supplies the hostname and its Serve
// rule instead; ORBIT_REMOTE_AUTO=0 turns that off. Never Funnel.
import { execFile } from "node:child_process";
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
  return cleanHost(env.ORBIT_REMOTE_HOST);
}

function cleanHost(value: string | undefined): string | undefined {
  const raw = value?.trim().toLowerCase();
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

export const REMOTE_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Set-Cookie value minting remote access. Max-Age so it outlives the phone browser. */
export function buildRemoteSetCookie(key: string): string {
  return `${REMOTE_COOKIE}=${key}; Path=/; Max-Age=${REMOTE_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`;
}

/** Full one-time phone link for this host, or undefined when remote mode is off. */
export function remoteLinkUrl(host: string | undefined, key: string | undefined): string | undefined {
  if (!host || !key) return undefined;
  return `https://${host}/remote?key=${key}`;
}

/** True when the request carries the remote cookie with the current key. */
export function remoteCookieAuthorized(cookieHeader: string | undefined, remoteKey: string | undefined): boolean {
  if (remoteKey === undefined) return false;
  return remoteKeyMatches(remoteCookieValue(cookieHeader), remoteKey);
}

const BEARER_ONLY_PATHS = new Set(["/api/internal/terminal-bridge"]);

/** /api/* accepts the boot token or, when remote mode is on, the cookie; bearer-only paths refuse the cookie. */
export function apiRequestAuthorized(
  bearerOk: boolean,
  cookieHeader: string | undefined,
  remoteKey: string | undefined,
  path = "",
): boolean {
  return bearerOk || (!BEARER_ONLY_PATHS.has(path) && remoteCookieAuthorized(cookieHeader, remoteKey));
}

const FALSY_FLAG = new Set(["", "0", "false", "no", "off"]);

/** Resolves remote mode at boot, rotating the key on request; the log line never carries the key. */
export function initRemoteAccess(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  log: (line: string) => void = console.log,
  host = resolveRemoteHost(env),
): { host: string | undefined; key: string | undefined } {
  if (host === undefined) return { host, key: undefined };
  const path = resolve(dataDir, REMOTE_KEY_FILE);
  if (!FALSY_FLAG.has(env.ORBIT_REMOTE_ROTATE_KEY?.trim().toLowerCase() ?? "")) rmSync(path, { force: true });
  const key = loadOrCreateRemoteKey(dataDir);
  log(`Remote mode on: https://${host}/remote?key=<redacted> (key in ${path})`);
  return { host, key };
}

/** stdout of a finished command; rejects with its stderr (or stdout) on failure. */
export type ExecText = (file: string, args: string[]) => Promise<string>;

const execText: ExecText = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const detail = `${stderr}`.trim() || `${stdout}`.trim() || error.message;
      reject(new Error(detail.replace(/\s+/g, " ").slice(0, 300)));
    });
  });

const tailscaleStatusSchema = z.object({
  BackendState: z.string(),
  Self: z.object({ DNSName: z.string() }).optional(),
});
const serveStatusSchema = z.object({
  TCP: z.record(z.string(), z.unknown()).optional(),
  Web: z.record(z.string(), z.object({
    Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).optional(),
  })).optional(),
});

function tailscaleCommands(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"] : ["tailscale"];
}

function proxiesToPort(proxy: string | undefined, port: number): boolean {
  const match = proxy?.match(/^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/);
  return Number(match?.[1]) === port;
}

/** Tailnet host from a running Tailscale, with 443 served to this port; undefined leaves remote off. */
export async function autoRemoteHost(
  env: NodeJS.ProcessEnv,
  port: number,
  exec: ExecText = execText,
  log: (line: string) => void = console.log,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const auto = env.ORBIT_REMOTE_AUTO?.trim().toLowerCase();
  if (env.ORBIT_REMOTE_HOST?.trim() || (auto !== undefined && FALSY_FLAG.has(auto))) return undefined;
  let command: string | undefined;
  let status: z.infer<typeof tailscaleStatusSchema> | undefined;
  for (const candidate of tailscaleCommands(platform)) {
    try {
      status = tailscaleStatusSchema.parse(parseJson(await exec(candidate, ["status", "--json"])));
      command = candidate;
      break;
    } catch {
      // Not on PATH, daemon down, or unreadable: try the next location.
    }
  }
  if (!command || !status) {
    log("Remote auto: Tailscale not found, remote off");
    return undefined;
  }
  const host = cleanHost(status.Self?.DNSName.replace(/\.$/, ""));
  if (status.BackendState !== "Running" || !host) {
    log(`Remote auto: Tailscale not logged in (${status.BackendState}), remote off`);
    return undefined;
  }
  try {
    const serve = serveStatusSchema.parse(parseJson((await exec(command, ["serve", "status", "--json"])).trim() || "{}"));
    const web = serve.Web?.[`${host}:443`];
    if (proxiesToPort(web?.Handlers?.["/"]?.Proxy, port)) return host;
    if (web || serve.TCP?.["443"] !== undefined) {
      log(`Remote auto: ${host}:443 already serves something else, remote off`);
      return undefined;
    }
    await exec(command, ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
    return host;
  } catch (error) {
    log(`Remote auto: tailscale serve failed, remote off: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
