// Meta Muse harness — Meta's `muse` CLI over stdio (`muse serve`),
// on the Meta developer login (`muse login` OIDC device-code flow,
// ~/.config/muse/auth.json) or META_API_KEY. The generic protocol runtime
// lives in acp/core.ts; this file is only the per-harness quirks.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
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

/** The credential check as a named function, so the support entry and the
 * exported test surface are the same implementation, not a self-call. */
export function museIsAuthenticated(env: Record<string, string | undefined>): boolean {
  if (nonBlank(env.META_API_KEY)) return true;
  try {
    return existsSync(museAuthPath(env));
  } catch {
    return false;
  }
}

export function classifyMuseError(error: unknown): ProviderErrorCode | undefined {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = value.code;
  if (code === -32000) return "invalid_credentials";
  if (code === "AUTH_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED") {
    return "invalid_credentials";
  }
  if (code === "SUBSCRIPTION_INACTIVE") return "inactive_subscription";
  if (code === "QUOTA_EXCEEDED" || code === "REGION_RESTRICTED") return "quota_or_region_restriction";
  if (code === "UPSTREAM_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") return "upstream_outage";
  if (code === "MODEL_CATALOG_UNAVAILABLE") return "model_catalog_outage";
  return undefined;
}

const support: AcpSupport = {
  driverKind: "museAgent",
  displayName: "Meta Muse",
  rateLimits: true,
  // Fixed subscription catalog, like Gemini: no resolveModels, so boot never
  // pays for live local-inject probes for this engine.
  models: STATIC_MUSE_MODELS,
  effortLevels: ["low", "medium", "high", "xhigh"],
  defaultCli: museDefaultCli(),
  nativeSource: "muse.acp",
  loginNote: "Muse CLI is not signed in — run `muse login` in a terminal and complete the browser sign-in",
  install: {
    command: {
      darwin: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      linux: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      win32: 'wsl bash -c "curl -fsSL https://dev.meta.ai/install.sh | bash"',
    },
    docsUrl: "https://developer.meta.com/ai/products/muse-code/",
    signInCommand: "muse login",
  },
  transformEnv: (env) => {
    if (process.platform === "win32") withWslKeySharing(env);
  },
  spawnArgs: (_config, turn) => [
    "serve",
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.effort ? ["--reasoning-effort", turn.effort === "max" ? "ultra" : turn.effort] : []),
  ],
  credentialEnv: ["META_API_KEY"],
  pickAuthMethod: () => null,
  authFailure: "fail",
  isAuthenticated: museIsAuthenticated,
  requireAuthenticationBeforeSpawn: true,
  classifyError: classifyMuseError,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const MuseAgentDriver = createAcpDriver(support);
