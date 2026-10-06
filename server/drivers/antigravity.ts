// Antigravity driver — Google's `agy` CLI in headless one-shot print mode
// (`agy --print --output-format stream-json`), modeled on claude.ts but fully
// self-contained. Per-turn CLI process; the conversation continues across
// turns via `--conversation <id>` (the resumeCursor is agy's conversation_id)
// until Orbit compaction, when the harness starts a fresh conversation and
// injects the bounded transcript. Verified against agy 1.1.12 for event shapes.
// Prompt transport re-verified against agy 1.2.4: --input-format stream-json
// (since 1.1.15) carries the prompt on stdin as {"event":"user",...} NDJSON —
// not --print argv (mutually exclusive with stream-json input) and not Claude's
// {"type":"user"} shape.
//
// Unlike claude, print mode has NO interactive permission hook: there is no
// per-action broker here. `--mode accept-edits` allows file edits but
// auto-denies shell (`run_command` comes back as a tool ERROR); the default
// `request-review` auto-denies; `--dangerously-skip-permissions` (fullAuto)
// approves everything. Real per-action approval cards are a future path via
// native ACP (agy issue #31), which would reuse acp/core.ts like grok/gemini.
//
// MCP: agy has no per-turn MCP flag, so Wink's servers (agents, terminal, and
// the bot's computer: cloud box / Local VM / VPS) are mounted into the global
// `~/.gemini/config/mcp_config.json` around each child - see
// ensureAntigravityComputerMcp below. Computer use is full-auto instances
// only; the host desktop stays off (no approval channel in print mode, ever).
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { applyCredentialAllowlist, DATA_DIR } from "../config.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { augmentedPath } from "../env-path.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { injectedApiModel, mergeLocalInject } from "./local-inject.ts";

import type { ChildProcess } from "node:child_process";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative, finishNative } from "./native.ts";
import { isResumeCursorRejected } from "./retry.ts";
import { systemLedger } from "./system-ledger.ts";

const DRIVER_KIND = "antigravityAgent";
const AGY_STOPPED_NOTE = "The bot stopped before finishing.";
const AGY_SYSTEM_NOTICE = /<SYSTEM_MESSAGE\b/i;
const AGY_CONTEXT_CANCELLATION = /\bcontext\s+cancel(?:ed|led)\b/i;
const AGY_ACCOUNT_ERROR =
  /unauthorized|\bforbidden\b|\b401\b|\b403\b|not logged in|\bsign[\s-]?in\b|authentication failed|permission_denied|permission denied|has not been used in project|\bapi\b[^.\n]{0,120}\bdisabled\b/i;
const AGY_NOT_ACCOUNT_ERROR = /\brate[\s-]?limit\b|\b429\b|\btoo many requests\b|\b5\d\d\b|\b5xx\b/i;
const AGY_TIMEOUT_ERROR = /\b(?:watchdog timeout|timed out|time-out|timeout)\b/i;

/** Account or permission failure. Rate limits, 5xx, and timeout-only lines are not. */
export function isAgyAccountError(text: string): boolean {
  if (AGY_NOT_ACCOUNT_ERROR.test(text)) return false;
  if (AGY_TIMEOUT_ERROR.test(text) && !AGY_ACCOUNT_ERROR.test(text)) return false;
  return AGY_ACCOUNT_ERROR.test(text);
}

function isAntigravitySystemNotice(text: string): boolean {
  return AGY_SYSTEM_NOTICE.test(text);
}

function isCancelledTool(payload: { state?: string; tool_info?: { output?: string } | string }): boolean {
  return payload.state === "ERROR" && AGY_CONTEXT_CANCELLATION.test(JSON.stringify(payload.tool_info ?? payload));
}

export interface AntigravityConfig {
  cli: string;
  fullAuto: boolean;
}

