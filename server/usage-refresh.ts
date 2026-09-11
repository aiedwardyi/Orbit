import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

import type { RateLimitWindow } from "./contracts.ts";
import { codexRateLimitWindows } from "./drivers/rate-limits.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { parseJson, type JsonValue } from "./schema.ts";

type Report = { windows: RateLimitWindow[]; observedAt: string };
type Result = { report?: Report; error?: string; retryAt: number };
type Options = { instanceId: string; cli?: string; environment?: NodeJS.ProcessEnv };
const text = z.string().min(1);
const percent = z.number().finite().nonnegative();
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const oauthWindow = z.object({ utilization: percent, resets_at: timestamp.nullable() });
const oauthUsage = z.object({ five_hour: oauthWindow.nullable(), seven_day: oauthWindow.nullable() });
const billing = z.object({ config: z.object({ creditUsagePercent: percent, currentPeriod: z.object({ type: z.literal("USAGE_PERIOD_TYPE_WEEKLY"), end: timestamp }) }) });
const rpcMessage = z.object({ id: z.number().optional(), result: z.json().optional(), error: z.object({ code: z.number() }).optional() });

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

export function createUsageRefresh(deps: {
  request?: typeof fetch;
  read?: (path: string) => Promise<string>;
  rpc?: typeof readUsageRpc;
  now?: () => number;
  platform?: NodeJS.Platform;
} = {}) {
  const request = deps.request ?? fetch;
  const read = deps.read ?? ((path: string) => readFile(path, "utf8"));
  const clock = deps.now ?? Date.now;
  const cache = new Map<string, { retryAt: number; pending: Promise<Result> }>();
  return async (driver: string, options: Options, previous?: Report): Promise<Result> => {
    const name = driver === "claudeAgent" ? "Claude" : driver === "codex" ? "Codex" : driver === "grokAgent" ? "Grok" : undefined;
    if (!name) return { report: previous, error: "Usage refresh is not supported", retryAt: 0 };
    const cached = cache.get(options.instanceId);
    if (cached && clock() < cached.retryAt) return cached.pending;
    const retryAt = clock() + 30_000;
    const pending = (async (): Promise<Result> => {
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), ...options.environment };
        const home = env.HOME || env.USERPROFILE || homedir();
        let windows: RateLimitWindow[];
        if (driver === "codex") {
          const result = z.object({ rateLimits: z.json() }).parse(await (deps.rpc ?? readUsageRpc)(options.cli || "codex", env));
          windows = codexRateLimitWindows(result.rateLimits);
        } else {
          let url: string;
          let headers: Array<[string, string]>;
          if (driver === "claudeAgent") {
            if ((deps.platform ?? process.platform) === "darwin" && !env.CLAUDE_CODE_OAUTH_TOKEN) return { report: previous, error: "Claude refresh skipped to avoid Keychain prompts on macOS", retryAt };
            const token = env.CLAUDE_CODE_OAUTH_TOKEN || z.object({ claudeAiOauth: z.object({ accessToken: text }) }).parse(parseJson(await read(join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json")))).claudeAiOauth.accessToken;
            url = "https://api.anthropic.com/api/oauth/usage";
            headers = [["Authorization", `Bearer ${token}`], ["anthropic-beta", "oauth-2025-04-20"]];
          } else {
            const auth = z.record(z.string(), z.json()).parse(parseJson(await read(join(env.GROK_HOME || join(home, ".grok"), "auth.json"))));
            const entry = Object.entries(auth).find(([key]) => key.includes("auth.x.ai::"));
            const token = z.object({ key: text, user_id: text }).parse(entry?.[1]);
            url = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
            headers = [["Authorization", `Bearer ${token.key}`], ["X-XAI-Token-Auth", "xai-grok-cli"], ["x-userid", token.user_id]];
          }
          const response = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
          if (response.status === 401 || response.status === 403) throw new Error("signin");
          if (!response.ok) throw new Error("refresh");
          const payload = await response.json();
          if (driver === "claudeAgent") {
            const usage = oauthUsage.parse(payload);
            windows = (["five_hour", "seven_day"] as const).flatMap((id) => {
              const window = usage[id];
              return window ? [{ id, usedPercent: window.utilization, resetsAt: window.resets_at ? Date.parse(window.resets_at) : null, windowMinutes: id === "five_hour" ? 300 : 10080 }] : [];
            });
          } else {
            const { config } = billing.parse(payload);
            windows = [{ id: "seven_day", usedPercent: config.creditUsagePercent, resetsAt: Date.parse(config.currentPeriod.end), windowMinutes: 10080 }];
          }
        }
        if (!windows.length) throw new Error("refresh");
        return { report: { windows, observedAt: new Date(clock()).toISOString() }, retryAt };
      } catch (error) {
        return { report: previous, error: error instanceof Error && error.message === "signin" ? `Sign in again in ${name}` : `Could not refresh ${name} limits`, retryAt };
      }
    })();
    cache.set(options.instanceId, { retryAt, pending });
    return pending;
  };
}
