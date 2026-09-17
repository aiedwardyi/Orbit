import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { applyCredentialAllowlist } from "./config.ts";
import type { RateLimitWindow } from "./contracts.ts";
import { acpChildEnv } from "./drivers/acp/core.ts";
import { grokSupport } from "./drivers/acp/grok.ts";
import { classifyMuseError, museDefaultCli, resolveWslMuseCli, withWslKeySharing } from "./drivers/acp/muse.ts";
import { antigravityRateLimitWindows, codexRateLimitWindows, grokRateLimitWindows, museUsageReport } from "./drivers/rate-limits.ts";
import { createMspChannel, MspRpcError } from "./drivers/msp/protocol.ts";
import { augmentedPath } from "./env-path.ts";
import { execCli, killCliTree, spawnCli } from "./procs.ts";
import { parseJson, type JsonValue } from "./schema.ts";

type Report = { windows: RateLimitWindow[]; observedAt: string };
type Result = { report?: Report; error?: string; retryAt: number };
type Options = { instanceId: string; cli?: string; environment?: NodeJS.ProcessEnv };
const text = z.string().min(1);
const percent = z.number().finite().nonnegative();
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const oauthWindow = z.object({ utilization: percent, resets_at: timestamp.nullable() });
const oauthUsage = z.object({ five_hour: oauthWindow.nullable(), seven_day: oauthWindow.nullable() });
const claudeStoredOauth = z.object({
  claudeAiOauth: z.object({ accessToken: text, refreshToken: text.optional(), expiresAt: z.number().finite().optional() }).passthrough(),
}).passthrough();
const claudeRefreshAnswer = z.object({
  access_token: text,
  refresh_token: text.optional(),
  expires_in: z.number().finite().positive().optional(),
}).passthrough();

/** Claude Code's public OAuth client id, hardcoded in the CLI itself (also
 * visible in the claude.ai/login redirect URL). Refreshing with it is the
 * same grant the CLI performs lazily on its next API call. */
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** Primary first, then the newer host: third-party tooling disagrees on
 * which is canonical, so both are tried rather than trusting one. */
const CLAUDE_TOKEN_ENDPOINTS = [
  "https://console.anthropic.com/v1/oauth/token",
  "https://platform.claude.com/v1/oauth/token",
];
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const rpcMessage = z.object({ id: z.number().optional(), method: z.string().optional(), result: z.json().optional(), error: z.object({ code: z.number() }).optional() });

export function usageRefreshResponse(instanceId: string, result: Result) {
  return { instanceId, report: result.report, error: result.error, retryAt: result.retryAt };
}

export function readUsageRpc(cli: string, env: NodeJS.ProcessEnv): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(cli, ["app-server"], { cwd: homedir(), env, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (value?: JsonValue, code?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      killCliTree(child);
      if (value !== undefined) resolve(value);
      else reject(new Error(code === 401 || code === 403 ? "signin" : "refresh"));
    };
    const send = (method: string, id?: number) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "initialize" ? { clientInfo: { name: "orbit", version: "1" } } : {} })}\n`); }
      catch { finish(); }
    };
    const timer = setTimeout(() => finish(), 15_000);
    child.stderr.resume();
    child.once("error", () => finish());
    child.once("exit", () => finish());
    lines.on("line", (line) => {
      try {
        const message = rpcMessage.parse(parseJson(line));
        if (message.id !== 1 && message.id !== 2) return;
        if (message.error) return finish(undefined, message.error.code);
        if (message.id === 1) { send("initialized"); send("account/rateLimits/read", 2); }
        else finish(message.result);
      } catch { finish(); }
    });
    send("initialize", 1);
  });
}

export function readGrokBillingRpc(cli: string, env: NodeJS.ProcessEnv): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const childEnv = acpChildEnv(grokSupport, { cli, fullAuto: false }, env);
    const child = spawnCli(cli, ["agent", "stdio"], { cwd: homedir(), env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (value?: JsonValue, code?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      killCliTree(child);
      if (value !== undefined) resolve(value);
      else reject(new Error(code === 401 || code === 403 ? "signin" : "refresh"));
    };
    const send = (method: string, id?: number, params = {}) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
      catch { finish(); }
    };
    const timer = setTimeout(() => finish(), 15_000);
    child.stderr.resume();
    child.once("error", () => finish());
    child.once("exit", () => finish());
    lines.on("line", (line) => {
      try {
        const message = rpcMessage.parse(parseJson(line));
        if (message.method && message.id !== undefined) {
          try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })}\n`); }
          catch { finish(); }
          return;
        }
        if (message.id !== 1 && message.id !== 2 && message.id !== 3) return;
        if (message.error) return finish(undefined, message.error.code);
        if (message.id === 1) {
          const methods = z.object({ authMethods: z.array(z.object({ id: z.string().optional() })).optional() }).catch({}).parse(message.result);
          if (methods.authMethods?.some((method) => method.id === "cached_token")) send("authenticate", 2, { methodId: "cached_token" });
          else finish(undefined, 401);
        } else if (message.id === 2) send("_x.ai/billing", 3);
        else finish(message.result);
      } catch { finish(); }
    });
    send("initialize", 1, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  });
}

