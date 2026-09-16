// Generic ACP (Agent Client Protocol) driver core — one JSON-RPC-2.0-over-
// stdio session runtime that every ACP CLI harness (Grok Build, Gemini CLI,
// …) rides. Modeled on t3code's AcpSessionRuntime + per-agent AcpSupport
// split: the protocol mechanics live here, the per-harness quirks (spawn
// argv, auth method, model catalog, sign-in check) live in a small support
// object. Adding a harness = write server/drivers/acp/<name>.ts.
//
// ACP has no `turn/completed` notification: the `session/prompt` RPC *result*
// is the completion signal (it carries stopReason + usage). Permission
// requests arrive as server→client `session/request_permission` and surface
// as canonical request.opened events, answered fail-closed (nothing approved
// unless the agent explicitly offered an `allow`-kind option — option ORDER
// is never a security contract). session/load REPLAYS history as ordinary
// session/update notifications, so updates are double-gated: nothing emits
// before the prompt is sent, and `_meta.isReplay` updates are dropped.
import { homedir } from "node:os";
import { acpConnection } from "./connection.ts";
import { canReuseWarmSession, warmToolsKey, type WarmEligibilityInput } from "./warm-eligibility.ts";

import { applyCredentialAllowlist } from "../../config.ts";
import { decodeInjectId, LOCAL_HOSTS } from "../local-inject.ts";

const LOCAL_HOST_KEY_ENVS = [
  ...new Set(LOCAL_HOSTS.map((host) => host.apiKeyEnv).filter((key): key is string => Boolean(key))),
];
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";
import { exhaustedWindow, grokRateLimitWindows, isConfirmedNonUsage, usageLimitFromError } from "../rate-limits.ts";

/**
 * A `host::model` pick talks to a loopback server with its own key.
 * Subscription ACP login (grok.com cached_token) must not fail that turn.
 */
export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

/** Translate Windows session paths for a Linux child behind the wsl wrapper
 * (wslpath-style): the session cwd and every MCP server command go through
 * toWslPath. Args are left alone — flags are indistinguishable from paths.
 * Pure so the mapping is unit-testable off-Windows; the sendTurn closure
 * applies it to the session/new + session/load params when the driver opts
 * in via wslPathTranslation. */
export function wslSessionPaths(cwd: string, servers: AcpMcpServer[]): { cwd: string; servers: AcpMcpServer[] } {
  return {
    cwd: toWslPath(cwd),
    servers: servers.map((server) => ({ ...server, command: toWslPath(server.command) })),
  };
}

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  ModelCatalog,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ProviderErrorCode,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { computerProxyEnv } from "../../container-computer.ts";
import { augmentedPath, toWslPath } from "../../env-path.ts";

// Resolved from the server root, never relative to this file: bundling inlines
// this module two directories up, so the `".."` pair here would climb past the
// packaged server dir entirely. See server/proxy-paths.ts.
const COMPUTER_PROXY_PATH = SPAWNED_PROXIES.computer;
import { appendNative, finishNative } from "../native.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  /** Optional home for this instance's sessions. */
  workspace?: string;
}