// model catalog from `agy models` (agy 1.1.27)
export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = {
  default: "gemini-3.1-pro-high",
  options: [
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)", contextWindow: 1_048_576 },
    { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)", contextWindow: 1_048_576 },
    // 3.8 ids confirmed against the agy 1.1.26 binary's own model table;
    // there is no bare gemini-3.8-flash, only the three throttle tiers
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", contextWindow: 1_048_576 },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", contextWindow: 1_048_576 },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", contextWindow: 1_048_576 },
    // 3.7 ids confirmed against the agy 1.1.12 binary's own model table
    { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)", contextWindow: 1_048_576 },
    { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)", contextWindow: 1_048_576 },
    { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)", contextWindow: 1_048_576 },
    { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)", contextWindow: 1_048_576 },
    { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)", contextWindow: 1_048_576 },
    { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)", contextWindow: 1_048_576 },
    // 3.5 ids confirmed against the agy 1.1.27 binary's own model table
    { id: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (High)", contextWindow: 1_048_576 },
    { id: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (Medium)", contextWindow: 1_048_576 },
    { id: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (Low)", contextWindow: 1_048_576 },
    // claude-sonnet-4-6, claude-opus-4-6-thinking, and gpt-oss-120b-medium
    // below predate the ground-truth rule (driver PR #30) and do not appear
    // in a current `agy models` run — see MODEL-AG-STALE. Left in place
    // pending a follow-up to confirm or remove them; see
    // ANTIGRAVITY_UNVERIFIED_LEGACY_IDS in antigravity.test.ts.
    // gpt-oss 128k is the published figure, not confirmed against agy.
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", contextWindow: 1_000_000 },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", contextWindow: 1_000_000 },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", contextWindow: 131_072 },
  ],
};

function antigravityEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), ...overrides };
  // Antigravity uses its own login, so it is granted no credential at all —
  // not the workspace secrets the desktop shell injects, not another
  // provider's key, in any of its turn, snapshot, or helper children.
  applyCredentialAllowlist(env);
  // agy's detached --bg-updater (15+ min after its last check) opens a visible console on Windows.
  if (process.platform === "win32") env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return env;
}

const AGY_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return AGY_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; name?: unknown; displayName?: unknown };
    const id = typeof row.id === "string" ? row.id : typeof row.model === "string" ? row.model : "";
    if (!AGY_MODEL_ID.test(id)) return [];
    const label = typeof row.name === "string" ? row.name : typeof row.displayName === "string" ? row.displayName : id;
    return [{ id, label }];
  });
}

/** Extra ids from ~/.gemini/antigravity-cli/settings.json, if the user added any. */
export function readAntigravityModelCatalog(env: Record<string, string | undefined> = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(
      readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return STATIC_ANTIGRAVITY_MODELS;
  }
  const extras = [
    ...extrasFromUnknown(settings.availableModels),
    ...extrasFromUnknown(settings.customModels),
    ...extrasFromUnknown(settings.extraModels),
  ];
  if (typeof settings.model === "string") extras.push(...extrasFromUnknown([settings.model]));
  const options = STATIC_ANTIGRAVITY_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: STATIC_ANTIGRAVITY_MODELS.default, options };
}

// ── computer MCP mount ──────────────────────────────────────────────────
// agy has no per-session MCP flag and no project-level MCP config: verified
// against agy 1.1.19, whose embedded docs list exactly two locations — the
// global `~/.gemini/config/mcp_config.json` and per-plugin files — and whose
// `agy mcp list` ignores `.gemini/{settings,mcp_config}.json` in the cwd.
// So Wink's servers are mounted into the global file for each child's
// lifetime: every other byte of the user's config is preserved, and a
// malformed file starts from a fresh object instead of failing the turn (the
// ensureOpenCodeInjectModel discipline). The agents and terminal entries are
// static: each MCP child inherits its agy process's env (verified agy
// 1.2.16), so a turn's identity rides there, never in the shared file.
export const ANTIGRAVITY_COMPUTER_MCP_KEY = "openmausbot-computer";
export const ANTIGRAVITY_AGENTS_MCP_KEY = "openmausbot-agents";
export const ANTIGRAVITY_TERMINAL_MCP_KEY = "openmausbot-terminal";
const WINK_MCP_KEY_PREFIX = "openmausbot-";

export interface AntigravityComputerMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// agy's MCP file is machine-global. Computer-less turns share it; a computer
// turn's entry carries its box token, so that turn holds the file alone.
// FIFO with writer preference: once a computer turn waits, later turns queue
// behind it.
let mcpSharedHolders = 0;
let mcpExclusiveHeld = false;
const mcpWaiters: Array<{ exclusive: boolean; grant: () => void }> = [];

function pumpAntigravityMcpLock() {
  while (mcpWaiters.length && !mcpExclusiveHeld && !(mcpWaiters[0].exclusive && mcpSharedHolders > 0)) {
    const waiter = mcpWaiters.shift()!;
    if (waiter.exclusive) mcpExclusiveHeld = true;
    else mcpSharedHolders += 1;
    waiter.grant();
  }
}

/** Resolves with the release once granted; cancel() drops a waiter that was never granted. */
function acquireAntigravityMcpLock(exclusive: boolean) {
  let cancel = () => {};
  const granted = new Promise<() => void>((resolve) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (exclusive) mcpExclusiveHeld = false;
      else mcpSharedHolders -= 1;
      pumpAntigravityMcpLock();
    };
    const waiter = { exclusive, grant: () => resolve(release) };
    cancel = () => {
      const index = mcpWaiters.indexOf(waiter);
      if (index === -1) return;
      mcpWaiters.splice(index, 1);
      resolve(() => {});
      pumpAntigravityMcpLock();
    };
    mcpWaiters.push(waiter);
    pumpAntigravityMcpLock();
  });
  return { granted, cancel };
}