const agyQuotaPaths = [
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
  "/exa.language_server_pb.LanguageServerService/GetUserStatus",
] as const;

/** Quota from `agy -p /usage --output-format stream-json`: the CLI prints a
 * structured `command_result` (plus a final `result`, same `command.data`)
 * without spending a token or needing the IDE open, so bars can appear
 * before any chat message. Returns the first `data` payload that reads as
 * quota windows; anything else (exec failure, unparseable output, empty
 * groups) is a refresh error, never signin — a logged-out CLI answers with
 * empty groups and exit 0, indistinguishable from "no quota to report". */
export function readAntigravityUsageCommand(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[]) => Promise<string | null> = (command, args) =>
    new Promise((resolve) => {
      execCli(
        command,
        args,
        { timeout: 20_000, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env, cwd: homedir() },
        (error, stdout) => resolve(error ? null : stdout),
      );
    }),
): Promise<JsonValue> {
  const usageData = (holder: unknown): unknown => {
    const command = holder && typeof holder === "object" ? ((holder as Record<string, unknown>).command as Record<string, unknown> | undefined) : undefined;
    if (!command || typeof command !== "object" || command.name !== "usage") return undefined;
    return command.data;
  };
  const dataOf = (message: unknown): unknown => {
    const record = message && typeof message === "object" ? (message as Record<string, unknown>) : null;
    if (!record) return undefined;
    // Only the two shapes seen live: the command_result line and the final
    // result's nested command. Anything else — another command's result, an
    // unnamed payload, a future shape — is ignored so a foreign data object
    // can never read as quota; unknown output falls through to the RPC leg.
    if (record.event === "command_result") return usageData(record);
    if (record.event === "result") {
      const result = record.result && typeof record.result === "object" ? record.result : null;
      return result ? usageData(result) : undefined;
    }
    return undefined;
  };
  return (async (): Promise<JsonValue> => {
    const out = await run(cli, ["-p", "/usage", "--output-format", "stream-json"]);
    if (!out) throw new Error("refresh");
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = parseJson(line);
      } catch {
        continue;
      }
      const data = dataOf(message);
      if (data !== undefined) {
        try {
          if (antigravityRateLimitWindows(data as JsonValue).length > 0) return data as JsonValue;
        } catch {
          continue;
        }
      }
    }
    throw new Error("refresh");
  })();
}

/** A 401/403 from the quota RPC names its cause: agy 1.2.2+ walls the
 * language server behind a per-boot CSRF secret (`x-codeium-csrf-token`)
 * that only the spawning IDE/CLI knows, so its missing/invalid-token
 * message is an unreachable endpoint — a refresh error — and must never
 * read as the user being signed out. Only those two exact messages match;
 * anything else keeps the legacy signin meaning. */
export function isCsrfRejection(body: string): boolean {
  let message = body.trim();
  try {
    const parsed = parseJson(body) as { message?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.message === "string") message = parsed.message.trim();
  } catch {
    // not JSON — match against the raw body
  }
  return /^(missing|invalid) CSRF token$/i.test(message);
}