/** Per-harness specifics — everything that differs between Grok, Gemini, … */
export interface AcpSupport {
  grokInterjections?: boolean;
  warmSessionIdentity?(env: Record<string, string | undefined>): string | null;
  /** Idle TTL for a kept-warm child (default 60s). Tests may shorten. */
  warmIdleMs?: number;
  /** When true the harness can report subscription windows. */
  rateLimits?: boolean;
  /** ACP extension method that returns a billing payload the Grok mapper understands. */
  billingMethod?: string;
  driverKind: string;
  displayName: string;
  /** Omit for subscription CLIs (the default). Custom-only CLIs sit below
   *  the picker-rail divider and have no first-party cloud catalog. */
  access?: "subscription" | "custom";
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Effort levels this harness's CLI accepts, ascending. Omit when it has
   * no reasoning-effort control. Static for the same reason `models` is:
   * describe() runs before any session exists, so there is no _meta to read
   * — eventually both should come from initialize's _meta.modelState. */
  effortLevels?: readonly EffortLevel[];
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Optional live model catalog. A failed lookup keeps the last usable catalog.
   *  `config` is the instance decode so a support can ask the same binary it
   *  will spawn (custom `cli` paths), not whatever happens to be named on PATH. */
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
  ): ModelCatalog | Promise<ModelCatalog>;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Whether models behind this ACP harness can consume a referenced image.
   * Most coding agents can open local files; opt out for text-only agents. */
  images?: boolean;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** How a user installs this harness's CLI; surfaced by the setup UI. */
  install?: EngineInstall;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /** Provider credential variables this ACP child is allowed to inherit. */
  credentialEnv?: readonly string[];
  /** Select the model through a session config option instead of argv, for
   *  harnesses whose ACP subcommand takes no -m (opencode). The agent must
   *  CONFIRM the requested model before we prompt: silently running a model
   *  other than the one the picker shows is the failure this guards. */
  selectModel?: { configId: string };
  /** Mutate the child env in place: strip a key, inject a policy. Receives the
   *  instance config so a support can vary with fullAuto. */
  transformEnv?(env: Record<string, string | undefined>, config: AcpConfig): void;
  /** Mutate the child env after the turn model is known. Catalog refresh and
   *  snapshot share `transformEnv` and must not see a per-turn overlay. */
  applyTurnEnv?(
    env: Record<string, string | undefined>,
    ctx: { model?: string; requestedModel?: string; approval?: SendTurnInput["approval"]; cwd?: string },
  ): void;
  /** Pick the ACP authenticate methodId from initialize's advertised
   * authMethods; return null to skip the authenticate step. */
  pickAuthMethod(authMethods: Array<{ id?: string }>): string | null;
  /** "fail": abort the turn if auth is missing/errors (subscription CLIs).
   *  "continue": proceed anyway (CLIs that work off an ambient login). */
  authFailure: "fail" | "continue";
  /** The child is a Linux process behind the wsl wrapper while orbit's paths
   * are Windows ones: translate the session cwd and MCP server commands
   * (wslpath-style) before session/new. MCP args are left alone — flags are
   * indistinguishable from paths. Only drivers whose CLI crosses into WSL
   * opt in; everyone else sends paths verbatim. Known limit (Codex P1
   * 4002576106, recorded not fixed — a full env/path bridge for MCP-over-WSL
   * is a project, not a patch): MCP server env beyond the driver's
   * credentialEnv and non-command paths do not cross into WSL, so
   * integrations depending on them are unavailable to WSL-crossing turns.
   * Normal turns without integrations are unaffected. */
  wslPathTranslation?: boolean;
  /** win32 only: when the `--version` probe fails, retry once through the
   * CLI this returns (null = no fallback). Lets a bare-CLI override keep
   * working when only the WSL login exists, without the user typing a
   * filepath. The winner is remembered for later spawns until a rescan. */
  wslProbeWrapper?: (cli: string) => string | null;
  /** win32 only, after the wrapper: asynchronously resolve the CLI to the
   * spelling that actually works (null = no resolution). For muse this is
   * the login-shell `command -v` that finds ~/.local/bin, which the
   * non-login `wsl <cmd>` PATH never contains. The resolved winner is
   * probed, then remembered for later spawns exactly like a wrapper win —
   * one resolution steers both the snapshot probe and every turn, so the
   * picker can never disagree with what turns spawn. */
  wslResolveCli?: (cli: string, probeEnv: NodeJS.ProcessEnv) => Promise<string | null>;
  /** snapshot(): can this harness actually run a turn? (env already carries the
   *  merged config). May be async for harnesses that have to ask the CLI. */
  isAuthenticated(env: Record<string, string | undefined>, config: AcpConfig): boolean | Promise<boolean>;
  /** Refuse a first-party cloud turn before spawning when snapshot auth is
   * false. Local injected models deliberately bypass this subscription gate. */
  requireAuthenticationBeforeSpawn?: boolean;
  /** Classify provider-native failures without coupling the core to messages. */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Rewrite a picker id (`omlx::model`) into the CLI-native id before spawn
   * and session/select. Local inject writers live here so the child sees a
   * model it already knows. */
  resolveTurnModel?(
    model: string | undefined,
    env: Record<string, string | undefined>,
  ): string | undefined;
  /** Apply per-session settings between session/new (or session/load) and the
   * first session/prompt. Some CLIs ignore argv and take the model/mode over
   * the wire instead (droid), so this is the only place the pick can land; a
   * throw here fails the turn rather than silently running another model. */
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string;
    config: AcpConfig;
    turn: SendTurnInput;
    /** `session/new` (or `session/load`) advertised model list, verbatim. Some
     * CLIs namespace their ACP model ids differently from their argv `--model`
     * slugs (Cursor answers `default[]` where the CLI calls it `auto`), so a
     * driver that only knows the argv slug cannot form a valid set_model
     * without this. Empty when the agent advertised none. */
    sessionModels: Array<{ modelId?: string; name?: string }>;
    /** Raw `session/new` (or `session/load`) result, verbatim. Carries
     * affordances like `configOptions` for drivers that pin a setting over
     * the wire (grok's reasoning effort); drivers tolerate a missing or
     * foreign shape themselves — core never interprets it. */
    sessionResult?: unknown;
  }): Promise<void>;
}

/**
 * Probe a CLI for its version, with an optional platform fallback wrapper.
 *
 * On win32, when `configCli --version` fails but the driver supplies a
 * `wslProbeWrapper`, the wrapped command is probed; a hit means the CLI
 * lives inside WSL. When that also fails and the driver supplies a
 * `wslResolveCli`, its resolved spelling is probed last. The resolved
 * `{ cli, version }` tells callers which command to spawn until the next
 * rescan. A `null` return means nothing answered. `probe` is injectable so
 * the fallback order is unit-testable.
 */