// One mount per config file for all computer-less holders: the first mounts,
// the last restores.
const sharedMcpMounts = new Map<string, { holders: number; restore: () => void }>();

/** Mount for one child under the lock; a computer turn's mount is its own. */
function mountAntigravityMcp(
  computer: AntigravityComputerMcpServer | null,
  env: Record<string, string | undefined>,
): () => void {
  if (computer) return ensureAntigravityComputerMcp(computer, env);
  const path = antigravityMcpConfigPath(env);
  const mount = sharedMcpMounts.get(path) ?? { holders: 0, restore: ensureAntigravityComputerMcp(null, env) };
  mount.holders += 1;
  sharedMcpMounts.set(path, mount);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mount.holders -= 1;
    if (mount.holders > 0) return;
    sharedMcpMounts.delete(path);
    mount.restore();
  };
}

function antigravityMcpConfigPath(env: Record<string, string | undefined>): string {
  return join(env.HOME || env.USERPROFILE || homedir(), ".gemini", "config", "mcp_config.json");
}

function withoutWinkMcpServers(servers: z.infer<typeof mcpConfigFileSchema>["mcpServers"] = {}) {
  return Object.fromEntries(Object.entries(servers).filter(([key]) => !key.startsWith(WINK_MCP_KEY_PREFIX)));
}

function winkProxyMcpServer(proxy: string): AntigravityComputerMcpServer {
  return { command: process.execPath, args: [proxy], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

// Lenient by design: keep every unknown key the user put in the file. A
// present-but-wrong mcpServers (e.g. an array) fails the parse and is
// rebuilt fresh — that file was already unusable to agy itself.
const mcpConfigFileSchema = z.looseObject({
  mcpServers: z.looseObject({}).optional(),
});

/** The computer MCP server for this turn, or null when the turn has none.
 * Cloud boxes go through OpenMausBot's REST-to-MCP adapter (the same spec
 * claude.ts and codex.ts build); Local VM and VPS connections arrive as a
 * ready-made Cua Driver stdio command and pass through unchanged. */
export function antigravityComputerMcpServer(
  integrations: SendTurnInput["integrations"],
): AntigravityComputerMcpServer | null {
  const computer = integrations?.computer;
  if (computer) {
    const proxyEnv = computerProxyEnv(computer);
    return {
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OGB_BOX_ID: proxyEnv.OGB_BOX_ID ?? "",
        OGB_BOX_TOKEN: proxyEnv.OGB_BOX_TOKEN ?? "",
        // who-is-driving endpoint, so a person taking the wheel in the
        // panel pauses this bot's hands mid-turn
        OMB_CONTROL_URL: proxyEnv.OMB_CONTROL_URL ?? "",
        OMB_CONTROL_TOKEN: proxyEnv.OMB_CONTROL_TOKEN ?? "",
      },
    };
  }
  const local = integrations?.localComputer;
  if (local) return { command: local.command, args: local.args, env: { ...local.env } };
  return null;
}

/** Mount Wink's static agents and terminal entries, plus the computer entry
 * when given, into the global mcp_config.json. Any openmausbot-* key already
 * there is a crash leftover: left out of the mount and never restored. */
export function ensureAntigravityComputerMcp(
  server: AntigravityComputerMcpServer | null,
  env: Record<string, string | undefined> = process.env,
): () => void {
  const path = antigravityMcpConfigPath(env);
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf8") : null;
  let config: z.infer<typeof mcpConfigFileSchema> = {};
  try {
    const parsed = mcpConfigFileSchema.safeParse(JSON.parse(original ?? ""));
    if (parsed.success) config = parsed.data;
  } catch {
    // Missing or malformed user config — rebuild only what the mount needs.
  }
  const userServers = withoutWinkMcpServers(config.mcpServers);
  const servers = {
    ...userServers,
    [ANTIGRAVITY_AGENTS_MCP_KEY]: winkProxyMcpServer(SPAWNED_PROXIES.agents),
    [ANTIGRAVITY_TERMINAL_MCP_KEY]: winkProxyMcpServer(SPAWNED_PROXIES.terminal),
    ...(server ? { [ANTIGRAVITY_COMPUTER_MCP_KEY]: { command: server.command, args: server.args, env: server.env } } : {}),
  };
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existed) chmodSync(path, 0o600);
  const mounted = `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
  writeFileSync(path, mounted, { mode: 0o600 });
  chmodSync(path, 0o600);

  const hadLeftover = Object.keys(config.mcpServers ?? {}).some((key) => key.startsWith(WINK_MCP_KEY_PREFIX));
  const restoreTo =
    original !== null && hadLeftover ? `${JSON.stringify({ ...config, mcpServers: userServers }, null, 2)}\n` : original;

  // Restore what was present before the mount when nobody else touched the
  // file. A user's own agy process is outside our module-wide lock, so if it
  // edited the config concurrently, preserve that edit and drop only Wink's
  // keys instead of replacing (or deleting) the whole file.
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (current === mounted) {
      if (restoreTo === null) {
        unlinkSync(path);
        return;
      }
      writeFileSync(path, restoreTo, { mode: 0o600 });
      chmodSync(path, 0o600);
      return;
    }

    // A malformed concurrent edit is not safe to rewrite. Leaving a stale
    // OpenMausBot entry is preferable to destroying bytes we cannot interpret.
    let currentJson: unknown;
    try {
      currentJson = JSON.parse(current);
    } catch {
      return;
    }
    const parsed = mcpConfigFileSchema.safeParse(currentJson);
    if (!parsed.success) return;
    const currentConfig = parsed.data;
    writeFileSync(
      path,
      `${JSON.stringify({ ...currentConfig, mcpServers: withoutWinkMcpServers(currentConfig.mcpServers) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
  };
}

function decodeConfig(raw: unknown): AntigravityConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.cli !== undefined && typeof o.cli !== "string") {
    throw new Error(`antigravity: invalid cli ${JSON.stringify(o.cli)}`);
  }
  if (o.fullAuto !== undefined && typeof o.fullAuto !== "boolean") {
    throw new Error(`antigravity: invalid fullAuto ${JSON.stringify(o.fullAuto)}`);
  }
  return {
    cli: typeof o.cli === "string" ? o.cli : "agy",
    // Default fullAuto to TRUE: agy's headless print harness invokes tools even
    // for trivial prompts and, with no interactive approval channel, auto-denies
    // them — producing no output, so a non-fullAuto bot's turns frequently fail.
    // Default to fullAuto for a usable bot; per-action consent returns with the
    // ACP v2 path. Still throws above on a non-boolean fullAuto.
    fullAuto: o.fullAuto === undefined ? true : o.fullAuto === true,
  };
}


