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
  // XDG_CONFIG_HOME already includes the muse segment; HOME fallback does too.
  return env.XDG_CONFIG_HOME ? join(dir, "muse", "auth.json") : join(dir, "auth.json");
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
  defaultCli: "muse",
  nativeSource: "muse.acp",
  loginNote: "Muse CLI is not signed in — run `muse login` in a terminal and complete the browser sign-in",
  install: {
    command: {
      darwin: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      linux: "curl -fsSL https://dev.meta.ai/install.sh | bash",
      win32: "curl -fsSL https://dev.meta.ai/install.sh | bash",
    },
    docsUrl: "https://developer.meta.com/ai/products/muse-code/",
    signInCommand: "muse login",
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
