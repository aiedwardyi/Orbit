// MSP driver runtime: Meta `muse serve` speaks MSP (session/start,
// turn/start, view notifications), not ACP, so the ACP core cannot drive
// it — this is the minimal session/turn runtime for that host. Phase 1:
// spawn, initialize, session start/resume, one text turn, interrupt,
// approvals + userInput answers. Effort/model switching and account usage
// windows build on the same channel. Never extend acp/core.ts.
import { homedir } from "node:os";

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ModelCatalog,
  ProviderDriver,
  ProviderErrorCode,
  ProviderInstance,
  ProviderSnapshot,
  RequestOutcome,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { applyCredentialAllowlist } from "../../config.ts";
import { computerProxyEnv } from "../../container-computer.ts";
import { augmentedPath, toWslPath } from "../../env-path.ts";
import { execCli, killCliTree, spawnCli } from "../../procs.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import { isWslCommand, withWslProbeReason, wslBlockedReason, wslProbeAllowed } from "../../wsl-gate.ts";
import { startTurnTimer } from "../../turn-timing.ts";
import { finishNative } from "../native.ts";
import { museUsageReport } from "../rate-limits.ts";
import { createMspChannel, uuidv7, type MspChannel } from "./protocol.ts";

const INIT_TIMEOUT = 20_000;
const SESSION_TIMEOUT = 30_000;
const INTERRUPT_GRACE_MS = 5_000;
const ASK_TIMEOUT_MS = 15 * 60_000;

const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

/** Resumed-session poison: provider-private history the active route cannot
 * replay, including encrypted reasoning from a switched model. A fresh
 * session recovers; anything else fails exactly as before. */
const INCOMPATIBLE_HISTORY =
  /provider-private history is incompatible|reasoning\s+[`'"]?encrypted_content[`'"]?\s+was not issued to this caller/i;

export interface MspMuseConfig {
  cli: string;
  fullAuto: boolean;
  workspace?: string;
}

export interface MspSupport {
  driverKind: string;
  displayName: string;
  /** Static catalog; model/list stays the live source of truth (see muse.ts). */
  models: ModelCatalog;
  /** Effort tiers the host accepts; absent = the selector stays hidden. */
  effortLevels?: readonly EffortLevel[];
  defaultCli: string;
  nativeSource: string;
  loginNote: string;
  install?: EngineInstall;
  credentialEnv?: readonly string[];
  transformEnv?(env: Record<string, string | undefined>, config: MspMuseConfig): void;
  isAuthenticated(env: Record<string, string | undefined>, config: MspMuseConfig): boolean | Promise<boolean>;
  requireAuthenticationBeforeSpawn?: boolean;
  /** Map an MSP turn error to a provider code (auth shapes). */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** win32 only: wrapper + resolver shared with the ACP muse driver. */
  wslProbeWrapper?: (cli: string) => string | null;
  wslResolveCli?: (cli: string, probeEnv: NodeJS.ProcessEnv) => Promise<string | null>;
  /** Idle TTL for a prewarmed host (default 60s). Tests may shorten. */
  warmIdleMs?: number;
}

const decodeConfig = (raw: unknown): MspMuseConfig => {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "",
    fullAuto: o.fullAuto === true,
    workspace: typeof o.workspace === "string" ? o.workspace : undefined,
  };
};

interface ApprovalChoice {
  choiceId?: string;
  decision?: string;
  label?: string;
}