export async function probeCliVersion(
  configCli: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  wslProbeWrapper: ((cli: string) => string | null) | undefined,
  probe: (target: string, probeEnv: NodeJS.ProcessEnv) => Promise<string | null>,
  wslResolveCli?: (cli: string, probeEnv: NodeJS.ProcessEnv) => Promise<string | null>,
): Promise<{ cli: string; version: string } | null> {
  const version = await probe(configCli, env);
  if (version) return { cli: configCli, version };
  if (platform !== "win32") return null;
  const tried = new Set([configCli]);
  const wrapped = wslProbeWrapper?.(configCli) ?? null;
  if (wrapped && !tried.has(wrapped)) {
    tried.add(wrapped);
    const wrappedVersion = await probe(wrapped, env);
    if (wrappedVersion) return { cli: wrapped, version: wrappedVersion };
  }
  if (!wslResolveCli) return null;
  const resolved = await wslResolveCli(configCli, env);
  if (!resolved || tried.has(resolved)) return null;
  const resolvedVersion = await probe(resolved, env);
  return resolvedVersion ? { cli: resolved, version: resolvedVersion } : null;
}

const INIT_TIMEOUT = 20_000;
// The billing read on a failed turn sits between the user and the error
// chip, so it gets a far shorter leash than the one on a clean turn.
const USAGE_PROBE_TIMEOUT = 5_000;
const SESSION_CONFIG_TIMEOUT = 20_000; // configureSession's per-request default
const NEW_SESSION_TIMEOUT = 30_000;
const LOAD_SESSION_TIMEOUT = 120_000; // history replay on a long thread is slow

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

export function acpChildEnv(support: AcpSupport, config: AcpConfig, environment: NodeJS.ProcessEnv, extraAllowed: readonly string[] = []) {
  const env: Record<string, string | undefined> = { ...environment };
  applyCredentialAllowlist(env, [...(support.credentialEnv ?? []), ...extraAllowed]);
  support.transformEnv?.(env, config);
  return env;
}

/**
 * ACP JSON-RPC-over-stdio driver. Harness differences (argv, auth, catalog)
 * live in `support`; this is the shared handshake and turn runtime.
 */