/** Quota from the local Antigravity language server — the same
 * RetrieveUserQuotaSummary RPC behind agy's own `/usage`. The server only
 * exists while agy or the IDE runs, on a random loopback port behind a
 * self-signed cert, so candidates come from the process list and their
 * ports from the listener table; anything missing means "not running", a
 * refresh error rather than a signin one. Loopback only — `rejectUnauthorized: false`
 * is scoped to these calls, never global. Total work stays inside 15s.
 * Fallback only: the /usage command above answers without a running
 * server, and current agy walls this RPC behind CSRF (see
 * isCsrfRejection), so this path survives for older servers. */
export function readAntigravityQuotaRpc(cli: string, env: NodeJS.ProcessEnv): Promise<JsonValue> {
  const started = Date.now();
  const remaining = () => 15_000 - (Date.now() - started);
  const shellEnv = { ...process.env, ...env };
  const run = (command: string, args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { timeout: Math.max(1, remaining()), windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: shellEnv },
        (error, stdout) => resolve(error ? null : stdout),
      );
    });
  const post = (secure: boolean, port: number, path: string): Promise<{ status: number; json: JsonValue; body?: string } | null> =>
    new Promise((resolve) => {
      if (remaining() <= 0) {
        resolve(null);
        return;
      }
      const body = JSON.stringify({ ideName: "antigravity", extensionName: "antigravity", locale: "en", ideVersion: "unknown" });
      const options = {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "connect-protocol-version": "1", "content-length": Buffer.byteLength(body) },
      };
      const done = (response: IncomingMessage) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
          if (text.length > 4 * 1024 * 1024) {
            request.destroy();
            resolve(null);
          }
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status === 401 || status === 403) {
            resolve({ status, json: null, body: text });
            return;
          }
          try {
            resolve({ status, json: parseJson(text) });
          } catch {
            resolve(null);
          }
        });
      };
      const request = secure ? httpsRequest({ ...options, rejectUnauthorized: false }, done) : httpRequest(options, done);
      request.on("timeout", () => {
        request.destroy();
        resolve(null);
      });
      request.on("error", () => resolve(null));
      request.setTimeout(Math.max(1, remaining()));
      request.write(body);
      request.end();
    });
  return (async (): Promise<JsonValue> => {
    const base = cli.split(/[\\/]/).pop()?.trim() || "agy";
    const windows = process.platform === "win32";
    const listing = windows ? await run("tasklist", ["/FO", "CSV", "/NH"]) : await run("ps", ["-ax", "-o", "pid=,command="]);
    const pids = new Set<string>();
    if (listing) {
      for (const line of listing.split("\n")) {
        if (windows) {
          const cells = line.split('","');
          const name = (cells[0] ?? "").replace(/^"/, "").toLowerCase();
          const pid = cells[1] ?? "";
          if (/^\d+$/.test(pid) && (name.includes(base.toLowerCase()) || name.includes("language_server"))) pids.add(pid);
        } else {
          const match = line.trim().match(/^(\d+)\s+(.*)$/);
          if (!match) continue;
          const command = match[2];
          if (
            command.includes(base) ||
            /(^|\/)agy(\s|$)/.test(command) ||
            /antigravity-cli|antigravity_cli/.test(command) ||
            (/language_server|language-server/.test(command) && /antigravity/i.test(command))
          ) {
            if (pids.size < 5) pids.add(match[1]);
          }
        }
      }
    }
    if (pids.size === 0) throw new Error("refresh");
    const ports: number[] = [];
    if (windows) {
      const table = await run("netstat", ["-ano", "-p", "TCP"]);
      if (table) {
        for (const line of table.split("\n")) {
          const cells = line.trim().split(/\s+/);
          if (cells.length >= 4 && cells[3] === "LISTENING" && pids.has(cells[4] ?? "")) {
            const local = cells[1] ?? "";
            const port = Number(local.startsWith("127.0.0.1:") || local.startsWith("[::1]:") ? local.slice(local.lastIndexOf(":") + 1) : "");
            if (Number.isInteger(port) && port > 0 && !ports.includes(port) && ports.length < 4) ports.push(port);
          }
        }
      }
    } else {
      for (const pid of pids) {
        const open = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid]);
        if (!open) continue;
        for (const match of open.matchAll(/(?:127\.0\.0\.1|\[?::1\]?):(\d+)/g)) {
          const port = Number(match[1]);
          if (Number.isInteger(port) && port > 0 && !ports.includes(port) && ports.length < 4) ports.push(port);
        }
        if (ports.length >= 4) break;
      }
    }
    if (ports.length === 0) throw new Error("refresh");
    let auth = false;
    for (const port of ports) {
      if (remaining() <= 0) break;
      for (const secure of [true, false] as const) {
        const quota = await post(secure, port, agyQuotaPaths[0]);
        if (!quota) continue;
        if (quota.status === 401 || quota.status === 403) {
          if (!isCsrfRejection(quota.body ?? "")) auth = true;
          continue;
        }
        if (quota.status === 200 && antigravityRateLimitWindows(quota.json).length > 0) return quota.json;
        const status = await post(secure, port, agyQuotaPaths[1]);
        if (!status) continue;
        if (status.status === 401 || status.status === 403) {
          if (!isCsrfRejection(status.body ?? "")) auth = true;
          continue;
        }
        if (status.status === 200 && antigravityRateLimitWindows(status.json).length > 0) return status.json;
        break;
      }
    }
    throw new Error(auth ? "signin" : "refresh");
  })();
}

