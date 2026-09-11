// The maintained OpenCode CLI through its ACP stdio interface. OpenCode is
// the harness; Zen, Go, OpenRouter, and user-configured/local providers are
// models discovered from that harness rather than separate OpenMaus drivers.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { applyCredentialAllowlist } from "../../config.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const CREDENTIAL_ENV = ["OPENCODE_API_KEY"] as const;

const STATIC_MODELS: ModelCatalog = {
  default: "opencode/x-preview-f-free",
  options: [
    {
      id: "opencode/x-preview-f-free",
      label: "Zen · Ox Alpha Free",
      contextWindow: 1_000_000,
    },
  ],
};

let lastSuccessfulCatalog: ModelCatalog | null = null;
const MODEL_PROBE_TTL_MS = 30_000;
const modelProbeCache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();

export type OpenCodeCatalogLoader = (
  environment: Record<string, string | undefined>,
  cli: string,
) => Promise<ModelCatalog>;

function labelForModel(id: string): string {
  return id
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerLabel(id: string): string {
  if (id === "opencode") return "Zen";
  if (id === "opencode-go") return "Go";
  if (id === "openrouter") return "OpenRouter";
  return labelForModel(id);
}

function validModelSlug(value: string): boolean {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1 || /\s/u.test(value)) return false;
  return [...value].every((character) => (character.codePointAt(0) ?? 0) > 0x1f);
}

function localModelRecord(record: Record<string, unknown>): boolean {
  const api = record.api && typeof record.api === "object" && !Array.isArray(record.api)
    ? record.api as Record<string, unknown>
    : {};
  if (typeof api.url !== "string") return false;
  try {
    const host = new URL(api.url).hostname.replace(/^\[|\]$/gu, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Parse the authoritative inventory printed by the installed OpenCode CLI.
 *
 * `models --verbose` is a sequence of `provider/model` header lines followed
 * by one JSON object. Model IDs can themselves contain `/` (OpenRouter), so
 * only the first separator identifies the provider. Older CLIs may print just
 * the headers; those still produce a usable catalog without metadata. */
export function parseOpenCodeModelsOutput(stdout: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let slug: string | null = null;
  let jsonLines: string[] = [];

  const flush = () => {
    if (!slug || seen.has(slug)) return;
    const separator = slug.indexOf("/");
    const provider = slug.slice(0, separator);
    const model = slug.slice(separator + 1);
    let record: Record<string, unknown> = {};
    const raw = jsonLines.join("\n").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          record = parsed as Record<string, unknown>;
        }
      } catch {
        // A header-only/older CLI remains useful; fall back to the model id.
      }
    }
    if (record.status === "deprecated") return;
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : labelForModel(model);
    const limit = record.limit && typeof record.limit === "object" && !Array.isArray(record.limit)
      ? record.limit as Record<string, unknown>
      : {};
    const contextWindow = typeof limit.context === "number" && Number.isFinite(limit.context) && limit.context > 0
      ? Math.floor(limit.context)
      : undefined;
    seen.add(slug);
    options.push({
      id: slug,
      label: `${providerLabel(provider)} · ${name}`,
      ...(localModelRecord(record) ? { custom: true, loaded: true } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    });
  };

  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (line === trimmed && validModelSlug(trimmed)) {
      flush();
      slug = trimmed;
      jsonLines = [];
      continue;
    }
    if (slug) jsonLines.push(line);
  }
  flush();

  if (!options.length) return null;
  const preferred = options.find((option) => option.id === STATIC_MODELS.default);
  return { default: (preferred ?? options[0]!).id, options };
}