export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: support.access ?? "subscription",
    },
    install: support.install,
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      // win32 WSL auto-detect: when the bare CLI probe fails but the wrapped
      // one answers, remember the winner for later spawns until a rescan.
      // A later bare success clears it, so a native install always wins.
      let wslCli: string | null = null;
      const effectiveCli = () => wslCli ?? config.cli;
      const probe = (target: string, probeEnv: NodeJS.ProcessEnv): Promise<string | null> =>
        new Promise((resolve) => {
          execCli(target, ["--version"], { timeout: 8000, env: probeEnv }, (err, stdout) =>
            resolve(err ? null : stdout.trim()),
          );
        });
      const childEnv = (extraAllowed: readonly string[] = []) => acpChildEnv(support, config, {
        ...process.env,
        ...input.environment,
        PATH: augmentedPath(),
      }, extraAllowed);
      let models = support.models;
      const refreshModels = async () => {
        if (!support.resolveModels) return;
        try {
          const resolved = await support.resolveModels(childEnv(LOCAL_HOST_KEY_ENVS), config);
          if (resolved.options.length) models = resolved;
        } catch {
          // Keep the last usable catalog when an optional discovery source is down.
        }
      };
      await refreshModels();
      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        stop: () => void;
        steer: (text: string) => Promise<boolean>;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, (behavior: string, source?: "user" | "timeout" | "system") => string | null>;
      }
      const active = new Map<string, Turn>();
      const billingStops = new Set<() => void>();
      // SPEED-4: at most one IDLE warm child per instance. Active turns borrow
      // the connection (idle is null while borrowed) so TTL / eviction never
      // kills a live prompt. Grok alone supplies warmSessionIdentity.
      type WarmIdle = {
        connection: ReturnType<typeof acpConnection>;
        eligibility: WarmEligibilityInput;
        sessionId: string;
        model: string | null;
        threadId: string;
        timer?: ReturnType<typeof setTimeout>;
        ready: Promise<void>;
      };
      let idleWarm: WarmIdle | null = null;
      let disposed = false;
      const warmIdleMs = support.warmIdleMs ?? 60_000;
      const discardIdle = (entry: WarmIdle | null = idleWarm) => {
        if (!entry) return;
        if (idleWarm === entry) idleWarm = null;
        clearTimeout(entry.timer);
        killCliTree(entry.connection.child);
      };
      const stashIdle = (entry: Omit<WarmIdle, "timer">) => {
        if (idleWarm && idleWarm.connection !== entry.connection) discardIdle(idleWarm);
        const stored: WarmIdle = { ...entry };
        idleWarm = stored;
        stored.timer = setTimeout(() => {
          if (idleWarm === stored) discardIdle(stored);
        }, warmIdleMs);
        stored.timer.unref?.();
      };

      const emit = (event: RuntimeEvent) => {
        finishNative(event);
        for (const l of [...listeners]) l(event);
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      // ACP session mcpServers: stdio is the baseline every ACP agent
      // supports (mcpCapabilities.http/.sse only add EXTRA transports), so
      // an injected stdio proxy — e.g. the peer-agent comms tool — attaches
      // fine here. env is the ACP {name,value}[] shape.
      const acpMcpServers = (turn: SendTurnInput) => {
        const servers: AcpMcpServer[] = [];
        const acpEnv = (env: Record<string, string>) =>
          Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
        const agents = turn.integrations?.agents;
        if (agents) {
          servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
        }
        const composio = turn.integrations?.composio;
        if (composio) {
          servers.push({
            name: "composio",
            command: composio.command,
            args: composio.args,
            env: acpEnv(composio.env),
          });
        }
        const browser = turn.integrations?.browser;
        if (browser) {
          servers.push({ name: "browser", command: browser.command, args: browser.args, env: acpEnv(browser.env) });
        }
        // The bot's computer, mounted exactly like the Claude driver does.
        // Cloud boxes use the REST adapter; host and sandbox Cua connections
        // expose Cua Driver's official MCP server directly.
        const computer = turn.integrations?.computer;
        if (computer) {
          servers.push({
            name: "computer",
            command: process.execPath,
            args: [COMPUTER_PROXY_PATH],
            env: acpEnv({ ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(computer) }),
          });
        } else if (turn.integrations?.localComputer) {
          const local = turn.integrations.localComputer;
          servers.push({
            name: "computer",
            command: local.command,
            args: local.args,
            env: acpEnv(local.env ?? {}),
          });
        }
        return servers;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (disposed) throw new Error("provider disposed");
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        if (controlsHost && config.fullAuto) {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = newId();
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const env = childEnv(LOCAL_HOST_KEY_ENVS);
        // Reserve before the first await: two concurrent first turns would
        // both pass the guard, spawn twice, and the second active.set would
        // orphan the first turn's controls. The real entry after spawn
        // replaces this placeholder; the gap between is synchronous, and
        // every early exit below releases it.
        active.set(threadId, { stop: () => {}, steer: async () => false, interrupt: () => {}, turnId, asks: new Map() });
        // The pre-spawn section runs as one unit so the reservation above is
        // released on every early exit; the sync gap between it and the real
        // entry below admits no interleaving, and only our own turnId is
        // ever released.
        const prelude = await (async () => {
          try {
            if (
              support.requireAuthenticationBeforeSpawn
              && !skipSubscriptionAuthForLocalInject(turn.model)
              && !(await support.isAuthenticated(env, config))
            ) {
              emit({ ...base(threadId, turnId), type: "turn.started" });
              emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
              emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null });
              return { early: true as const };
            }
            const resolvedModel = support.resolveTurnModel?.(turn.model, env);
            support.applyTurnEnv?.(env, { model: resolvedModel, requestedModel: turn.model, approval: turn.approval, cwd });
            const allowed = new Set(support.credentialEnv ?? []);
            for (const key of LOCAL_HOST_KEY_ENVS) {
              if (!allowed.has(key)) delete env[key];
            }
            const cliTurn =
              resolvedModel !== undefined && resolvedModel !== turn.model
                ? { ...turn, model: resolvedModel }
                : turn;
            // A Linux child behind the wsl wrapper cannot use Windows paths, so
            // the session params (not the local spawn, which stays Windows-side)
            // cross translated when the driver opts in. toWslPath rewrites only
            // drive-letter and wsl$ paths, so POSIX values pass through even
            // where the flag is on — off-Windows this changes nothing for real
            // paths.
            const sessionPaths = support.wslPathTranslation === true
              ? wslSessionPaths(cwd, acpMcpServers(turn))
              : { cwd, servers: acpMcpServers(turn) };
            // Turns can precede any snapshot() (startup routines, API-driven
            // turns), and the auth gate above never probes — without this the
            // first such turn on win32 would spawn the bare CLI that only
            // exists inside WSL.
            await ensureCli(env);
            return { early: false as const, cliTurn, sessionCwd: sessionPaths.cwd, mcpServers: sessionPaths.servers };
          } finally {
            if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
          }
        })();
        if (prelude.early) return { turnId };
        const { cliTurn, sessionCwd, mcpServers } = prelude;
        // Re-reserve immediately: prelude's finally cleared the placeholder, and
        // warm-ready / cold spawn may await. Only our turnId is ever released.
        let canceledBeforePrompt = false;
        active.set(threadId, {
          stop: () => { canceledBeforePrompt = true; },
          steer: async () => false,
          interrupt: () => { canceledBeforePrompt = true; },
          turnId,
          asks: new Map(),
        });
        const identity = support.warmSessionIdentity?.(env) ?? null;
        const eligibility: WarmEligibilityInput | null =
          identity && !skipSubscriptionAuthForLocalInject(turn.model)
            ? {
                identity,
                threadId,
                cli: effectiveCli(),
                argsKey: support.spawnArgs(config, cliTurn).join("\0"),
                cwd,
                sessionCwd,
                model: cliTurn.model,
                effort: cliTurn.effort,
                approval: turn.approval,
                fullAuto: config.fullAuto === true,
                toolsKey: warmToolsKey(turn.integrations as any),
              }
            : null;
        let reused: WarmIdle | undefined;
        if (idleWarm) {
          const candidate = idleWarm;
          const eligible =
            !!eligibility
            && candidate.connection.healthy
            && canReuseWarmSession(candidate.eligibility, eligibility, candidate.sessionId, turn.resumeCursor);
          if (!eligible) {
            discardIdle(candidate);
          } else {
            // Borrow: clear the idle slot so TTL cannot kill an active turn.
            clearTimeout(candidate.timer);
            idleWarm = null;
            reused = candidate;
          }
        }
        if (reused) {
          const warmChild = reused.connection.child;
          active.set(threadId, {
            stop: () => {
              canceledBeforePrompt = true;
              killCliTree(warmChild);
            },
            steer: async () => false,
            interrupt: () => {
              canceledBeforePrompt = true;
              killCliTree(warmChild);
            },
            turnId,
            asks: new Map(),
          });
          // ready never rejects: billing probe uses .catch(() => {}) when built
          // (see settle). Health check below is the real warm-reuse fallback.
          await reused.ready;
          if (canceledBeforePrompt || disposed || active.get(threadId)?.turnId !== turnId) {
            if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
            if (reused) killCliTree(reused.connection.child);
            if (disposed) throw new Error("provider disposed");
            // Canceled while awaiting billing readiness: settle once without
            // recursively retrying sendTurn (that would run the canceled prompt).
            emit({ ...base(threadId, turnId), type: "turn.started" });
            emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled", cost: null });
            return { turnId };
          }
          if (!reused || !reused.connection.healthy) {
            if (reused) killCliTree(reused.connection.child);
            reused = undefined;
          }
        }
        if (canceledBeforePrompt || disposed) {
          if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
          if (disposed) throw new Error("provider disposed");
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled", cost: null });
          return { turnId };
        }
        let connection: ReturnType<typeof acpConnection>;
        try {
          connection = reused?.connection ?? acpConnection(spawnCli(effectiveCli(), support.spawnArgs(config, cliTurn), {
            cwd, env, stdio: ["pipe", "pipe", "pipe"],
          }), (dir, msg) => appendNative(threadId, { dir, source: SOURCE, msg }));
        } catch (error) {
          if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
          throw error;
        }
        const child = connection.child;

        const state = { settled: false, promptSent: false, text: "" };
        const interjections = new Set<string>();
        const interjectionWaiters = new Map<string, (delivered: boolean) => void>();
        // Steer prompts Grok has not answered. If the running prompt ends
        // first, Grok runs each one as its own prompt inside this turn.
        const queuedSteers = new Map<Promise<any>, () => void>();
        const asks = new Map<string, (behavior: string, source?: "user" | "timeout" | "system") => string | null>();
        let sessionId: string | null = reused?.sessionId ?? null;
        let selectedModel: string | null = reused?.model ?? null;
        let interruptTimer: ReturnType<typeof setTimeout> | null = null;
        const { send, request } = connection;
        const stop = () => {
          if (idleWarm?.connection === connection) discardIdle(idleWarm);
          else killCliTree(child);
        };

        const steer = (text: string): Promise<boolean> => {
          if (!support.grokInterjections || !state.promptSent || state.settled || interruptTimer || asks.size || !sessionId) {
            return Promise.resolve(false);
          }
          return new Promise<boolean>((resolve) => {
            const reply = request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
            queuedSteers.set(reply, () => resolve(true));
            reply.then(
              (result) => {
                queuedSteers.delete(reply);
                const promptId = result?._meta?.promptId;
                if (result?.stopReason === "end_turn" || interjections.delete(promptId)) return resolve(true);
                if (!promptId) return resolve(false);
                // The result can beat its interjection notification.
                let timer: ReturnType<typeof setTimeout> | undefined;
                const finish = (delivered: boolean) => {
                  clearTimeout(timer);
                  interjectionWaiters.delete(promptId);
                  resolve(delivered);
                };
                interjectionWaiters.set(promptId, finish);
                timer = setTimeout(() => finish(false), 1_000);
                timer.unref?.();
              },
              () => {
                queuedSteers.delete(reply);
                resolve(false);
              },
            );
          });
        };

        /** Emit buffered assistant text as its own item, then clear it. */
        const flushAssistantText = () => {
          const text = state.text;
          state.text = "";
          if (!text.trim()) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };

        const settle = (ok: boolean, stopReason: string | null, readBilling = false) => {
          if (state.settled) return;
          state.settled = true;
          if (interruptTimer) clearTimeout(interruptTimer);
          for (const finish of [...asks.values()]) finish("cancel", "system");
          for (const finish of interjectionWaiters.values()) finish(false);
          connection.rejectPending("turn settled");
          // Drop turn-scoped handlers so late untagged session/update chunks
          // cannot attach after completion. Untagged same-session chunks that
          // arrive after the next turn arms promptSent cannot be distinguished
          // from that turn's chunks — ACP gives no Orbit turnId on the wire.
          connection.onNotification = () => {};
          // askPermission-shaped cancel is only valid for session/request_permission;
          // other methods get a JSON-RPC error so the CLI does not mis-parse the result.
          connection.onRequest = (msg) => {
            if (msg.method === "session/request_permission") {
              send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
              return;
            }
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "no active turn" } });
          };
          const keep = Boolean(
            eligibility
            && ok
            && stopReason === null
            && typeof sessionId === "string"
            && connection.healthy
            && !disposed
            && !interruptTimer
            && !canceledBeforePrompt
          );
          // Establish billing readiness BEFORE publishing turn.completed so a
          // synchronous completion listener cannot sendTurn before ready is set.
          let ready: Promise<void> = Promise.resolve();
          if (readBilling && support.billingMethod) {
            billingStops.add(stop);
            ready = request(support.billingMethod, {}, INIT_TIMEOUT).then((result) => {
              const windows = grokRateLimitWindows(result);
              if (windows.length > 0) {
                emit({ ...base(threadId, turnId), type: "account.rate-limits.updated", windows });
              }
            }).catch(() => {}).finally(() => {
              billingStops.delete(stop);
              // Keep path must not kill the reused child; cold path stops here.
              if (!keep) stop();
            });
          } else if (!keep) {
            stop();
          }
          if (keep && typeof sessionId === "string" && eligibility) {
            stashIdle({
              connection,
              eligibility,
              sessionId,
              model: selectedModel,
              threadId,
              ready,
            });
          }
          active.delete(threadId);
          flushAssistantText();
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
        };

        // Whether this turn could have spent a subscription window at all.
        // A local inject talks to a loopback endpoint on someone else's key.
        const billsSubscription = support.rateLimits === true && !skipSubscriptionAuthForLocalInject(turn.model);

        /** A rejection that names nothing still leaves the account's own
         *  numbers to read — and a failed turn is the one path that never
         *  read them, because settle() only bills a turn that finished.
         *
         *  Two turns are skipped. A `host::model` one never touched the
         *  subscription, so billing would explain a loopback failure with the
         *  wrong account; and anything that failed before the prompt went out
         *  — session setup, model pinning — has its own actionable message
         *  that a spent window must not be allowed to overwrite. */
        const probeUsageLimit = async (): Promise<{ resetsAt: number | null } | null> => {
          if (!support.billingMethod || !state.promptSent || !billsSubscription) return null;
          if (child.exitCode !== null || child.killed) return null;
          try {
            const windows = grokRateLimitWindows(await request(support.billingMethod, {}, USAGE_PROBE_TIMEOUT));
            if (windows.length > 0) {
              emit({ ...base(threadId, turnId), type: "account.rate-limits.updated", windows });
            }
            const spent = exhaustedWindow(windows);
            return spent ? { resetsAt: spent.resetsAt } : null;
          } catch {
            return null;
          }
        };

        // server→client permission request → canonical request.opened
        const handleServerRequest = (msg: any) => {
          if (msg.method !== "session/request_permission") {
            // never leave an unknown server request hanging — the agent blocks
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = msg.params ?? {};
          flushAssistantText();
          const options: Array<{ optionId?: string; kind?: string }> = Array.isArray(params.options) ? params.options : [];
          // exact `_once`, never a prefix match: agents advertise `<want>_always`
          // in any order, and that grant lives inside the provider CLI, where
          // this app never recorded it and cannot revoke it
          const optionFor = (want: "allow" | "reject") =>
            options.find((o) => o.kind === `${want}_once` && typeof o.optionId === "string")?.optionId ?? null;
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no "${want}_once" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          if (config.fullAuto) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const kind = String(toolCall.kind ?? "");
          const tool = kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool";
          const summary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool).slice(0, 200);
          const requestId = newId();
          const finish = (behavior: string, source: "user" | "timeout" | "system" = "user") => {
            if (!asks.delete(requestId)) return null;
            clearTimeout(timer);
            const want = behavior === "allow" ? "allow" : "reject";
            const optionId = behavior === "cancel" ? null : optionFor(want);
            if (behavior !== "cancel" && !optionId) missing(want);
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: controlsHost ? "local-computer" : undefined,
            });
            return optionId;
          };
          const timer = setTimeout(() => {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish("deny", "timeout");
          }, 15 * 60_000);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool,
            summary,
            approvalScope: controlsHost ? "local-computer" : undefined,
          });
        };

        const handleNotification = (msg: any) => {
          if (support.grokInterjections && msg.method === "_x.ai/session/interjection" && msg.params?.sessionId === sessionId) {
            flushAssistantText();
            const waiter = interjectionWaiters.get(msg.params.interjectionId);
            if (waiter) waiter(true);
            else interjections.add(msg.params.interjectionId);
          }
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          // Evidence-supported gates only: prompt arming, explicit replay flag,
          // and a present sessionId that disagrees. Orbit's turnId is never sent
          // to the provider, so _meta.turnId is not a shared namespace.
          if (state.settled || !state.promptSent || p._meta?.isReplay === true || (p.sessionId && p.sessionId !== sessionId)) return;
          const u = p.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                state.text += delta;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              }
              break;
            }
            case "tool_call": {
              flushAssistantText();
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: u.toolCallId,
                title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
              });
              break;
            }
            case "tool_call_update": {
              if (u.status === "completed" || u.status === "failed") {
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: u.toolCallId,
                  ok: u.status !== "failed",
                });
              }
              break;
            }
          }
        };

        connection.onRequest = handleServerRequest;
        connection.onNotification = handleNotification;
        connection.onError = (e) => {
          if (state.settled) return;
          emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, effectiveCli()) });
          settle(false, "spawn_error");
        };
        connection.onClose = (code, stderr) => {
          if (idleWarm?.connection === connection) discardIdle(idleWarm);
          if (!state.settled) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: `${DRIVER_KIND} exited ${code} before the prompt result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}` });
            settle(false, "exit_before_result");
          }
        };

        const interrupt = () => {
          if (sessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
          else stop();
          // armed once: the grace runs from the FIRST cancel, so pressing
          // Stop again cannot push the settle further out
          if (interruptTimer) return;
          interruptTimer = setTimeout(() => settle(true, "cancelled"), 5_000);
          interruptTimer.unref?.();
        };
        active.set(threadId, { stop, steer, interrupt, turnId, asks });
        if (canceledBeforePrompt || disposed) {
          active.delete(threadId);
          if (idleWarm?.connection === connection) discardIdle(idleWarm);
          else killCliTree(child);
          if (disposed) throw new Error("provider disposed");
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled", cost: null });
          return { turnId };
        }
        emit({ ...base(threadId, turnId), type: "turn.started" });

        (async () => {
          try {
            if (canceledBeforePrompt) {
              settle(true, "cancelled");
              return;
            }
            let init: any = null;
            let resumeFailed = false;
            let sessionResult: any = null;
            if (!reused) {
            init = await request(
              "initialize",
              { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
              INIT_TIMEOUT,
            );
            const methods: Array<{ id?: string }> = Array.isArray(init?.authMethods) ? init.authMethods : [];
            const methodId = support.pickAuthMethod(methods);
            if (!skipSubscriptionAuthForLocalInject(turn.model)) {
              if (methodId) {
                try {
                  await request("authenticate", { methodId }, INIT_TIMEOUT);
                } catch {
                  if (support.authFailure === "fail") throw new Error(support.loginNote);
                  // else: proceed on an ambient login
                }
              } else if (support.authFailure === "fail") {
                throw new Error(support.loginNote);
              }
            }

            // After Orbit compaction the harness omits resumeCursor so this
            // path starts a new session and injects the bounded transcript.
            const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            if (cursor) {
              try {
                sessionResult = await request(
                  "session/load",
                  { sessionId: cursor, cwd: sessionCwd, mcpServers },
                  LOAD_SESSION_TIMEOUT,
                );
                sessionId = cursor;
              } catch {
                resumeFailed = true;
              }
            }
            if (!sessionId) {
              sessionResult = await request("session/new", { cwd: sessionCwd, mcpServers }, NEW_SESSION_TIMEOUT);
              sessionId = typeof sessionResult?.sessionId === "string" ? sessionResult.sessionId : null;
              if (!sessionId) throw new Error("session/new returned no sessionId");
            }
            }
            // Cold path throws if session/new omits sessionId; warm path borrows
            // a string sessionId. Establish the invariant for configureSession.
            if (typeof sessionId !== "string" || !sessionId) {
              throw new Error("session/new returned no sessionId");
            }
            const activeSessionId: string = sessionId;
            let sessionStarted = false;
            const emitSessionStarted = () => {
              if (sessionStarted) return;
              sessionStarted = true;
              emit({
                ...base(threadId, turnId),
                type: "session.started",
                sessionId: activeSessionId,
                model: selectedModel ?? init?._meta?.modelState?.currentModelId ?? cliTurn.model ?? null,
              });
            };

            try {
              if (!reused && support.selectModel) {
                const { configId } = support.selectModel;
                const currentOf = (r: any) =>
                  (Array.isArray(r?.configOptions) ? r.configOptions : []).find((o: any) => o?.id === configId)
                    ?.currentValue ?? null;
                selectedModel = currentOf(sessionResult);
                if (cliTurn.model && cliTurn.model !== selectedModel) {
                  selectedModel = currentOf(
                    await request(
                      "session/set_config_option",
                      { sessionId: activeSessionId, configId, value: cliTurn.model },
                      INIT_TIMEOUT,
                    ),
                  );
                  // an agent that answers OK but keeps its old model is worse than
                  // one that errors: it burns a paid turn on the wrong thing
                  if (selectedModel !== cliTurn.model) {
                    throw new Error(
                      `${DRIVER_KIND} did not switch to ${cliTurn.model} (still ${selectedModel ?? "unknown"})`,
                    );
                  }
                }
              }

              if (!reused && support.configureSession) {
                await support.configureSession({
                  request: (method, params, timeoutMs) =>
                    request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT),
                  sessionId: activeSessionId,
                  config,
                  turn: cliTurn,
                  sessionModels: Array.isArray(sessionResult?.models?.availableModels)
                    ? sessionResult.models.availableModels
                    : [],
                  sessionResult,
                });
                // initialize's currentModelId is the CLI default (grok-4.6),
                // not the model this turn asked for. After a successful pin,
                // report the slug we set so the UI does not claim otherwise.
                if (!selectedModel && cliTurn.model) selectedModel = cliTurn.model;
              }
            } catch (error) {
              // session.started is the only place the resume cursor is recorded,
              // so a rejected setting must not orphan a session we just created.
              emitSessionStarted();
              throw error;
            }
            emitSessionStarted();
            state.promptSent = true;
            const promptTurn = resumeFailed && turn.resumeFallback
              ? { ...cliTurn, text: turn.resumeFallback.text }
              : cliTurn;
            const text = support.buildPromptText
              ? support.buildPromptText(promptTurn)
              : promptTurn.system
                ? `${promptTurn.system}\n\n${promptTurn.text}`
                : promptTurn.text;
            let result = await request("session/prompt", {
              sessionId: activeSessionId,
              prompt: [{ type: "text", text }],
            });
            // opencode 1.18.18 reports usage at the result root; grok and
            // gemini put it under _meta. Read both rather than lose the count.
            const usage = result?.usage ?? result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
              });
            }
            while (result?.stopReason === "end_turn" && queuedSteers.size) {
              flushAssistantText();
              const replies = [...queuedSteers.keys()];
              for (const accept of queuedSteers.values()) accept();
              queuedSteers.clear();
              // an interjected reply only acknowledges; the prompt it joined decides the outcome
              result = (await Promise.all(replies)).findLast((r) => r?._meta?.completionKind !== "removedFromQueue") ?? result;
            }
            const reason = result?.stopReason;
            if (reason === "end_turn") settle(true, null, true);
            else if (reason === "cancelled") settle(true, "cancelled", true);
            else settle(false, reason ?? "failed", true);
          } catch (e) {
            if (!state.settled) {
              const message = e instanceof Error ? e.message : String(e);
              const code = support.classifyError?.(e);
              // Authentication setup is a user action, not a retry. The
              // classifier is preferred; loginNote remains a compatibility
              // fallback for existing ACP supports.
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || message === support.loginNote;
              const named = needsAuth || !(e instanceof Error)
                ? null
                : usageLimitFromError(e, billsSubscription);
              // A rejection that names the limit but not its end still leaves
              // billing to ask, so the probe runs for that too — but not when
              // the provider already ruled a usage limit out.
              const ruledOut = e instanceof Error && isConfirmedNonUsage(e);
              const probed = needsAuth || ruledOut || named?.resetsAt != null ? null : await probeUsageLimit();
              // The probe awaited, and a child that closed meanwhile has
              // already settled this turn and reported its own failure.
              if (state.settled) return;
              const usageLimit = named?.resetsAt != null ? named : probed ?? named;
              const failure: Extract<RuntimeEvent, { type: "runtime.error" }> = {
                ...base(threadId, turnId),
                type: "runtime.error",
                message,
                ...(needsAuth ? { setup: true } : {}),
              };
              if (usageLimit) failure.usageLimit = usageLimit;
              emit(failure);
              settle(false, needsAuth ? "auth_required" : "rpc_error");
            }
          }
        })();

        return { turnId };
      };

      // Shared by snapshot() and the pre-spawn path: resolves (and
      // remembers) the WSL fallback, so a first turn that never saw a
      // snapshot still launches the working wrapper. snapshot() always
      // probes fresh and refreshes the memo; turns reuse the memo and only
      // the first pre-snapshot turn pays for a probe.
      let cliProbe: Promise<{ cli: string; version: string } | null> | null = null;
      const resolveCli = (probeEnv: NodeJS.ProcessEnv) => {
        const started = probeCliVersion(config.cli, probeEnv, process.platform, support.wslProbeWrapper, probe, support.wslResolveCli).then(
          (probed) => {
            // Side-effect, not a pure read: steers effectiveCli() for all
            // later spawns until the next rescan clears or replaces it.
            wslCli = probed && probed.cli !== config.cli ? probed.cli : null;
            return probed;
          },
        );
        cliProbe = started;
        return started;
      };
      const ensureCli = (probeEnv: NodeJS.ProcessEnv): Promise<{ cli: string; version: string } | null> =>
        cliProbe ?? (cliProbe = resolveCli(probeEnv));

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        const probed = await resolveCli(env);
        if (!probed) return { state: "unavailable", reason: `\`${effectiveCli()}\` CLI not found` };
        return { state: "available", version: probed.version, authenticated: await support.isAuthenticated(env, config) };
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return models;
        },
        refreshModels: support.resolveModels ? refreshModels : undefined,
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            queueing: support.grokInterjections === true,
            rateLimits: support.rateLimits === true,
            sessionModelSwitch: "unsupported",
            agentsMcp: true,
            computerMcp: true,
            composioMcp: true,
            browserMcp: true,
            images: support.images !== false,
            effortLevels: support.effortLevels,
            localComputerMcp: !config.fullAuto,
            askApproval: !config.fullAuto,
          },
          sendTurn,
          steer: support.grokInterjections
            ? async (threadId, text) => active.get(threadId)?.steer(text) ?? false
            : undefined,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable"; // settled, timed out, or turn gone
            const optionId = finish(decision.behavior === "allow" ? "allow" : "deny", "user");
            if (decision.behavior !== "allow") return "rejected";
            // A cancelled ask granted nothing. Reporting "allowed-once" here puts a
            // user-approved row in the decision log for a call that never ran.
            return optionId ? "allowed-once" : "unavailable";
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { stop } of active.values()) stop();
            for (const stop of billingStops) stop();
            discardIdle();
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          disposed = true;
          discardIdle();
          for (const { stop } of active.values()) stop();
          for (const stop of billingStops) stop();
          listeners.clear();
        },
      };
    },
  };
}