/** Antigravity quota for usage refresh: the /usage command first (no
 * running server needed, so bars can appear before any chat message),
 * the language-server RPC scrape as the fallback for older servers.
 * `deps` swaps either leg in tests. */
export function readAntigravityQuota(
  cli: string,
  env: NodeJS.ProcessEnv,
  deps: {
    usage?: typeof readAntigravityUsageCommand;
    rpc?: typeof readAntigravityQuotaRpc;
  } = {},
): Promise<JsonValue> {
  const usage = deps.usage ?? readAntigravityUsageCommand;
  const rpc = deps.rpc ?? readAntigravityQuotaRpc;
  return (async (): Promise<JsonValue> => {
    try {
      return await usage(cli, env);
    } catch {
      return rpc(cli, env);
    }
  })();
}

/** Read the stable MSP usage snapshot from a normal `muse serve` host. */
export async function readMuseUsage(
  cli = museDefaultCli(),
  env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() },
): Promise<JsonValue> {
  const childEnv = { ...env };
  applyCredentialAllowlist(childEnv, ["META_API_KEY"]);
  if (process.platform === "win32") withWslKeySharing(childEnv);
  const effectiveCli = process.platform === "win32" ? (await resolveWslMuseCli(cli, childEnv)) ?? cli : cli;
  const child = spawnCli(effectiveCli, ["serve"], { cwd: homedir(), env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  const channel = createMspChannel(child);
  let failed = false;
  child.once("error", () => {
    failed = true;
    channel.detach();
  });
  const request = (method: string, params: JsonValue | undefined) =>
    failed ? Promise.reject(new Error("refresh")) : channel.request(method, params, 15_000);
  return (async () => {
    try {
      await request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "orbit", version: "1.0.8" },
          capabilities: { userInputDialogs: false },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        },
      );
      channel.notify("initialized", {});
      return await request("usage/read", undefined) as JsonValue;
    } catch (error) {
      if (
        (error instanceof MspRpcError && (error.code === 401 || error.code === 403)) ||
        classifyMuseError(error) === "invalid_credentials"
      ) throw new Error("signin");
      throw new Error("refresh");
    } finally {
      channel.detach();
      killCliTree(child);
    }
  })();
}

const oauthErrorBody = z.object({ error: z.string().optional() }).passthrough();

/** Mint a fresh Claude access token from the stored refresh token.
 *
 * Throws "signin" only when the grant itself is dead (`invalid_grant` —
 * revoked, rotated away by another device: the user really is signed out)
 * and "refresh" for everything else, so a blip keeps the last report
 * instead of demanding a re-login. Other 4xx (`invalid_request`, an
 * unsupported grant shape, another client/server mismatch) and an
 * unparseable body stay transient: the stored grant may still be valid, so
 * they must never read as a logout. The next endpoint is tried only on 404,
 * which proves this host never saw the grant (host migration). Any other
 * outcome may already have consumed and rotated it server-side, so
 * replaying the same grant elsewhere is forbidden: a lost rotation would
 * come back `invalid_grant` and read as a false sign-out. */
