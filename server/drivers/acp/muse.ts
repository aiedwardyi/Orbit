// Meta Muse harness — Meta's `muse` CLI over stdio (`muse serve`),
// on the Meta developer login (`muse login` OIDC device-code flow,
// ~/.config/muse/auth.json) or META_API_KEY. The generic protocol runtime
// lives in acp/core.ts; this file is only the per-harness quirks.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { augmentedPath, resolveCliSpawn } from "../../env-path.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const STATIC_MUSE_MODELS: ModelCatalog = {
  default: "muse-spark-1.3",
  options: [
    { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
    { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
  ],
};

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

function museConfigDir(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return env.XDG_CONFIG_HOME || join(home, ".config", "muse");
}

function museAuthPath(env: Record<string, string | undefined>): string {
  const dir = museConfigDir(env);
  // XDG_CONFIG_HOME names the config root only; the muse segment is appended
  // here, while the HOME fallback already includes it.
  return env.XDG_CONFIG_HOME ? join(dir, "muse", "auth.json") : join(dir, "auth.json");
}

/** Spawn command for this platform. There is no native Windows `muse`
 * binary — the official installer is a POSIX shell script and Windows
 * integrations launch it from WSL — so on win32 the CLI is the `wsl muse`
 * wrapper string, which resolveCliSpawn splits into wsl.exe + fixed args
 * with no shell. stdio pipes through wsl.exe untouched, so the stdio
 * protocol runtime is unchanged. Verified on Linux/macOS only: no win32
 * runner was available here, so the wsl.exe hop itself is assumed from the
 * documented WSL launch path, not observed. */
export function museDefaultCli(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "wsl muse" : "muse";
}

/** Share META_API_KEY across the WSL boundary. wsl.exe forwards only
 * WSLENV-listed names into Linux, so without this the key advertised in
 * credentialEnv would silently never reach muse on Windows. */
export function withWslKeySharing(env: Record<string, string | undefined>): void {
  if (!nonBlank(env.META_API_KEY)) return;
  const current = env.WSLENV?.split(":").filter(Boolean) ?? [];
  if (!current.includes("META_API_KEY")) env.WSLENV = [...current, "META_API_KEY"].join(":");
}

/** Interactive sign-in for this platform. There is no native Windows `muse`
 * binary, so win32 runs the login inside WSL — the same Linux home the
 * engine process reads (see the auth probe below). */
export function museSignInCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "wsl muse login" : "muse login";
}

/** win32 auto-detect for an explicitly-configured bare CLI. There is no
 * native Windows `muse` binary, so a bare `muse` override can never answer
 * natively — retry it through the wrapper instead of asking the user for a
 * filepath. An already-wrapped CLI yields null (nothing to fall back to). */
export function museWslFallbackCli(cli: string): string | null {
  return /^\s*wsl(\.exe)?(\s|$)/i.test(cli) ? null : `wsl ${cli.trim()}`;
}

/** The WSL-side bare name this resolver understands. Only exactly `muse`,
 * bare or behind the `wsl` wrapper: a custom path or wrapper string is the
 * user's explicit spelling and is probed as-is, never reinterpreted. */
function wslMuseName(cli: string): string | null {
  if (/^muse$/i.test(cli.trim())) return "muse";
  return /^\s*wsl(\.exe)?\s+muse\s*$/i.test(cli) ? "muse" : null;
}

/** Resolve `muse` inside WSL to an absolute Linux path (`wsl /abs/path`).
 *
 * `wsl muse` runs without a login shell, so ~/.profile never applies and
 * ~/.local/bin — the installer default — is missing: the probe AND every
 * turn fail with `muse: command not found` while the user's interactive
 * terminal works fine. A login shell sees the real PATH, so `command -v`
 * through `bash -lc` finds it (verified live: 0.14s warm). The absolute
 * path is then used for both the --version probe and turn spawns — no shell
 * at spawn, so no rc-file echo can pollute the ACP stdio stream and no
 * per-turn shell startup is paid. Exactly one absolute line is accepted;
 * anything else (missing binary, chatty profile, broken shell) fails closed
 * to null and the engine reads as unavailable, same as before. `run` is
 * injectable so the parsing is unit-testable off Windows. */
export function resolveWslMuseCli(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execFile = execFile,
): Promise<string | null> {
  const name = wslMuseName(cli);
  if (!name) return Promise.resolve(null);
  const { command, args } = resolveCliSpawn("wsl", ["bash", "-lc", `command -v ${name}`]);
  return new Promise((resolve) => {
    run(command, args, { timeout: 15_000, windowsHide: true, encoding: "utf8", env }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const hits = String(stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\/[^\s]+$/.test(line));
      resolve(hits.length === 1 ? `wsl ${hits[0]}` : null);
    });
  });
}

/** Absolute wsl.exe: a GUI-launched process can inherit a PATH without
 * System32, in which case no PATH search — augmented or otherwise — finds
 * it. Off win32 the name is left bare; the spawn fails and reads as logged
 * out, same as before. */
function wslExePath(): string {
  return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe") : "wsl.exe";
}