function runOpenCodeModels(
  cli: string,
  environment: Record<string, string | undefined>,
  verbose: boolean,
): Promise<string> {
  const childEnv = { ...environment };
  applyCredentialAllowlist(childEnv, CREDENTIAL_ENV);
  return new Promise((resolve, reject) => {
    execCli(
      cli,
      ["models", ...(verbose ? ["--verbose"] : [])],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: childEnv },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Ask the same OpenCode binary that will run ACP for its effective catalog.
 * This automatically includes Zen, Go, other connected providers, custom
 * config, and anonymous free models with the exact IDs the session accepts. */
export async function discoverOpenCodeModels(
  environment: Record<string, string | undefined>,
  cli = "opencode",
): Promise<ModelCatalog> {
  try {
    const catalog = parseOpenCodeModelsOutput(await runOpenCodeModels(cli, environment, true));
    if (!catalog) throw new Error("OpenCode returned no usable models");
    lastSuccessfulCatalog = catalog;
    return catalog;
  } catch {
    return lastSuccessfulCatalog ?? STATIC_MODELS;
  }
}

export function resetOpenCodeModelCache() {
  lastSuccessfulCatalog = null;
  modelProbeCache.clear();
}

/** Compatibility export for older tests/imports while the product migrates
 * from the Go-only name. */
export const resetOpenCodeGoModelCache = resetOpenCodeModelCache;

const stripForeignProviderKeys = (env: Record<string, string | undefined>) => {
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
  ]) delete env[key];
};

function opencodeConfigDir(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

type PermissionAction = "allow" | "ask" | "deny";
type PermissionRule = PermissionAction | Map<string, PermissionAction>;

const PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"]);
const JSONC_COMMENT = /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu;
const JSONC_TRAILING_COMMA = /("(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/gu;
const WILDCARD_SPECIAL = /[.+^${}()|[\]\\]/gu;

const realCwd = (cwd: string) => existsSync(cwd) ? realpathSync.native(cwd) : resolve(cwd);

/** Config files OpenCode 1.18.30 merges below the inline content, lowest first. */
function permissionFiles(env: Record<string, string | undefined>, cwd: string | undefined): string[] {
  const dirs: string[] = [];
  if (cwd && !/^(1|true)$/iu.test(env.OPENCODE_DISABLE_PROJECT_CONFIG ?? "")) {
    // Project config walks up from the real cwd and stops at the git root, or at the filesystem root outside a repo.
    for (let dir = realCwd(cwd); ; dir = dirname(dir)) {
      dirs.push(dir);
      if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
    }
  }
  const home = env.HOME || env.USERPROFILE || homedir();
  const global = opencodeConfigDir(env);
  const configDirs = new Set([
    // .opencode dirs load nearest-first after the project files, so the farther dir wins.
    ...dirs.map((dir) => join(dir, ".opencode")),
    join(home, ".opencode"),
    env.OPENCODE_CONFIG_DIR ?? "",
  ]);
  const inDir = (dir: string) => [join(dir, "opencode.json"), join(dir, "opencode.jsonc")];
  return [
    join(global, "config.json"),
    ...inDir(global),
    // The child resolves a relative OPENCODE_CONFIG from its cwd: lexical behind a Windows junction, real on Linux.
    env.OPENCODE_CONFIG
      ? resolve(process.platform === "win32" ? cwd ?? "" : realCwd(cwd ?? ""), env.OPENCODE_CONFIG)
      : "",
    ...dirs.toReversed().flatMap(inDir),
    ...[...configDirs].filter(Boolean).flatMap(inDir),
  ];
}

function wildcardMatches(name: string, pattern: string, flags: string): boolean {
  const source = pattern.replace(WILDCARD_SPECIAL, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${source}$`, flags).test(name);
}

function substitute(text: string, dir: string, env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return text
    .replace(/\{env:([^}]+)\}/gu, (_match, name: string) => env[name] || "")
    .replace(/\{file:([^}]+)\}/gu, (match, path: string, offset: number, source: string) => {
      if (source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset).trimStart().startsWith("//")) return match;
      const file = path.startsWith("~/") ? join(home, path.slice(2)) : resolve(dir, path);
      return JSON.stringify(readFileSync(file, "utf8").trim()).slice(1, -1);
    });
}

/** Substitutes `{env:}` and `{file:}` like OpenCode; throws where it refuses to start (unreadable file, invalid JSON). */
function readPermissions(text: string, dir: string, env: Record<string, string | undefined>): Map<string, PermissionRule> {
  if (!text) return new Map();
  const parsed = JSON.parse(substitute(text, dir, env)
    .replace(JSONC_COMMENT, (_match, literal) => literal ?? "")
    .replace(JSONC_TRAILING_COMMA, (_match, literal) => literal ?? ""));
  const permission = parsed?.permission;
  if (PERMISSION_ACTIONS.has(permission)) return new Map([["*", permission]]);
  const rules = new Map<string, PermissionRule>();
  for (const key of Object.keys(permission ?? {})) {
    const value = permission[key];
    if (PERMISSION_ACTIONS.has(value)) {
      rules.set(key, value);
      continue;
    }
    const patterns = new Map<string, PermissionAction>();
    for (const pattern of Object.keys(value ?? {})) {
      if (PERMISSION_ACTIONS.has(value[pattern])) patterns.set(pattern, value[pattern]);
    }
    if (patterns.size) rules.set(key, patterns);
  }
  return rules;
}

function readPermissionFile(path: string, env: Record<string, string | undefined>): Map<string, PermissionRule> {
  if (!existsSync(path)) return new Map();
  // OpenCode reads a file saved with a BOM; JSON.parse throws on it.
  return readPermissions(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""), dirname(path), env);
}

function mergePermissions(lower: Map<string, PermissionRule>, upper: Map<string, PermissionRule>) {
  const merged = new Map(lower);
  for (const [key, rule] of upper) {
    const base = merged.get(key);
    merged.set(key, base instanceof Map && rule instanceof Map ? new Map([...base, ...rule]) : rule);
  }
  return merged;
}

/** Every rule OpenCode checks for `key` up to its own entry, in order; later entries keep their place. */
function rulesFor(key: string, user: Map<string, PermissionRule>): Array<[string, PermissionAction]> {
  const rules: Array<[string, PermissionAction]> = [];
  for (const [name, rule] of user) {
    const exact = wildcardMatches(key, name, "su");
    if (!exact && !wildcardMatches(key, name, "siu")) continue;
    const entries: Array<[string, PermissionAction]> = rule instanceof Map ? [...rule] : [["*", rule]];
    // The Windows build matches names case-insensitively; a case-only match adds just its denies.
    rules.push(...entries.filter(([, action]) => exact || action === "deny"));
    if (name === key) break;
  }
  return rules;
}

function tightenRules(rules: Array<[string, PermissionAction]>, inherited: PermissionRule | undefined): PermissionRule {
  const tightened = new Map<string, PermissionAction>([["*", "ask"]]);
  for (const [pattern, action] of rules) {
    if (pattern === "*") tightened.clear();
    tightened.delete(pattern);
    tightened.set(pattern, action === "deny" ? "deny" : "ask");
  }
  if (![...tightened.values()].includes("deny")) return "ask";
  if (tightened.size === 1) return "deny";
  // OpenCode keeps an inherited map's key order and appends new keys; if that reorders these rules, fail closed.
  const keys = [...tightened.keys()];
  const merged = inherited instanceof Map ? [...new Set([...inherited.keys(), ...keys])] : keys;
  return merged.filter((pattern) => tightened.has(pattern)).every((pattern, index) => pattern === keys[index])
    ? tightened
    : "deny";
}

export function withOpenCodeWebSearch(
  raw: string | undefined,
  ask = false,
  env: Record<string, string | undefined> = process.env,
  cwd?: string,
): string {
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = { ...parsed };
    }
  } catch {
    // Invalid JSON is ignored; websearch still lands.
  }
  const current = config.permission;
  const permission: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...current }
      : {};
  permission.websearch = "allow";
  if (ask) {
    try {
      // The inline content overrides these files, so a plain "ask" would loosen their deny.
      const lower = permissionFiles(env, cwd)
        .map((path) => readPermissionFile(path, env))
        .reduce(mergePermissions, new Map<string, PermissionRule>());
      const user = mergePermissions(lower, readPermissions(raw ?? "", realCwd(cwd ?? ""), env));
      for (const key of ["edit", "bash"]) {
        const rule = tightenRules(rulesFor(key, user), lower.get(key));
        permission[key] = rule instanceof Map ? Object.fromEntries(rule) : rule;
      }
    } catch {
      permission.edit = permission.bash = "deny";
    }
  }
  return JSON.stringify({ ...config, permission });
}

/** Upsert an openai-compatible provider so OpenCode can select host/model. */
export function ensureOpenCodeInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const native = `${inject.host}/${inject.model}`;
  const dir = opencodeConfigDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  let config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Malformed user config — inject into a fresh object rather than fail the turn.
    }
  }
  const providers =
    config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? { ...(config.provider as Record<string, unknown>) }
      : {};
  const previous = providers[inject.host];
  const existing =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {
          npm: "@ai-sdk/openai-compatible",
          name: host.label,
          options: {},
          models: {},
        };
  const options =
    existing.options && typeof existing.options === "object" && !Array.isArray(existing.options)
      ? { ...(existing.options as Record<string, unknown>) }
      : {};
  options.baseURL = host.baseUrl;
  if (!options.apiKey) options.apiKey = hostApiKey(host, env);
  const models =
    existing.models && typeof existing.models === "object" && !Array.isArray(existing.models)
      ? { ...(existing.models as Record<string, unknown>) }
      : {};
  if (!models[inject.model]) {
    models[inject.model] = { name: `${inject.model} (${host.label})` };
  }
  providers[inject.host] = {
    ...existing,
    npm: existing.npm || "@ai-sdk/openai-compatible",
    name: existing.name || host.label,
    options,
    models,
  };
  config.provider = providers;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return native;
}

/** Every path the OpenCode CLI may keep auth.json at.
 *
 * The CLI is xdg-flavoured on EVERY platform — `opencode auth list` on macOS
 * prints `~/.local/share/opencode/auth.json`, and that is where real logins
 * land. The platform-conventional locations are kept as fallbacks in case a
 * future CLI moves there, but the xdg path must come first: checking only
 * Library/Application Support on macOS is exactly the bug that made the app
 * demand a sign-in from users who were already signed in. */
function storedAuthPaths(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [
    env.XDG_DATA_HOME || join(home, ".local", "share"),
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : "",
  ].filter(Boolean);
  return [...new Set(roots)].map((root) => join(root, "opencode", "auth.json"));
}

/** True when auth.json contains any usable provider login managed by
 * OpenCode. The generic harness can run all of them, including `opencode`
 * (Zen), `opencode-go`, and third-party providers such as OpenRouter. */
function usableAuthEntry(parsed: Record<string, unknown>): boolean {
  return Object.values(parsed).some((auth) => {
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
    const entry = auth as { key?: unknown; access?: unknown; refresh?: unknown };
    return Boolean(entry.key || entry.access || entry.refresh);
  });
}

function hasStoredOpenCodeAuth(env: Record<string, string | undefined>) {
  const candidates: string[] = [];
  if (env.OPENCODE_AUTH_CONTENT) candidates.push(env.OPENCODE_AUTH_CONTENT);
  for (const path of storedAuthPaths(env)) {
    try {
      candidates.push(readFileSync(path, "utf8"));
    } catch {
      // A missing or unreadable file simply means there is no ambient login.
    }
  }
  return candidates.some((raw) => {
    try {
      return usableAuthEntry(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return false;
    }
  });
}

export async function canListOpenCodeModels(
  env: Record<string, string | undefined>,
  cli: string,
  runModels: typeof runOpenCodeModels = runOpenCodeModels,
): Promise<boolean> {
  const cached = modelProbeCache.get(cli);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    result: Promise.resolve(false),
  };
  entry.result = runModels(cli, env, false)
    .then((stdout) => stdout
      .split(/\r?\n/u)
      .some((line) => validModelSlug(line.trim())))
    .catch(() => false)
    .finally(() => {
      entry.expiresAt = Date.now() + MODEL_PROBE_TTL_MS;
    });
  modelProbeCache.set(cli, entry);
  return entry.result;
}

/** Migrate the model name published during Ox Alpha's first preview. The
 * current CLI calls the same model `x-preview-f-free`; prefer Go for an old
 * Go bot with an explicit key, otherwise use Zen's anonymous/free route. */
export function normalizeLegacyOpenCodeModel(
  model: string,
  env: Record<string, string | undefined>,
): string {
  if (model !== "opencode-go/ox-alpha-free") return model;
  return env.OPENCODE_API_KEY
    ? "opencode-go/x-preview-f-free"
    : "opencode/x-preview-f-free";
}

const support = (loadCatalog: OpenCodeCatalogLoader): AcpSupport => ({
  driverKind: "opencodeGo",
  // Keep the historical driver kind so existing bots and instance config do
  // not break; only the product name/catalog expand from Go to OpenCode.
  displayName: "OpenCode",
  models: STATIC_MODELS,
  defaultCli: "opencode",
  nativeSource: "opencode.acp",
  loginNote:
    "OpenCode has no usable models — run `opencode auth login` or connect a provider in the OpenCode app",
  install: {
    command: {
      darwin: "npm install -g opencode-ai",
      linux: "npm install -g opencode-ai",
      win32: "npm install -g opencode-ai",
    },
    docsUrl: "https://opencode.ai/docs/",
    signInCommand: "opencode auth login",
    needsNode: true,
  },
  spawnArgs: () => ["acp"],
  credentialEnv: CREDENTIAL_ENV,
  selectModel: { configId: "model" },
  resolveTurnModel: (model, env) => model
    ? ensureOpenCodeInjectModel(normalizeLegacyOpenCodeModel(model, env), env)
    : model,
  transformEnv: stripForeignProviderKeys,
  // Without this, ACP has webfetch but not websearch. OpenCode allows every
  // edit and command by default, so Ask for approval turns those to ask.
  applyTurnEnv: (env, { approval, cwd }) => {
    env.OPENCODE_CONFIG_CONTENT = withOpenCodeWebSearch(env.OPENCODE_CONFIG_CONTENT, approval === "ask", env, cwd);
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: async (env, config) => (
    Boolean(env.OPENCODE_API_KEY)
    || hasStoredOpenCodeAuth(env)
    || await canListOpenCodeModels(env, config.cli)
  ),
  requireAuthenticationBeforeSpawn: true,
  classifyError: classifyOpenCodeError,
  resolveModels: async (environment, config) => mergeLocalInject(
    await loadCatalog(environment, config.cli),
    environment,
  ),
  buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});

export function classifyOpenCodeError(error: unknown): ProviderErrorCode | undefined {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = value.code;
  if (code === -32000) return "invalid_credentials";
  if (code === "AUTH_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED") return "invalid_credentials";
  if (code === "SUBSCRIPTION_INACTIVE") return "inactive_subscription";
  if (code === "QUOTA_EXCEEDED" || code === "REGION_RESTRICTED") return "quota_or_region_restriction";
  if (code === "UPSTREAM_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") return "upstream_outage";
  if (code === "MODEL_CATALOG_UNAVAILABLE") return "model_catalog_outage";
  return undefined;
}

export const classifyOpenCodeGoError = classifyOpenCodeError;

export function createOpenCodeDriver(loadCatalog: OpenCodeCatalogLoader = discoverOpenCodeModels) {
  return createAcpDriver(support(loadCatalog));
}

export const createOpenCodeGoDriver = createOpenCodeDriver;
export const OpenCodeDriver = createOpenCodeDriver();
export const OpenCodeGoDriver = OpenCodeDriver;