async function refreshClaudeOauth(
  request: typeof fetch,
  refreshToken: string,
): Promise<z.infer<typeof claudeRefreshAnswer>> {
  for (const endpoint of CLAUDE_TOKEN_ENDPOINTS) {
    let response: Response;
    try {
      response = await request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error("refresh");
    }
    if (response.status === 404) continue;
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      if (oauthErrorBody.safeParse(body).data?.error === "invalid_grant") throw new Error("signin");
      throw new Error("refresh");
    }
    if (!response.ok) throw new Error("refresh");
    const parsed = claudeRefreshAnswer.safeParse(body);
    if (!parsed.success) throw new Error("refresh");
    return parsed.data;
  }
  throw new Error("refresh");
}

/** Write the minted tokens back to .credentials.json in the shape the CLI
 * reads, preserving every other key (scopes, subscriptionType, sibling
 * accounts). Returns whether the write landed: on failure the caller keeps
 * the minted rotation in memory, because the file still holds the now
 * consumed grant and redeeming it again would read as a false sign-out. */
async function persistClaudeOauth(
  write: (path: string, content: string) => Promise<void>,
  path: string,
  stored: unknown,
  minted: { access_token: string; refresh_token?: string; expires_in?: number },
  now: number,
): Promise<boolean> {
  try {
    const file = (stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>;
    const entry = (file.claudeAiOauth && typeof file.claudeAiOauth === "object" && !Array.isArray(file.claudeAiOauth)
      ? file.claudeAiOauth
      : {}) as Record<string, unknown>;
    await write(
      path,
      JSON.stringify({
        ...file,
        claudeAiOauth: {
          ...entry,
          accessToken: minted.access_token,
          refreshToken: minted.refresh_token ?? entry.refreshToken,
          ...(minted.expires_in ? { expiresAt: now + minted.expires_in * 1000 } : {}),
        },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Serialize tasks sharing one Claude credential file (normalized path), so
 * concurrent instances racing an expiry never redeem the same rotating
 * refresh token twice. The per-instance cache dedupes repeats of one
 * instance; this dedupes across instances. A rejected predecessor never
 * wedges the chain, and entries are dropped when their chain drains. */
function withCredentialLock<T>(locks: Map<string, Promise<unknown>>, path: string, task: () => Promise<T>): Promise<T> {
  const current = (locks.get(path) ?? Promise.resolve()).then(task, task);
  locks.set(path, current);
  const cleanup = () => {
    if (locks.get(path) === current) locks.delete(path);
  };
  void current.then(cleanup, cleanup);
  return current;
}

type ClaudeFileDeps = {
  request: typeof fetch;
  read: (path: string) => Promise<string>;
  write: (path: string, content: string) => Promise<void>;
  locks: Map<string, Promise<unknown>>;
  mintedByPath: Map<string, { accessToken: string; refreshToken: string }>;
  credentialsPath: string;
  now: number;
};

/** One Claude usage read against the file credential store: first attempt,
 * opportunistic heal, and the locked refresh section. Callers map a final
 * 401/403 to sign-in and other failures to a transient refresh error. */
async function readClaudeFileUsage(deps: ClaudeFileDeps): Promise<Response> {
  const { request, read, write, locks, mintedByPath, credentialsPath, now } = deps;
  const fetchUsage = (token: string) =>
    request(CLAUDE_USAGE_URL, { headers: [["Authorization", `Bearer ${token}`], ["anthropic-beta", "oauth-2025-04-20"]], redirect: "error", signal: AbortSignal.timeout(15_000) });
  const stored = parseJson(await read(credentialsPath));
  const storedOauth = claudeStoredOauth.parse(stored).claudeAiOauth;
  // A rotation whose persist failed last cycle: the file still holds the
  // consumed grant, so lead with the remembered tokens.
  const remembered = mintedByPath.get(credentialsPath);
  const accessToken = remembered?.accessToken ?? storedOauth.accessToken;
  let response = await fetchUsage(accessToken);
  if (response.ok && remembered) {
    // The remembered rotation still works. Heal the file when it is
    // unchanged since our read; when it moved on elsewhere the file wins
    // and the bridge is dropped — the file is the CLI-owned source of truth.
    await withCredentialLock(locks, credentialsPath, async () => {
      if (mintedByPath.get(credentialsPath) !== remembered) return;
      const raw: unknown = await read(credentialsPath).then(parseJson, () => null);
      const current = claudeStoredOauth.safeParse(raw).data?.claudeAiOauth;
      if (!current || current.accessToken !== storedOauth.accessToken || current.refreshToken !== storedOauth.refreshToken) {
        mintedByPath.delete(credentialsPath);
        return;
      }
      if (await persistClaudeOauth(write, credentialsPath, raw, { access_token: remembered.accessToken, refresh_token: remembered.refreshToken }, now)) {
        mintedByPath.delete(credentialsPath);
      }
    });
  }
  // Only 401 (invalid/expired token, RFC 6750 §3.1) justifies a mint. A 403
  // is insufficient scope: the minted token would carry the same scopes and
  // 403 again, so it goes straight to sign-in below without the round-trip.
  if (response.status === 401 && (storedOauth.refreshToken || remembered?.refreshToken)) {
    response = await withCredentialLock(locks, credentialsPath, async () => {
      const raw: unknown = await read(credentialsPath).then(parseJson, () => null);
      const reread = claudeStoredOauth.safeParse(raw).data?.claudeAiOauth;
      const live = mintedByPath.get(credentialsPath);
      // Tokens that appeared since our first attempt — a concurrent rotation
      // or an outside refresh — get one try each before minting again.
      for (const candidate of [reread?.accessToken, live?.accessToken]) {
        if (!candidate || candidate === accessToken) continue;
        const retry = await fetchUsage(candidate);
        if (retry.ok) {
          if (candidate !== reread?.accessToken && live && raw) {
            if (await persistClaudeOauth(write, credentialsPath, raw, { access_token: live.accessToken, refresh_token: live.refreshToken }, now)) {
              mintedByPath.delete(credentialsPath);
            }
          } else {
            mintedByPath.delete(credentialsPath);
          }
          return retry;
        }
      }
      // Mint with the live rotation first (the file grant may already be
      // consumed), then the file grant. A dead grant falls through to the
      // next candidate; anything transient aborts without burning grants.
      const grants = [...new Set([live?.refreshToken, reread?.refreshToken].filter((grant): grant is string => !!grant))];
      let exhausted: unknown = null;
      for (const grant of grants) {
        try {
          const minted = await refreshClaudeOauth(request, grant);
          if (raw && (await persistClaudeOauth(write, credentialsPath, raw, minted, now))) mintedByPath.delete(credentialsPath);
          else mintedByPath.set(credentialsPath, { accessToken: minted.access_token, refreshToken: minted.refresh_token ?? grant });
          return await fetchUsage(minted.access_token);
        } catch (error) {
          if (error instanceof Error && error.message === "signin" && grant !== grants[grants.length - 1]) {
            exhausted = error;
            continue;
          }
          throw error;
        }
      }
      // No grant was ever tested when the reread itself failed (file busy,
      // mid-replace): that is transient, never proof the user signed out.
      // A reread that parses but holds no grant, or an invalid_grant on a
      // tested one, means sign-in.
      if (exhausted instanceof Error) throw exhausted;
      throw new Error(reread ? "signin" : "refresh");
    });
  }
  return response;
}

export function createUsageRefresh(deps: {
  request?: typeof fetch;
  read?: (path: string) => Promise<string>;
  write?: (path: string, content: string) => Promise<void>;
  rpc?: typeof readUsageRpc;
  billing?: typeof readGrokBillingRpc;
  antigravity?: typeof readAntigravityQuota;
  muse?: typeof readMuseUsage;
  now?: () => number;
  platform?: NodeJS.Platform;
} = {}) {
  const request = deps.request ?? fetch;
  const read = deps.read ?? ((path: string) => readFile(path, "utf8"));
  // Atomic by default: a torn write would leave half-written JSON that the
  // next read treats as a missing login. The async wrapper turns the sync
  // helper's throws into rejections persistClaudeOauth already observes.
  const write = deps.write ?? (async (path: string, content: string) => { writeFileAtomic(path, content, { mode: 0o600 }); });
  const credentialLocks = new Map<string, Promise<unknown>>();
  const mintedByPath = new Map<string, { accessToken: string; refreshToken: string }>();
  const clock = deps.now ?? Date.now;
  const cache = new Map<string, { retryAt: number; pending: Promise<Result> }>();
  return async (driver: string, options: Options, previous?: Report): Promise<Result> => {
    const name = driver === "claudeAgent" ? "Claude" : driver === "codex" ? "Codex" : driver === "grokAgent" ? "Grok" : driver === "antigravityAgent" ? "Antigravity" : driver === "museAgent" ? "Muse" : undefined;
    if (!name) return { report: previous, error: "Usage refresh is not supported", retryAt: 0 };
    const cached = cache.get(options.instanceId);
    if (cached && clock() < cached.retryAt) return cached.pending;
    const retryAt = clock() + 30_000;
    const pending = (async (): Promise<Result> => {
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), ...options.environment };
        const home = env.HOME || env.USERPROFILE || homedir();
        let windows: RateLimitWindow[];
        let observedAt: string | undefined;
        if (driver === "codex") {
          const result = z.object({ rateLimits: z.json() }).parse(await (deps.rpc ?? readUsageRpc)(options.cli || "codex", env));
          windows = codexRateLimitWindows(result.rateLimits);
        } else if (driver === "grokAgent") {
          windows = grokRateLimitWindows(await (deps.billing ?? readGrokBillingRpc)(options.cli || "grok", env));
        } else if (driver === "antigravityAgent") {
          windows = antigravityRateLimitWindows(await (deps.antigravity ?? readAntigravityQuota)(options.cli || "agy", env), clock());
        } else if (driver === "museAgent") {
          const report = museUsageReport(await (deps.muse ?? readMuseUsage)(options.cli || museDefaultCli(), env));
          if (!report) throw new Error("refresh");
          windows = report.windows;
          observedAt = report.observedAt;
        } else {
          if ((deps.platform ?? process.platform) === "darwin" && !env.CLAUDE_CODE_OAUTH_TOKEN) return { report: previous, error: "Claude refresh skipped to avoid Keychain prompts on macOS", retryAt };
          // An env token has no refresh grant behind it, so it keeps the
          // old fail-closed read; the file store goes through the
          // refresh-aware helper (expired access token, cross-instance
          // locking, in-memory retention across a failed persist).
          const envToken = env.CLAUDE_CODE_OAUTH_TOKEN;
          let response: Response;
          if (envToken) {
            response = await request(CLAUDE_USAGE_URL, { headers: [["Authorization", `Bearer ${envToken}`], ["anthropic-beta", "oauth-2025-04-20"]], redirect: "error", signal: AbortSignal.timeout(15_000) });
          } else {
            const credentialsPath = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json");
            response = await readClaudeFileUsage({ request, read, write, locks: credentialLocks, mintedByPath, credentialsPath, now: clock() });
          }
          if (response.status === 401 || response.status === 403) throw new Error("signin");
          if (!response.ok) throw new Error("refresh");
          const usage = oauthUsage.parse(await response.json());
          windows = (["five_hour", "seven_day"] as const).flatMap((id) => {
            const window = usage[id];
            return window ? [{ id, usedPercent: window.utilization, resetsAt: window.resets_at ? Date.parse(window.resets_at) : null, windowMinutes: id === "five_hour" ? 300 : 10080 }] : [];
          });
        }
        if (!windows.length) throw new Error("refresh");
        const report = { windows, observedAt: observedAt ?? new Date(clock()).toISOString() };
        if (observedAt !== undefined && previous && Date.parse(report.observedAt) < Date.parse(previous.observedAt)) {
          return { report: previous, error: `Could not refresh ${name} limits`, retryAt };
        }
        return { report, retryAt };
      } catch (error) {
        return { report: previous, error: error instanceof Error && error.message === "signin" ? `Sign in again in ${name}` : `Could not refresh ${name} limits`, retryAt };
      }
    })();
    cache.set(options.instanceId, { retryAt, pending });
    return pending;
  };
}