interface AskBase {
  requestId: string;
  finish: (behavior: "allow" | "deny" | "answer", source: AskSource, message?: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ApprovalAsk extends AskBase {
  kind: "approval";
  approvalId: string;
  requirementId: unknown;
  choices: ApprovalChoice[];
}

interface UserInputAsk extends AskBase {
  kind: "userInput";
  userInputId: string;
  questions: Array<{ id?: string }>;
}

type AskSource = "user" | "timeout" | "system";

type Ask = ApprovalAsk | UserInputAsk;

/** Item ids the host opened, for routing item/delta to a text stream. */
type ItemKinds = Map<string, string>;

const textStreamFor = (kinds: ItemKinds, itemId: string, field: unknown) => {
  if (field !== undefined && field !== null && field !== "text") return null;
  const kind = kinds.get(itemId);
  if (kind === "reasoning") return "reasoning_text" as const;
  // agentMessage streams here; unknown kinds stream generically (SS4.10)
  // except tool calls, whose output is fetched via item/readOutput, not text.
  if (kind !== undefined && kind !== "agentMessage") return null;
  return "assistant_text" as const;
};

type MspIntegrations = NonNullable<SendTurnInput["integrations"]>;

/** One session MCP server, stdio arm of the schema's SessionMcpServerConfig.
 * `transport` is required: the union is closed, so an arm without it fails
 * session/start decode. */
export interface MspMcpServer {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Behind the `wsl` wrapper the muse host is a Linux process, so a server
 * command it spawns must be named in /mnt/c form.
 *
 * Args are deliberately NOT translated. The command is a Windows exe reached
 * through WSL interop, and interop hands argv over verbatim: a /mnt/c arg
 * arrives at node.exe as the nonexistent `C:\mnt\c\...` and the server dies
 * on spawn. Same for env: those values are read by the Windows child. */
export function translateMspServerForWsl(server: MspMcpServer): MspMcpServer {
  return { ...server, command: toWslPath(server.command) };
}

/** Every Orbit MCP server this turn mounts, in the MSP session-config shape.
 * Mirrors the ACP core's set so a Muse bot has the same hands as a Grok
 * Build one; `undefined` when the turn mounts nothing, so the `config` key
 * stays off the wire entirely. */
export function mspMcpServers(
  integrations: MspIntegrations | undefined,
  opts: { wsl: boolean },
): Record<string, MspMcpServer> | undefined {
  const servers: Record<string, MspMcpServer> = {};
  const add = (name: string, server: { command: string; args: string[]; env?: Record<string, string> }) => {
    const stdio: MspMcpServer = {
      transport: "stdio",
      command: server.command,
      args: server.args,
      env: server.env ?? {},
    };
    servers[name] = opts.wsl ? translateMspServerForWsl(stdio) : stdio;
  };
  if (integrations?.agents) add("agents", integrations.agents);
  if (integrations?.composio) add("composio", integrations.composio);
  if (integrations?.browser) add("browser", integrations.browser);
  if (integrations?.terminal) add("terminal", integrations.terminal);
  if (integrations?.phone) add("phone", integrations.phone);
  // The bot's computer, mounted exactly as acp/core.ts does it: a cloud box
  // goes through the REST adapter proxy, host and sandbox Cua connections
  // expose Cua Driver's own MCP server directly.
  if (integrations?.computer) {
    add("computer", {
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: { ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(integrations.computer) },
    });
  } else if (integrations?.localComputer) {
    add("computer", integrations.localComputer);
  }
  return Object.keys(servers).length ? servers : undefined;
}

const initializeHost = async (channel: MspChannel) => {
  await channel.request(
    "initialize",
    {
      protocolVersion: 1,
      clientInfo: { name: "orbit", version: "1.0.8" },
      // Schema key is `capabilities`; the ACP-shaped
      // clientCapabilities rides along (tolerated live).
      // sessionMcp is a GRANTED capability: without it here the host
      // fails session/start with capabilityRequired the moment the
      // params carry any MCP server.
      capabilities: { userInputDialogs: false, requestedCapabilities: ["sessionMcp"] },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    },
    INIT_TIMEOUT,
  );
  channel.notify("initialized", {});
};

/** First approved-* choice for allow, first denied-* for deny, ends as fallback. */
const pickChoice = (choices: ApprovalChoice[], want: "allow" | "deny"): ApprovalChoice | null => {
  if (!choices.length) return null;
  const prefix = want === "allow" ? "approved" : "denied";
  return (
    choices.find((c) => typeof c.decision === "string" && c.decision.startsWith(prefix)) ??
    (want === "allow" ? choices[0] : choices[choices.length - 1])
  );
};

/** The host already settled this approval; a late decide is not a turn failure. */
const isSettledApprovalError = (err: unknown): boolean =>
  err instanceof Error && /(already resolved|is stale)/.test(err.message);

/** Muse took the decision (intake passed) but failed to ack it durably. */
const isDecideSettlementError = (err: unknown): boolean =>
  err instanceof Error && /approval decide settlement failed/.test(err.message);

export function createMspDriver(support: MspSupport): ProviderDriver<MspMuseConfig> {
  const DRIVER_KIND = support.driverKind;
  const withCli = (raw: unknown): MspMuseConfig => {
    const decoded = decodeConfig(raw);
    return { ...decoded, cli: decoded.cli || support.defaultCli };
  };

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: "subscription",
    },
    install: support.install,
    models: support.models,
    decodeConfig: withCli,
    defaultConfig: () => withCli({}),

    async create(input: DriverCreateInput<MspMuseConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const baseCli = config.cli || support.defaultCli;
      let wslCli: string | null = null;
      // Last real answer, replayed while the WSL gate is shut so a sleeping
      // WSL engine does not flap to "not found" on every passive refresh.
      let lastSnapshot: ProviderSnapshot | null = null;
      const effectiveCli = () => wslCli ?? baseCli;
      const isWslCli = () => /^\s*wsl(\.exe)?(\s|$)/i.test(effectiveCli());
      const probe = (target: string, probeEnv: NodeJS.ProcessEnv): Promise<string | null> =>
        new Promise((resolve) => {
          if (isWslCommand(target) && !wslProbeAllowed()) return resolve(null);
          execCli(target, ["--version"], { timeout: 8000, env: probeEnv }, (err, stdout) =>
            resolve(err ? null : stdout.trim()),
          );
        });
      // Same 3-step fallback as the ACP core: bare, wrapped, resolved — one
      // resolution steers snapshot probes and every turn alike.
      const resolveCli = async (probeEnv: NodeJS.ProcessEnv) => {
        const tried = new Set([baseCli]);
        if (await probe(baseCli, probeEnv)) {
          wslCli = null;
          return true;
        }
        if (process.platform === "win32") {
          const wrapped = support.wslProbeWrapper?.(baseCli) ?? null;
          if (wrapped && !tried.has(wrapped)) {
            tried.add(wrapped);
            if (await probe(wrapped, probeEnv)) {
              wslCli = wrapped;
              return true;
            }
          }
          if (!wslProbeAllowed()) return false;
          const resolved = await support.wslResolveCli?.(baseCli, probeEnv);
          if (resolved && !tried.has(resolved) && (await probe(resolved, probeEnv))) {
            wslCli = resolved;
            return true;
          }
        }
        return false;
      };
      // Turns and prepare share one successful resolution; snapshot()
      // re-probes and refreshes it, a miss is never remembered.
      let cliResolved: Promise<boolean> | null = null;
      const ensureCli = (probeEnv: NodeJS.ProcessEnv) => {
        cliResolved ??= resolveCli(probeEnv).then((ok) => {
          if (!ok) cliResolved = null;
          return ok;
        });
        return cliResolved;
      };
      const childEnv = () => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        applyCredentialAllowlist(env, [...(support.credentialEnv ?? [])]);
        support.transformEnv?.(env, config);
        return env;
      };

      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        turnId: string;
        interrupt: () => void;
        asks: Map<string, Ask>;
      }
      const active = new Map<string, Turn>();
      const children = new Set<ReturnType<typeof spawnCli>>();

      // At most one idle initialized host per instance, claimed by the next
      // turn. MSP names the workspace per session, so the spawn cwd is free.
      interface Warm {
        child: ReturnType<typeof spawnCli>;
        channel: MspChannel;
        cli: string;
        ready: Promise<boolean>;
        timer?: ReturnType<typeof setTimeout>;
        offExit?: () => void;
      }
      let warm: Warm | null = null;
      let preparing: Promise<void> | null = null;
      let disposed = false;
      const warmIdleMs = support.warmIdleMs ?? 60_000;
      const discardWarm = (entry: Warm | null = warm) => {
        if (!entry) return;
        if (warm === entry) warm = null;
        clearTimeout(entry.timer);
        entry.offExit?.();
        entry.channel.detach();
        try {
          killCliTree(entry.child);
        } catch {
          // already gone
        }
        children.delete(entry.child);
      };
      const runPrepare = async () => {
        if (disposed || warm) return;
        const env = childEnv();
        try {
          if (support.requireAuthenticationBeforeSpawn && !(await support.isAuthenticated(env, config))) return;
          if (!(await ensureCli(env))) return;
        } catch {
          return;
        }
        if (disposed || warm) return;
        const cli = effectiveCli();
        let child: ReturnType<typeof spawnCli>;
        try {
          child = spawnCli(cli, ["serve"], { cwd: config.workspace ?? homedir(), env, stdio: ["pipe", "pipe", "pipe"] });
        } catch {
          return;
        }
        children.add(child);
        const channel = createMspChannel(child);
        const entry: Warm = { child, channel, cli, ready: initializeHost(channel).then(() => true, () => false) };
        entry.offExit = channel.onExit(() => discardWarm(entry));
        entry.timer = setTimeout(() => discardWarm(entry), warmIdleMs);
        entry.timer.unref?.();
        warm = entry;
        if (!(await entry.ready) && warm === entry) discardWarm(entry);
      };
      const takeWarm = async (): Promise<Warm | null> => {
        const entry = warm;
        if (!entry) return null;
        warm = null;
        clearTimeout(entry.timer);
        entry.offExit?.();
        if (
          (await entry.ready)
          && !disposed
          && entry.cli === effectiveCli()
          && entry.child.exitCode === null
          && entry.child.signalCode === null
        ) {
          return entry;
        }
        discardWarm(entry);
        return null;
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

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        if (turn.integrations?.localComputer?.scope === "local-computer" && config.fullAuto) {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = newId();
  const turnTimer = startTurnTimer({
    engine: support.driverKind ?? "msp",
    model: turn.model,
    effort: turn.effort ?? null,
    systemPromptChars: typeof turn.system === "string" ? turn.system.length : 0,
  });
  turnTimer.mark("dispatch");
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const env = childEnv();
        const asks = new Map<string, Ask>();
        // Stop can land before the real interrupt is installed below; a warm
        // host claimed mid-handshake dies at once so takeWarm returns null.
        let cancelled = false;
        let claimed: Warm | null = null;
        const earlyInterrupt = () => {
          cancelled = true;
          if (claimed) discardWarm(claimed);
        };
        active.set(threadId, { turnId, interrupt: earlyInterrupt, asks });
        try {
          if (support.requireAuthenticationBeforeSpawn && !(await withWslProbeReason("turn", () => support.isAuthenticated(env, config)))) {
            emit({ ...base(threadId, turnId), type: "turn.started" });
            emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
            turnTimer.mark("turnDone");
    turnTimer.finish();
    emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required" });
            return { turnId };
          }
          if (!(await withWslProbeReason("turn", () => ensureCli(env)))) {
            emit({ ...base(threadId, turnId), type: "turn.started" });
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: wslProbeAllowed("turn") ? `\`${effectiveCli()}\` CLI not found` : wslBlockedReason(support.displayName),
              setup: true,
            });
            turnTimer.mark("turnDone");
    turnTimer.finish();
    emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "unavailable" });
            return { turnId };
          }
        } catch (err) {
          active.delete(threadId);
          throw err;
        }

        claimed = cancelled ? null : warm;
        const warmed = cancelled ? null : await takeWarm();
        claimed = null;
        if (cancelled) {
          emit({ ...base(threadId, turnId), type: "turn.started" });
          active.delete(threadId);
          turnTimer.mark("turnDone");
    turnTimer.finish();
    emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled" });
          return { turnId };
        }
        const child = warmed?.child ?? spawnCli(effectiveCli(), ["serve"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        children.add(child);
        turnTimer.mark("spawnOrReuse");
        turnTimer.setMeta({ reusedHandshake: !!warmed });
        const channel = warmed?.channel ?? createMspChannel(child);
        const state = {
          settled: false,
          mspTurnId: null as string | null,
          sessionId: null as string | null,
          model: null as string | null,
        };
        const kinds: ItemKinds = new Map();
        const buffers = new Map<string, string>();
        let latestUsageObservedAt: string | null = null;
        let completionPending = false;
        // Completions seen before the turn/start ack named our turn.
        const heldCompletions: Record<string, any>[] = [];
        let interruptTimer: ReturnType<typeof setTimeout> | null = null;
        let pendingText = "";
        // Behind the wsl wrapper the host is a Linux process: Windows
        // paths never resolve there. Hoisted: poison recovery reuses it.
        const sessionRoot = isWslCli() ? toWslPath(cwd) : cwd;
        // Poisoned-resume retry state (one retry max): resumedOk flips only
        // when session/resume succeeds; recovered flips on the single retry.
        let resumedOk = false;
        let recovered = false;
        // Session MCP rides in the `config` extension object, never at the
        // top level: SessionStartParams has no `mcpServers` member, and the
        // decoder ignores unknown keys instead of rejecting them: a top-level
        // mount is silently dropped and every tool simply never appears.
        const mcpServers = mspMcpServers(turn.integrations, { wsl: isWslCli() });
        const sessionConfig = mcpServers ? { config: { mcpServers } } : {};

        const stop = () => {
          channel.detach();
          try {
            killCliTree(child);
          } catch {
            // already gone
          }
          children.delete(child);
        };
        function flushText() {
          if (!pendingText) return;
          const text = pendingText;
          pendingText = "";
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        }
        const settle = (ok: boolean, stopReason: string | null) => {
          if (state.settled) return;
          state.settled = true;
          if (interruptTimer) clearTimeout(interruptTimer);
          for (const ask of [...asks.values()]) ask.finish("deny", "system");
          // The entry drops BEFORE turn.completed: the queue drain on that
          // event must see a free thread (adapter contract).
          active.delete(threadId);
          flushText();
          turnTimer.mark("turnDone");
    turnTimer.finish();
    emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason });
          stop();
        };
        const fail = (message: string, setup = false, stopReason: string | null = "rpc_error") => {
          emit({ ...base(threadId, turnId), type: "runtime.error", message, ...(setup ? { setup: true } : {}) });
          settle(false, stopReason);
        };
        const startTurnOn = async (targetSessionId: string, fullText: string) => {
          const ack: any = await channel.request(
            "turn/start",
            {
              commandId: uuidv7(),
              sessionId: targetSessionId,
              input: [{ type: "text", text: fullText }],
              // Levels travel verbatim (max stays max, never ultra); none
              // and unset both omit the key so the CLI keeps its default.
              ...(turn.effort && turn.effort !== "none" ? { reasoningEffort: turn.effort } : undefined),
            },
            SESSION_TIMEOUT,
          );
          if (ack?.status !== "accepted" || ack?.disposition !== "started") {
            throw new Error(`turn/start not started (status ${ack?.status}, disposition ${ack?.disposition})`);
          }
          state.mspTurnId = typeof ack?.turnId === "string" ? ack.turnId : null;
          // No id in the ack: adopt the held completion, as before.
          for (const p of heldCompletions.splice(0)) {
            state.mspTurnId ??= p.turnId;
            onNotification("turn/completed", p);
          }
        };
        // A resumed session whose provider-private history the active route
        // cannot replay poisons the turn (and its Retry, which resumes the
        // same session). Recover once on a fresh session; false otherwise —
        // and false on any throw, so callers fail exactly as before.
        const recoverIncompatible = async (message: string): Promise<boolean> => {
          try {
            if (recovered || !resumedOk) return false;
            if (!INCOMPATIBLE_HISTORY.test(message)) return false;
            if (typeof turn.resumeCursor !== "string") return false;
            recovered = true;
            const started: any = await channel.request(
              "session/start",
              {
                commandId: uuidv7(),
                workspaceRoot: sessionRoot,
                ...sessionConfig,
                ...(turn.model ? { modelId: turn.model } : {}),
              },
              SESSION_TIMEOUT,
            );
            const freshId = typeof started?.session?.sessionId === "string" ? started.session.sessionId : null;
            if (!freshId) return false;
            state.sessionId = freshId;
            state.mspTurnId = null;
            state.model = typeof started?.session?.modelId === "string" ? started.session.modelId : null;
            // Callers record the cursor from session.started: the fresh id
            // steers Retry onto the recovered session, not the poisoned one.
            emit({ ...base(threadId, turnId), type: "session.started", sessionId: freshId, model: state.model ?? turn.model ?? null });
            const retryText = turn.system
              ? `${turn.system}\n\n${turn.resumeFallback?.text ?? turn.text}`
              : (turn.resumeFallback?.text ?? turn.text);
            await startTurnOn(freshId, retryText);
            return true;
          } catch {
            return false;
          }
        };
        const onDelta = (streamKind: "assistant_text" | "reasoning_text", delta: string) => {
          if (streamKind !== "assistant_text" || !delta) return;
          pendingText += delta;
          emit({ ...base(threadId, turnId), type: "content.delta", streamKind, delta });
        };
        const emitUsage = (payload: unknown) => {
          const report = museUsageReport(payload);
          if (!report) return;
          if (latestUsageObservedAt && Date.parse(report.observedAt) <= Date.parse(latestUsageObservedAt)) return;
          latestUsageObservedAt = report.observedAt;
          emit({
            ...base(threadId, turnId),
            type: "account.rate-limits.updated",
            observedAt: report.observedAt,
            windows: report.windows,
          });
        };
        const settleCompleted = async () => {
          // Muse updates its cached subscription snapshot at turn completion;
          // read it before the short-lived serve process is cleaned up.
          try {
            emitUsage(await channel.request("usage/read", undefined, 1_500));
          } catch {
            // A host without usage/read still completes the turn normally.
          }
          settle(true, null);
        };

        // Last decision per approval, replayed on each later stage.
        const decisions = new Map<string, { want: "allow" | "deny"; requirement: string }>();
        const decideApproval = async (
          ask: Pick<ApprovalAsk, "approvalId" | "requirementId" | "choices">,
          want: "allow" | "deny",
        ): Promise<boolean> => {
          const choice = pickChoice(ask.choices, want);
          if (!choice?.choiceId || state.sessionId === null) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no usable approval choice — denying instead of guessing`,
            });
            return false;
          }
          // Set before the request: the host announces the next stage before it acks this one.
          decisions.set(ask.approvalId, { want, requirement: JSON.stringify(ask.requirementId ?? null) });
          const decide = () =>
            channel.request(
              "approval/decide",
              {
                commandId: uuidv7(),
                sessionId: state.sessionId,
                approvalId: ask.approvalId,
                choiceId: choice.choiceId,
                requirementId: ask.requirementId,
              },
              SESSION_TIMEOUT,
            );
          try {
            await decide();
          } catch (err) {
            if (!isDecideSettlementError(err)) throw err;
            // Re-sync once: "already resolved" confirms the first decide landed,
            // success means it had not. Either way the tool is running.
            await decide().catch((retryErr) => {
              if (!isSettledApprovalError(retryErr) && !isDecideSettlementError(retryErr)) throw retryErr;
            });
          }
          return true;
        };

        const seenApprovals = new Set<string>();
        const openApproval = (params: any) => {
          const approvalId = typeof params?.approvalId === "string" ? params.approvalId : null;
          const choices = Array.isArray(params?.availableChoices) ? params.availableChoices : [];
          // Muse 1.3 sends approval/request and approval/requested for one approval.
          if (!approvalId || seenApprovals.has(approvalId)) return;
          seenApprovals.add(approvalId);
          const tool = String(params?.toolName ?? "tool").slice(0, 80);
          const summary = String(params?.rawArgs ?? params?.toolName ?? tool).slice(0, 200);
          if (config.fullAuto) {
            // No card: answer immediately with the allow choice, like the core.
            void decideApproval({ approvalId, requirementId: params?.currentRequirementId, choices }, "allow").catch(
              (err) => {
                if (!isSettledApprovalError(err)) fail(err instanceof Error ? err.message : String(err));
              },
            );
            return;
          }
          const requestId = newId();
          const ask: ApprovalAsk = {
            kind: "approval",
            requestId,
            approvalId,
            requirementId: params?.currentRequirementId,
            choices,
            finish: (behavior, source) => {
              if (!asks.delete(requestId)) return;
              clearTimeout(ask.timer);
              const want = behavior === "allow" ? "allow" : "deny";
              void decideApproval(ask, want)
                .then((decided) => {
                  emit({
                    ...base(threadId, turnId),
                    type: "request.resolved",
                    requestId,
                    behavior: decided && behavior === "allow" ? "allow" : "deny",
                    source: decided ? source : "system",
                  });
                })
                .catch((err) => {
                  // A deny already states the terminal outcome — the write
                  // will not run — so a failed deny settlement is
                  // bookkeeping, not news: settle the card as denied and stay
                  // quiet instead of failing the turn over the CLI's
                  // ledger/fence internals. The turn still lands on its own,
                  // and a failed allow decide fails exactly as before.
                  if (want === "deny") {
                    emit({
                      ...base(threadId, turnId),
                      type: "request.resolved",
                      requestId,
                      behavior: "deny",
                      source,
                    });
                    return;
                  }
                  if (isSettledApprovalError(err)) {
                    emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior: "deny", source: "system" });
                    return;
                  }
                  fail(err instanceof Error ? err.message : String(err));
                });
            },
            timer: setTimeout(() => {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
              asks.get(requestId)?.finish("deny", "timeout");
            }, ASK_TIMEOUT_MS),
          };
          ask.timer.unref?.();
          asks.set(requestId, ask);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool,
            summary,
            choices: choices.map((c: ApprovalChoice) => String(c?.label ?? "")).filter(Boolean),
          });
        };
        // Muse stages a shell approval per pipeline stage: approval/updated
        // moves currentRequirementId on, and the tool waits for every stage.
        const continueApproval = (params: any) => {
          const approvalId = typeof params?.approvalId === "string" ? params.approvalId : null;
          const prior = approvalId ? decisions.get(approvalId) : undefined;
          if (!approvalId || !prior || !params?.currentRequirementId) return;
          if (JSON.stringify(params.currentRequirementId) === prior.requirement) return;
          const choices = Array.isArray(params?.availableChoices) ? params.availableChoices : [];
          void decideApproval({ approvalId, requirementId: params.currentRequirementId, choices }, prior.want).catch(
            (err) => {
              if (prior.want === "allow" && !isSettledApprovalError(err)) {
                fail(err instanceof Error ? err.message : String(err));
              }
            },
          );
        };

        const openUserInput = (params: any) => {
          const userInputId = typeof params?.userInputId === "string" ? params.userInputId : null;
          const questions = Array.isArray(params?.questions) ? params.questions : [];
          if (!userInputId || !questions.length) return;
          const first = questions[0] ?? {};
          const requestId = newId();
          const ask: Ask = {
            kind: "userInput",
            requestId,
            userInputId,
            questions,
            finish: (behavior, source, message) => {
              if (!asks.delete(requestId)) return;
              clearTimeout(ask.timer);
              const done = (outcome: "answer" | "deny") => {
                emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior: outcome, source });
              };
              if (behavior === "answer") {
                const answers = questions
                  .filter((q: { id?: string }) => typeof q?.id === "string")
                  .map((q: { id?: string }) => ({ questionId: q.id, freeText: String(message ?? "").slice(0, 500) }));
                if (state.sessionId === null || !answers.length) {
                  done("deny");
                  return;
                }
                void channel
                  .request(
                    "userInput/answer",
                    { commandId: uuidv7(), sessionId: state.sessionId, userInputId, answers },
                    SESSION_TIMEOUT,
                  )
                  .then(() => done("answer"))
                  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
              } else {
                if (state.sessionId === null) {
                  done("deny");
                  return;
                }
                void channel
                  .request(
                    "userInput/cancel",
                    { commandId: uuidv7(), sessionId: state.sessionId, userInputId },
                    SESSION_TIMEOUT,
                  )
                  .then(() => done("deny"))
                  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
              }
            },
            timer: setTimeout(() => {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
              asks.get(requestId)?.finish("deny", "timeout");
            }, ASK_TIMEOUT_MS),
          };
          ask.timer.unref?.();
          asks.set(requestId, ask);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "question",
            tool: String(params?.toolName ?? "tool").slice(0, 80),
            summary: String(first?.question ?? "input needed").slice(0, 200),
            choices: Array.isArray(first?.options) ? first.options.map((o: any) => String(o?.label ?? "")).filter(Boolean) : [],
          });
        };

        channel.onServerRequest((id, method, params) => {
          // The receipt acks presentation only; the decision travels as a
          // command (SS5.3.3). Answer it before opening the card.
          if (method === "approval/request") {
            channel.respond(id, {});
            openApproval(params);
            return {};
          }
          if (method === "userInput/request") {
            channel.respond(id, {});
            openUserInput(params);
            return {};
          }
          throw new Error(`method not found: ${method}`);
        });
        const onNotification = (method: string, params: any) => {
          if (state.settled) return;
          const p = (params ?? {}) as Record<string, any>;
          switch (method) {
            case "approval/requested":
              openApproval(p);
              break;
            case "approval/updated":
              continueApproval(p);
              break;
            case "userInput/requested":
              openUserInput(p);
              break;
            case "item/started": {
              const item = p.item as { id?: string; kind?: string } | undefined;
              if (typeof item?.id === "string" && typeof item?.kind === "string") kinds.set(item.id, item.kind);
              break;
            }
            case "item/delta": {
              if (typeof p.itemId === "string" && typeof p.delta === "string") {
                const stream = textStreamFor(kinds, p.itemId, p.field);
                if (stream) {
                  buffers.set(p.itemId, (buffers.get(p.itemId) ?? "") + p.delta);
                  onDelta(stream, p.delta);
                }
              }
              break;
            }
            case "item/completed": {
              const item = p.item as { id?: string; kind?: string; text?: unknown } | undefined;
              if (item?.kind === "agentMessage") {
                const text = typeof item.text === "string"
                  ? item.text
                  : (typeof item.id === "string" ? (buffers.get(item.id) ?? "") : "");
                if (text) {
                  pendingText = "";
                  emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
                }
              }
              break;
            }
            case "session/modelChanged": {
              const frame: unknown = p.session ?? {};
              const frameId = typeof frame === "object" && frame !== null && "sessionId" in frame
                ? frame.sessionId
                : undefined;
              const frameModel = typeof frame === "object" && frame !== null && "modelId" in frame
                ? frame.modelId
                : undefined;
              const changed = typeof p.modelId === "string" ? p.modelId : frameModel;
              if (typeof changed === "string" && (frameId === undefined || frameId === state.sessionId)) {
                state.model = changed;
              }
              break;
            }
            case "usage/changed": {
              emitUsage(p);
              break;
            }
            case "turn/started": {
              // Hosts may stream turn/started before the turn/start response
              // continuation assigns the returned id. Capture it here so a
              // same-chunk turn/completed notification is not dropped.
              if (typeof p.turnId === "string" && !state.mspTurnId) state.mspTurnId = p.turnId;
              break;
            }
            case "turn/completed": {
              // The turn/start ack resolves on a microtask, so a host that
              // writes the ack and this notification into one stdout chunk
              // lands here with mspTurnId still unset. Hold it for the ack
              // rather than adopt it: a resumed session first replays the
              // cancelled completion of a turn a killed host left open.
              if (typeof p.turnId === "string") {
                if (state.mspTurnId === null) {
                  heldCompletions.push(p);
                  break;
                }
                if (p.turnId !== state.mspTurnId) break;
              }
              const terminal = p.terminal as string | undefined;
              if (terminal === "completed") {
                if (!completionPending) {
                  completionPending = true;
                  void settleCompleted();
                }
              }
              else if (terminal === "cancelled") settle(true, "cancelled");
              else {
                const code = support.classifyError?.(p.error);
                const auth = code === "invalid_credentials" || code === "inactive_subscription";
                if (!auth) {
                  const message = p.error?.message ? String(p.error.message) : (typeof p.reason === "string" ? p.reason : "failed");
                  // Poisoned resume (failed completion): one fresh-session
                  // retry before failing exactly as before.
                  void recoverIncompatible(message).then((ok) => {
                    if (!ok && !state.settled) {
                      fail(message, false, typeof p.reason === "string" ? p.reason : "failed");
                    }
                  });
                  break;
                }
                fail(
                  p.error?.message ? String(p.error.message) : (typeof p.reason === "string" ? p.reason : "failed"),
                  auth,
                  auth ? "auth_required" : (typeof p.reason === "string" ? p.reason : "failed"),
                );
              }
              break;
            }
            default:
              break;
          }
        };
        channel.onNotification(onNotification);
        channel.onExit(() => {
          if (!state.settled && !completionPending) fail(`${DRIVER_KIND} exited before the turn completed`, false, "exit_before_result");
        });

        active.set(threadId, {
          turnId,
          interrupt: () => {
            // No session yet (init in flight): nothing to interrupt, stop
            // like the ACP core does pre-prompt.
            if (!state.sessionId) {
              stop();
              settle(true, "cancelled");
              return;
            }
            // Interrupt acceptance is not completion: the turn is over when
            // turn/completed arrives; the grace kill is the backstop.
            channel.notify("turn/interrupt", {
              commandId: uuidv7(),
              sessionId: state.sessionId,
              ...(state.mspTurnId ? { turnId: state.mspTurnId } : {}),
            });
            if (interruptTimer) return;
            interruptTimer = setTimeout(() => settle(true, "cancelled"), INTERRUPT_GRACE_MS);
            interruptTimer.unref?.();
          },
          asks,
        });
        emit({ ...base(threadId, turnId), type: "turn.started" });

        void (async () => {
          try {
            if (!warmed) await initializeHost(channel);
            const model = turn.model;
            let sessionId: string | null = null;
            let sessionModel: string | null = null;
            let promptText = turn.text;
            if (typeof turn.resumeCursor === "string") {
              try {
                const resumed: any = await channel.request(
                  "session/resume",
                  { commandId: uuidv7(), sessionId: turn.resumeCursor, ...sessionConfig },
                  SESSION_TIMEOUT,
                );
                sessionId = typeof resumed?.session?.sessionId === "string"
                  ? resumed.session.sessionId
                  : turn.resumeCursor;
                sessionModel = typeof resumed?.session?.modelId === "string" ? resumed.session.modelId : null;
                resumedOk = true;
              } catch {
                // --no-session-log hosts reject resume (-32601): start fresh
                // and replay the fallback text instead of the transcript.
                const started: any = await channel.request(
                  "session/start",
                  { commandId: uuidv7(), workspaceRoot: sessionRoot, ...sessionConfig },
                  SESSION_TIMEOUT,
                );
                sessionId = typeof started?.session?.sessionId === "string" ? started.session.sessionId : null;
                if (!sessionId) throw new Error("session/start returned no sessionId");
                sessionModel = typeof started?.session?.modelId === "string" ? started.session.modelId : null;
                promptText = turn.resumeFallback?.text ?? turn.text;
              }
            } else {
              const started: any = await channel.request(
                "session/start",
                {
                  commandId: uuidv7(),
                  workspaceRoot: sessionRoot,
                  ...(model ? { modelId: model } : {}),
                  ...sessionConfig,
                },
                SESSION_TIMEOUT,
              );
              sessionId = typeof started?.session?.sessionId === "string" ? started.session.sessionId : null;
              sessionModel = typeof started?.session?.modelId === "string" ? started.session.modelId : null;
              if (!sessionId) throw new Error("session/start returned no sessionId");
            }
            state.sessionId = sessionId;
            state.model = sessionModel;
            if (model && model !== state.model) {
              // Mid-session switch (cursor.ts configureSession is the ACP
              // twin): unlike cursor there is no argv pin to fall back on,
              // so a rejected switch fails the turn instead of silently
              // running the wrong model.
              try {
                await channel.request(
                  "session/setModel",
                  { commandId: uuidv7(), sessionId, model: { modelId: model } },
                  SESSION_TIMEOUT,
                );
              } catch (err) {
                throw new Error(
                  `Muse rejected model "${model}" via session/setModel: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
              state.model = model;
            }
            emit({ ...base(threadId, turnId), type: "session.started", sessionId, model: state.model ?? model ?? null });
            turnTimer.mark("cliReady");
            const text = turn.system ? `${turn.system}\n\n${promptText}` : promptText;
            if (!sessionId) throw new Error("session/start returned no sessionId");
            await startTurnOn(sessionId, text);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Poisoned resume (turn/start rejected): one fresh-session retry
            // before failing exactly as before.
            if (!state.settled && !(await recoverIncompatible(message))) fail(message);
          }
        })();

        return { turnId };
      };

      const respondToRequest = async (
        threadId: string,
        requestId: string,
        decision: { behavior: "allow" | "deny" | "answer"; message?: string },
      ): Promise<RequestOutcome> => {
        const ask = active.get(threadId)?.asks.get(requestId);
        if (!ask) return "unavailable"; // settled, timed out, or turn gone
        if (ask.kind === "approval") {
          if (decision.behavior !== "allow") {
            ask.finish("deny", "user");
            return "rejected";
          }
          // The decide travels async; a rejection lands as request.resolved
          // deny/system, correcting this optimistic answer.
          ask.finish("allow", "user");
          return "allowed-once";
        }
        ask.finish(decision.behavior === "answer" ? "answer" : "deny", "user", decision.message);
        return decision.behavior === "answer" ? "answered" : "rejected";
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return support.models;
        },
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "in-session",
            rateLimits: true,
            askApproval: !config.fullAuto,
            effortLevels: support.effortLevels,
            agentsMcp: true,
            composioMcp: true,
            browserMcp: true,
            phoneMcp: true,
            computerMcp: true,
            // Host control needs interactive approvals, same rule as ACP.
            localComputerMcp: !config.fullAuto,
          },
          sendTurn,
          interruptTurn: async (threadId) => {
            active.get(threadId)?.interrupt();
          },
          respondToRequest,
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const turn of [...active.values()]) turn.interrupt();
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
        snapshot: (opts?: { rescan?: boolean }): Promise<ProviderSnapshot> =>
          withWslProbeReason(opts?.rescan ? "rescan" : "passive", async (): Promise<ProviderSnapshot> => {
            const env = childEnv();
            const gated = support.wslProbeWrapper !== undefined && !wslProbeAllowed();
            const resolved = await resolveCli(env);
            cliResolved = resolved ? Promise.resolve(true) : null;
            if (!resolved) {
              if (gated) return lastSnapshot ?? { state: "unavailable", reason: wslBlockedReason(support.displayName) };
              return { state: "unavailable", reason: `\`${effectiveCli()}\` CLI not found` };
            }
            const ready: ProviderSnapshot = {
              state: "available",
              version: await probe(effectiveCli(), env),
              authenticated: await support.isAuthenticated(env, config),
            };
            if (!gated) lastSnapshot = ready;
            return ready;
          }),
        prepare: async () => {
          if (!input.enabled || disposed) return;
          preparing ??= runPrepare().finally(() => {
            preparing = null;
          });
          await preparing;
        },
        dispose: async () => {
          disposed = true;
          discardWarm();
          for (const child of [...children]) {
            try {
              killCliTree(child);
            } catch {
              // already gone
            }
          }
          children.clear();
        },
      };
    },
  };
}