/** Windows CreateProcess lpCommandLine ceiling (characters), including the exe path. */
export const WIN32_CREATEPROCESS_CMDLINE_MAX = 32_767;

/** Compose persona/system + user text the same way --print argv used to. Continuity
 * injected by the harness into system/text is preserved verbatim — never stripped. */
export function composeAntigravityPrompt(system: string | null | undefined, text: string): string {
  return system ? `${system}\n\n${text}` : text;
}

/** One NDJSON stdin line for `--input-format stream-json` (agy 1.1.15+). The CLI
 * requires an `event` key — Claude's `type` key is rejected. */
export function antigravityStreamUserLine(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`;
}

/** Quote one argv token the way Node approximates CreateProcess on win32. */
export function quoteWin32ArgvToken(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** Estimated CreateProcess command-line length for command + args on Windows. */
export function estimateWin32CmdlineLength(command: string, args: string[]): number {
  return [command, ...args].map(quoteWin32ArgvToken).join(" ").length;
}

export interface AntigravityTurnArgvInput {
  fullAuto: boolean;
  cwd: string;
  model?: string | null;
  resumeCursor?: string | null;
}

/** Print-mode argv with the prompt on stdin — never on --print. */
export function buildAntigravityTurnArgv(input: AntigravityTurnArgvInput): string[] {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "10m",
    "--add-dir",
    input.cwd,
  ];
  if (input.fullAuto) args.push("--dangerously-skip-permissions");
  else {
    args.push("--mode", "accept-edits");
  }
  if (input.model) args.push("--model", injectedApiModel(input.model) ?? input.model);
  if (input.resumeCursor) args.push("--conversation", input.resumeCursor);
  return args;
}

/** Length-only accounting for spawn budgets. Never logs private text or credentials. */
export function measureAntigravityTransportLengths(opts: {
  userText: string;
  system?: string | null;
  continuity?: string | null;
  toolMcpConfigJson?: string | null;
  cli: string;
  argv: string[];
  stdinLine: string;
}): {
  userTextChars: number;
  systemChars: number;
  continuityChars: number;
  toolMcpConfigChars: number;
  totalArgvChars: number;
  stdinBytes: number;
  promptBytes: number;
} {
  const prompt = composeAntigravityPrompt(opts.system, opts.userText);
  return {
    userTextChars: opts.userText.length,
    systemChars: (opts.system ?? "").length,
    continuityChars: (opts.continuity ?? "").length,
    toolMcpConfigChars: (opts.toolMcpConfigJson ?? "").length,
    totalArgvChars: estimateWin32CmdlineLength(opts.cli, opts.argv),
    stdinBytes: Buffer.byteLength(opts.stdinLine),
    promptBytes: Buffer.byteLength(prompt),
  };
}

export const AntigravityDriver: ProviderDriver<AntigravityConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Gemini (Antigravity)", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      win32: "irm https://antigravity.google/cli/install.ps1 | iex",
    },
    docsUrl: "https://github.com/google-antigravity/antigravity-cli#installation",
    signInCommand: "agy",
  },
  models: STATIC_ANTIGRAVITY_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<AntigravityConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const env = antigravityEnvironment(input.environment);
    const catalogEnv: Record<string, string | undefined> = env;
    let models = STATIC_ANTIGRAVITY_MODELS;
    const refreshModels = async () => {
      try {
        const resolved = await mergeLocalInject(readAntigravityModelCatalog(catalogEnv), catalogEnv);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when settings.json is unreadable.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread; a second send while busy is a caller bug
    const active = new Map<string, { stop: () => void; interrupt: () => void; turnId: string }>();
    let disposed = false;
    const systemHeld = systemLedger();
    // every live agy child, tracked independently of `active`: a child can
    // hang AFTER emitting `result` (so it's already removed from `active`), and
    // dispose()/stopAll() must still be able to reap it. Removed on process exit.
    const children = new Set<ChildProcess>();

    const emit = (event: RuntimeEvent) => {
      finishNative(event);
      for (const l of [...listeners]) l(event);
    };

    // Reap every tracked child's tree (mirrors the per-turn stop()) — POSIX
    // process group on mac/linux, taskkill /T on Windows. When escalate is
    // set a SIGKILL follows after a grace for anything that ignored the term;
    // on Windows killCliTree is already a force kill, so the retry is a no-op.
    const reapChildren = (escalate: boolean) => {
      for (const child of children) {
        killCliTree(child);
        if (escalate && process.platform !== "win32") {
          setTimeout(() => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {}
          }, 2000).unref?.();
        }
      }
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    // A resume fallback relaunch is the same logical turn: the harness holds
    // the first id as live and drops events from any other.
    const sendTurn = async (turn: SendTurnInput, relaunchOf?: string) => {
      const { threadId } = turn;
      if (disposed) throw new Error("Antigravity instance is disposed");
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = relaunchOf ?? newId();

      // Default cwd to a per-thread workspace under DATA_DIR — deliberately
      // NOT homedir(): a bot running unattended should not get the whole home
      // as its default sandbox. `--add-dir` grants agy access to that dir.
      // strip filesystem-unsafe chars only — never truncate: a 36-char UUID
      // sliced to 32 would collide two threads sharing the first 32 chars onto
      // one workspace dir. replace() already keeps a UUID unique and safe.
      const tag = threadId.replace(/[^\w-]/g, "");
      const workspace = join(DATA_DIR, "workspaces", tag);
      mkdirSync(workspace, { recursive: true });
      const cwd = turn.cwd ?? workspace;

      // Prompt travels on stdin via --input-format stream-json (agy 1.1.15+;
      // verified 1.2.4). --print <prompt> is mutually exclusive with that
      // transport and is what blew Windows CreateProcess (~32k) with long
      // pastes / injected continuity. Continuity stays in system/text.
      const resumeCursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      // A resumed conversation that holds this exact system text gets only the turn text.
      const system = turn.system && (!resumeCursor || !systemHeld.holds(resumeCursor, turn.system)) ? turn.system : undefined;
      if (system && resumeCursor) systemHeld.forget(resumeCursor);
      const prompt = composeAntigravityPrompt(system, turn.text);

      let settled = false;
      // the model answered this prompt, so the session holds it
      let promptAccepted = false;
      // conversation_id from the init event → the resumeCursor (session.started
      // is what the harness persists as the cursor). Also seeds tool item ids.
      let conversationId: string | null = null;
      // agy's checkpoint step summarizes the conversation; a later turn can drop
      // everything before it, so the next prompt re-sends the system text
      let checkpointed = false;
      // backstop watchdog: if agy hangs without emitting `result` and without
      // exiting, the bot would stay busy forever (agy's own --print-timeout 10m
      // is the only other net). Assigned just below; settle() always clears it.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      // Assigned once the child exists. A child can emit `result` and then
      // hang, so settling must still arrange for process and MCP cleanup.
      let armPostSettleCleanup = () => {};
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: { input: number; output: number },
      ) => {
        if (settled) return;
        settled = true;
        const conversation = conversationId ?? resumeCursor;
        if (conversation && checkpointed) systemHeld.forget(conversation);
        else if (conversation && system && promptAccepted) systemHeld.record(conversation, system);
        clearTimeout(watchdog);
        active.delete(threadId);
        armPostSettleCleanup();
        emit({
          ...base(threadId, turnId),
          type: "turn.completed",
          ok,
          stopReason,
          cost,
          ...(usage ? { usage } : {}),
          ...(promptAccepted ? { promptAccepted: true } : {}),
        });
      };

      // Set only by a user Stop; the watchdog and post-settle reaper kill the
      // child without it.
      let interrupted = false;
      // agy's config is global, so every turn holds the MCP lock for its
      // complete child lifetime; only a computer turn holds it alone.
      const computer = antigravityComputerMcpServer(turn.integrations);
      const mcpLock = acquireAntigravityMcpLock(computer !== null);
      // Reserve the thread across the lock wait so a Stop lands here.
      active.set(threadId, {
        stop: () => {},
        interrupt: () => {
          interrupted = true;
          mcpLock.cancel();
        },
        turnId,
      });
      const releaseMcpLock = await mcpLock.granted;
      if (interrupted) {
        releaseMcpLock();
        emit({ ...base(threadId, turnId), type: "turn.started" });
        settle(false, "interrupted");
        return { turnId };
      }
      if (disposed) {
        releaseMcpLock();
        settle(false, "disposed");
        return { turnId };
      }
      let restoreMcp = () => {};
      try {
        restoreMcp = mountAntigravityMcp(computer, env);
      } catch (error) {
        releaseMcpLock();
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `could not update Antigravity's MCP config (${join(".gemini", "config", "mcp_config.json")}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        settle(false, "mcp_config_error");
        return { turnId };
      }

      const args = buildAntigravityTurnArgv({
        fullAuto: config.fullAuto,
        cwd,
        model: turn.model,
        resumeCursor,
      });
      // Remaining argv (paths, model, conversation id) can still blow the
      // Windows CreateProcess ceiling even with the prompt on stdin.
      if (process.platform === "win32" && estimateWin32CmdlineLength(config.cli, args) > WIN32_CREATEPROCESS_CMDLINE_MAX) {
        try {
          restoreMcp();
        } finally {
          releaseMcpLock();
        }
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `spawn failed: command line too long for Windows (${estimateWin32CmdlineLength(config.cli, args)} chars > ${WIN32_CREATEPROCESS_CMDLINE_MAX})`,
          setup: false,
        });
        settle(false, "spawn_error");
        return { turnId };
      }

      // The static agents and terminal entries read this turn's identity from
      // agy's env. Added after the credential allowlist, which strips *_TOKEN;
      // the node flag would leak into every shell command the agent runs.
      const { ELECTRON_RUN_AS_NODE: _nodeFlag, ...identity } = {
        ...turn.integrations?.agents?.env,
        ...turn.integrations?.terminal?.env,
      };

      // spawnCli resolves npm .cmd shims / shebang scripts on Windows and
      // owns the process-group vs windowsHide difference (see procs.ts)
      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(config.cli, args, {
          cwd,
          env: { ...env, ...identity },
          stdio: ["pipe", "pipe", "pipe"], // prompt on stdin as stream-json NDJSON
        });
      } catch (error) {
        try {
          restoreMcp();
        } finally {
          releaseMcpLock();
        }
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          ...describeSpawnFailure(error instanceof Error ? error : new Error(String(error)), config.cli),
        });
        settle(false, "spawn_error");
        return { turnId };
      }
      children.add(child);

      // Deliver the full prompt (system/persona + user text, continuity included)
      // as one stream-json user event, then close stdin so one-shot print exits
      // after the turn — same lifecycle as the old --print argv path.
      const stdinLine = antigravityStreamUserLine(prompt);
      try {
        const stdin = child.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) {
          throw new Error("agy stdin is not writable");
        }
        stdin.write(stdinLine, (writeError) => {
          if (writeError) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `failed to write Antigravity prompt to stdin: ${writeError.message}`,
            });
            settle(false, "stdin_write_failed");
            killCliTree(child);
          }
        });
        stdin.end();
      } catch (error) {
        try {
          restoreMcp();
        } finally {
          releaseMcpLock();
        }
        children.delete(child);
        try {
          killCliTree(child);
        } catch {}
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `failed to write Antigravity prompt to stdin: ${error instanceof Error ? error.message : String(error)}`,
        });
        settle(false, "stdin_write_failed");
        return { turnId };
      }

      let childClosed = false;
      let postSettleReaper: ReturnType<typeof setTimeout> | undefined;
      let terminationEscalation: ReturnType<typeof setTimeout> | undefined;
      let mcpFinalized = false;
      const finalizeMcp = () => {
        if (mcpFinalized) return;
        mcpFinalized = true;
        try {
          restoreMcp();
        } catch (error) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `could not restore Antigravity's MCP config: ${error instanceof Error ? error.message : String(error)}`,
          });
        } finally {
          releaseMcpLock();
        }
      };
      const armTerminationEscalation = () => {
        if (childClosed || terminationEscalation) return;
        terminationEscalation = setTimeout(() => {
          if (childClosed) return;
          if (process.platform === "win32") {
            killCliTree(child); // taskkill /T /F is already forceful
            return;
          }
          try {
            const pid = child.pid;
            if (pid) process.kill(-pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }, 3_000);
        terminationEscalation.unref?.();
      };
      const stop = () => {
        killCliTree(child); // process groups are POSIX-only
        armTerminationEscalation();
      };
      armPostSettleCleanup = () => {
        if (childClosed || postSettleReaper) return;
        // A normal agy process exits immediately after `result`. Give it a
        // short grace, then reap a zombie. Explicit stops use the same bounded
        // SIGKILL escalation so an uncooperative child cannot retain the lock.
        postSettleReaper = setTimeout(stop, 2_000);
        postSettleReaper.unref?.();
      };

      let cancelledTool = false;

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "agy.stream", msg: o });
        const payload = o[o.event] ?? {};
        switch (o.event) {
          case "init": {
            conversationId = o.conversation_id ?? null;
            emit({
              ...base(threadId, turnId),
              type: "session.started",
              sessionId: conversationId,
              model: turn.model ?? null,
            });
            break;
          }
          case "step_update": {
            promptAccepted = true;
            if (payload.step_type === "checkpoint") checkpointed = true;
            if (payload.step_type === "tool") {
              cancelledTool ||= isCancelledTool(payload);
              const itemId = `${conversationId ?? o.conversation_id ?? "conv"}:${payload.step_index}`;
              if (payload.state === "ACTIVE") {
                emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId, title: payload.tool_name });
              } else if (payload.state === "DONE") {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: true });
              } else if (payload.state === "ERROR") {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: false });
              }
            } else if (payload.step_type === "agent_response" && payload.usage) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                output: payload.usage.output_tokens || 0,
              });
            }
            break;
          }
          case "result": {
            promptAccepted = true;
            // agy delivers the assistant text in result.response (not streamed)
            const response = typeof payload.response === "string" ? payload.response : "";
            const realResponse = Boolean(response.trim()) && !isAntigravitySystemNotice(response) && !cancelledTool;
            const parsedError = z.string().safeParse(payload.error);
            const agyError = parsedError.success ? parsedError.data : "";
            const agyResultError = payload.status === "ERROR" && agyError.length > 0;
            if (agyResultError) {
              if (isAgyAccountError(agyError)) {
                emit({ ...base(threadId, turnId), type: "runtime.error", message: agyError, signIn: true });
              } else {
                emit({ ...base(threadId, turnId), type: "runtime.error", message: agyError });
              }
            }
            if (realResponse) {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: response });
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: response });
            } else if (!agyResultError) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: AGY_STOPPED_NOTE });
            }
            if (payload.usage) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                output: payload.usage.output_tokens || 0,
              });
            }
            // result.usage is the turn total (the per-step agent_response
            // figures above are its parts, not additions to it)
            settle(
              payload.status === "SUCCESS" && Boolean(realResponse),
              cancelledTool ? "cancelled_tool" : realResponse ? payload.status ?? null : "no_final_text",
              null,
              payload.usage
                ? {
                    input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                    output: payload.usage.output_tokens || 0,
                  }
                : undefined,
            );
            break;
          }
        }
      };

      let buf = "";
      child.stdout.setEncoding("utf8"); // decode multibyte across chunk splits
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handleLine(line);
        }
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      child.on("error", (e) => {
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });

      child.on("close", (code) => {
        childClosed = true;
        children.delete(child); // close is the true process-exit signal
        clearTimeout(postSettleReaper);
        clearTimeout(terminationEscalation);
        finalizeMcp();
        if (!settled) {
          if (interrupted) {
            settle(false, "interrupted");
            return;
          }
          const resumeRejected = Boolean(
            resumeCursor &&
            turn.resumeFallback &&
            !conversationId &&
            isResumeCursorRejected(stderr),
          );
          if (resumeRejected) {
            settled = true;
            clearTimeout(watchdog);
            active.delete(threadId);
            emit({ ...base(threadId, turnId), type: "turn.retrying", attempt: 1, delayMs: 0, reason: "resume_cursor" });
            void sendTurn({
              ...turn,
              text: turn.resumeFallback!.text,
              resumeCursor: undefined,
              resumeFallback: undefined,
            }, turnId).catch((error) => {
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: error instanceof Error ? error.message : String(error),
              });
              emit({
                ...base(threadId, turnId),
                type: "turn.completed",
                ok: false,
                stopReason: "resume_fallback_failed",
                cost: null,
              });
            });
            return;
          }
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `agy exited ${code} before result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      active.set(threadId, {
        stop,
        interrupt: () => {
          interrupted = true;
          stop();
        },
        turnId,
      });

      // 11 min — just above agy's own 10m --print-timeout, so agy normally
      // settles first; this is the backstop for a fully wedged child.
      watchdog = setTimeout(() => {
        if (!settled) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: "agy watchdog timeout" });
          stop();
          settle(false, "timeout");
        }
      }, 11 * 60_000);
      watchdog.unref?.();

      emit({ ...base(threadId, turnId), type: "turn.started" });

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      // No auth field: agy auth is keyring-backed with no reliable file marker
      // (~/.gemini/antigravity-cli/ exists after first run even when logged
      // out), so any file heuristic would overstate "signed in". Leave undefined.
      return { state: "available", version };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          images: true,
          // Usage refresh polls the local agy quota server, so the engine
          // reports subscription windows instead of sitting unreported.
          rateLimits: true,
          // Cloud box, Local VM, and VPS computers all mount through the
          // global mcp_config.json above. Only full-auto instances advertise
          // it: print mode has no interactive approval channel, and outside
          // --dangerously-skip-permissions agy auto-denies tools that would
          // prompt (the accept-edits shell behavior in the header comment),
          // so a non-fullAuto mount could never fire. localComputerMcp stays
          // unset on purpose — the host desktop requires per-action human
          // approval (see contracts.ts), which print mode cannot deliver in
          // any mode; that returns with the native ACP path (agy issue #31).
          computerMcp: config.fullAuto,
          // The static agents entry above; each turn's identity rides on its
          // own agy child's env.
          agentsMcp: true,
          // nothing in print mode can ask, so Ask for approval would be a no-op
          askApproval: false,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
          reapChildren(false); // also reap children that hung post-result
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        // A shared slot, so a computer turn's box token never reaches this child.
        const releaseMcpLock = await acquireAntigravityMcpLock(false).granted;
        let restoreMcp = () => {};
        let cwd: string | null = null;
        try {
          restoreMcp = mountAntigravityMcp(null, env);
          cwd = mkdtempSync(join(tmpdir(), "omb-agy-summary-"));
          // stdin like a turn: a summary prompt on argv blows the Windows command line
          const child = spawnCli(
            config.cli,
            ["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-3.6-flash-low"],
            { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
          );
          return await new Promise<string>((resolve, reject) => {
            let result: { status?: unknown; response?: unknown } | null = null;
            let failure: Error | null = null;
            const timer = setTimeout(() => {
              failure = new Error("agy summary timed out");
              killCliTree(child);
            }, 120_000);
            timer.unref?.();
            let buf = "";
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
              buf += chunk;
              let nl;
              while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                try {
                  const o = JSON.parse(line);
                  if (o.event === "result") result = o.result ?? {};
                } catch {}
              }
            });
            let stderr = "";
            child.stderr.on("data", (c) => {
              stderr = (stderr + c).slice(-300);
            });
            child.on("error", (error) => {
              failure ??= error;
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              const response = typeof result?.response === "string" ? result.response.trim() : "";
              if (failure) reject(failure);
              else if (!result) reject(new Error(`agy exited ${code} before result${stderr ? `: ${stderr.trim()}` : ""}`));
              else if (result.status !== "SUCCESS" || !response) reject(new Error(`agy summary failed (${String(result.status)})`));
              else resolve(response);
            });
            child.stdin.end(antigravityStreamUserLine(prompt));
          });
        } finally {
          try {
            restoreMcp();
          } finally {
            releaseMcpLock();
            try {
              if (cwd) rmSync(cwd, { recursive: true, force: true });
            } catch {}
          }
        }
      },
      dispose: async () => {
        disposed = true;
        for (const { stop } of active.values()) stop();
        reapChildren(true); // escalate to SIGKILL — disposal must reap every child
        listeners.clear();
      },
    };
  },
};