/** Probe the WSL-side login on win32. wsl.exe forwards almost nothing from
 * the Windows environment, so the Linux `muse` process reads the Linux
 * home — where a WSL-side `muse login` wrote auth.json — while orbit's own
 * check reads the Windows HOME. Exit 0 from `test -f` is the whole answer;
 * anything else (no WSL, cold-boot timeout, missing file) reads as logged
 * out. The spawn env carries the augmented PATH (System32 first) rather
 * than the inherited GUI one. Sync because the support shape is
 * sync-invoked and the snapshot path already awaits it; the 10s bound caps
 * a cold WSL boot. */
export function probeWslMuseAuth(env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() }): boolean {
  try {
    execFileSync(wslExePath(), ["sh", "-c", 'test -f "${XDG_CONFIG_HOME:-$HOME/.config}/muse/auth.json"'], {
      stdio: "ignore",
      timeout: 10_000,
      env,
    });
    return true;
  } catch {
    return false;
  }
}

/** The credential check as a named function, so the support entry and the
 * exported test surface are the same implementation, not a self-call. */
export function museIsAuthenticated(
  env: Record<string, string | undefined>,
  _config?: unknown,
  overrides?: { platform?: NodeJS.Platform; probeWslAuth?: (probeEnv: NodeJS.ProcessEnv) => boolean },
): boolean {
  if (nonBlank(env.META_API_KEY)) return true;
  // On win32 the engine is a Linux process: only the key and the WSL-side
  // login count. A Windows-side auth.json can never satisfy it, so it is
  // never accepted there — a stale copy would otherwise read as signed in
  // while every turn fails. The probe inherits the augmented PATH, not the
  // possibly System32-less GUI one.
  if ((overrides?.platform ?? process.platform) === "win32") {
    try {
      return (overrides?.probeWslAuth ?? probeWslMuseAuth)({ ...env, PATH: augmentedPath() });
    } catch {
      return false;
    }
  }
  try {
    return existsSync(museAuthPath(env));
  } catch {
    return false;
  }
}

function classifyMuseCode(code: string | undefined): ProviderErrorCode | undefined {
  if (code === "AUTH_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED") {
    return "invalid_credentials";
  }
  if (code === "SUBSCRIPTION_INACTIVE") return "inactive_subscription";
  if (code === "QUOTA_EXCEEDED" || code === "REGION_RESTRICTED") return "quota_or_region_restriction";
  if (code === "UPSTREAM_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") return "upstream_outage";
  if (code === "MODEL_CATALOG_UNAVAILABLE") return "model_catalog_outage";
  return undefined;
}

/** The provider's own code rides inside the -32000 envelope (data.code or
 * data.error.code); read it before falling back, so a quota envelope never
 * reads as bad credentials. */
function providerCodeFromEnvelope(data: unknown): string | undefined {
  const outer = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!outer) return undefined;
  if (typeof outer.code === "string" && outer.code) return outer.code;
  const nested = outer.error;
  if (nested && typeof nested === "object") {
    const record = nested as Record<string, unknown>;
    const code = record.code ?? record.type;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

export function classifyMuseError(error: unknown): ProviderErrorCode | undefined {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = value.code;
  if (code === -32000) {
    return classifyMuseCode(providerCodeFromEnvelope(value.data)) ?? "invalid_credentials";
  }
  return classifyMuseCode(typeof code === "string" ? code : undefined);
}

const support: AcpSupport = {
  driverKind: "museAgent",
  displayName: "Meta Muse",
  rateLimits: true,
  // Fixed subscription catalog, like Gemini: no resolveModels, so boot never
  // pays for live local-inject probes for this engine.
  models: STATIC_MUSE_MODELS,
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  defaultCli: museDefaultCli(),
  nativeSource: "muse.acp",
  loginNote: `Muse CLI is not signed in — run \`${museSignInCommand()}\` in a terminal and complete the browser sign-in`,
  install: {
    command: {
      darwin: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      linux: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      win32: 'wsl bash -c "curl -fsSL https://dev.meta.ai/install.sh | bash"',
    },
    docsUrl: "https://developer.meta.com/ai/products/muse-code/",
    signInCommand: museSignInCommand(),
  },
  transformEnv: (env) => {
    if (process.platform === "win32") withWslKeySharing(env);
  },
  // `muse serve` takes no --model/--reasoning-effort (1.2.1 serve --help:
  // sandbox + --no-session-log only); they exit 2. Model/effort ride MSP
  // session/start + turn/start, unreachable from this ACP core: drop flags.
  spawnArgs: () => ["serve"],
  credentialEnv: ["META_API_KEY"],
  // The harness advertises no ACP authMethods (verified against live `muse
  // serve` initialize), so there is no method to pick: the META_API_KEY /
  // stored login is the whole credential. "continue" lets an ambiently
  // authenticated session reach session/new; "fail" would throw loginNote
  // on every turn even with a valid login.
  pickAuthMethod: () => null,
  authFailure: "continue",
  wslProbeWrapper: museWslFallbackCli,
  wslResolveCli: resolveWslMuseCli,
  // Session cwd and MCP server commands cross into WSL as Linux paths. Known
  // limit: MCP server env beyond META_API_KEY and non-command paths do not
  // cross, so integrations depending on them are unavailable to
  // WSL-crossing Meta turns on Windows; normal turns are unaffected.
  wslPathTranslation: true,
  isAuthenticated: museIsAuthenticated,
  requireAuthenticationBeforeSpawn: true,
  classifyError: classifyMuseError,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const MuseAgentDriver = createAcpDriver(support);
