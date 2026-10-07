// Claude driver — upstream ClaudeDriver skeleton over agentcal's
// drivers/claude.js runtime (stream-json both directions, prompt over
// stdin, completion from a real `result` event — verified against
// claude 2.1.211 by agentcal). Per-turn CLI process; the conversation
// continues across turns via --resume <sessionId> (the resumeCursor)
// only while Orbit has not compacted the thread and the native session
// is not already tool-fat. After compaction or a pre-compact soak
// recycle the harness drops the cursor and injects the bounded
// transcript — a --resume of the old session, or reuse of a still-idle
// process that holds that session, would re-send uncompacted tool
// history. Warm reuse therefore requires an explicit matching cursor.
// Stop recovery still --resumes when there is no compaction yet.
//
// Integrations become MCP servers on the CLI:
//   - Composio Sessions (connected apps → tools) over streamable HTTP
//   - the bot's cloud computer (box.ascii.dev) via server/computer-proxy.ts
//     — screenshot/exec/open_url, the CUA-on-the-box bridge
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";

import { ATTACHMENTS_DIR, sniffImageMime } from "../attachments.ts";
import { BACKGROUND_DENY_NOTE } from "../auto-approve.ts";
import { applyCredentialAllowlist, DATA_DIR } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { brokerSocketPath, describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { inputDigest } from "../repeat-detector.ts";
import { REPLY_MARKER } from "../turn-context.ts";
import { startTurnTimer } from "../turn-timing.ts";

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
import { computerProxyEnv } from "../container-computer.ts";
import { newEventId, newId } from "../contracts.ts";
import {
  classifyError,
  computeBackoff,
  interruptibleDelay,
  isResumeCursorRejected,
  RETRY_MAX_ATTEMPTS,
} from "./retry.ts";
import {
  applyClaudeInject,
  decodeInjectId,
  mergeLocalInject,
  probeLocalInjects,
  resolveInjectId,
} from "./local-inject.ts";
import { appendNative, finishNative } from "./native.ts";
import { claudeRateLimitWindows } from "./rate-limits.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { redactSecretsInText } from "../redact.ts";
import { cachedSignIn } from "./auth-status.ts";

const claudeAuthSchema = z.object({ loggedIn: z.boolean() });

/** Whether `claude` has been signed in.
 *
 * Credential storage is deliberately not inspected here. Claude Code uses the
 * macOS Keychain for OAuth, a JSON file on some platforms, and may gain other
 * backends over time. Presence checks also accept stale credentials. The CLI's
 * own machine-readable auth command is the source of truth for every backend.
 */
export function claudeSignedIn(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    run(cli, ["auth", "status", "--json"], { timeout: 3000, env }, (_error, stdout) => {
      try {
        const parsed = claudeAuthSchema.safeParse(JSON.parse(stdout));
        resolve(parsed.success ? parsed.data.loggedIn : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

/** The CLI environment shared by auth probes and real turns.
 *
 * Subscription users can be billed pay-as-you-go if an inherited API key
 * leaks through, and a nested CLI must not inherit this session's identity.
 * Keeping the probe and turn environments identical prevents setup from
 * claiming an API-key login that the turn itself would deliberately remove.
 */
function claudeEnvironment(
  model?: string | null,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Inject first, allowlist after: the local host reads its key out of this
  // env, and the tokens it writes are the only credentials the CLI is granted.
  // Everything else the harness holds — every other provider's key, the
  // workspace secrets, whatever key ships next — is someone else's.
  const applied = applyClaudeInject(env, model);
  applyCredentialAllowlist(env, applied.injected ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] : []);
  return env;
}

const DRIVER_KIND = "claudeAgent";

export interface ClaudeConfig {
  cli: string;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
  /** Available Claude built-ins. An empty list passes `--tools ""`. */
  tools?: string[];
  /** Claude tool patterns to deny after the available set is selected. */
  disallowedTools?: string[];
}

// model catalog ported from upstream packages/contracts/src/model.ts
// Every current Claude model ships a 200k window. Stated here because an
// option without `contextWindow` falls back to MODEL_CONTEXT_FALLBACK (16k),
// which compacts a healthy Claude thread after a couple of large pastes.
export const STATIC_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1", contextWindow: 200_000 },
    { id: "claude-fable-5", label: "Claude Fable 5", contextWindow: 200_000 },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextWindow: 200_000 },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextWindow: 200_000 },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200_000 },
  ],
};

const CLAUDE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

/** Rewrite a leftover API slug (`orcarouter/Qwen…`) to `host::model` when a
 *  local host is serving it, so the turn injects instead of asking for /login.
 *  Official cloud ids and already-encoded inject ids skip the probe. */
async function resolveClaudeTurnModel(
  model: string | null | undefined,
  env: Record<string, string | undefined>,
): Promise<string | null | undefined> {
  if (!model || decodeInjectId(model) || STATIC_CLAUDE_MODELS.options.some((option) => option.id === model)) {
    return model;
  }
  return resolveInjectId(model, await probeLocalInjects(env)) ?? model;
}

function claudeConfigDir(env: Record<string, string | undefined>): string {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return join(env.HOME || env.USERPROFILE || homedir(), ".claude");
}

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return CLAUDE_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    }
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; slug?: unknown; name?: unknown; displayName?: unknown; label?: unknown };
    const id = [row.id, row.model, row.slug].find((candidate): candidate is string => typeof candidate === "string");
    if (!id || !CLAUDE_MODEL_ID.test(id)) return [];
    const label = [row.name, row.displayName, row.label].find((candidate): candidate is string => typeof candidate === "string");
    return [{ id, label: label || id }];
  });
}

/** Extra ids from ~/.claude/settings.json. Official cloud rows stay untagged.
 *  `model` is Claude Code's last-used slug, not a catalog — listing it as
 *  Custom put a non-inject id in the picker and the turn then had no
 *  ANTHROPIC_API_KEY ("Not logged in · Please run /login"). Live injects
 *  come from mergeLocalInject. */
export function readClaudeModelCatalog(env: Record<string, string | undefined> = process.env) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(join(claudeConfigDir(env), "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return STATIC_CLAUDE_MODELS;
  }

  const extras = [
    ...extrasFromUnknown(settings.availableModels),
    ...extrasFromUnknown(settings.customModels),
    ...extrasFromUnknown(settings.extraModels),
  ];
  const nestedEnv = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  const envModel = nestedEnv.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL;
  if (typeof envModel === "string") extras.push(...extrasFromUnknown([envModel]));

  const options = STATIC_CLAUDE_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: STATIC_CLAUDE_MODELS.default, options };
}

// Resolved from the server root, never relative to this file: bundling inlines
// this module into an entry one directory up, so a `".."` here would climb too
// far. See server/proxy-paths.ts.
const PROXY_PATH = SPAWNED_PROXIES.computer;
const PERM_PROXY_PATH = SPAWNED_PROXIES.permission;
const DWEB_PROXY_PATH = SPAWNED_PROXIES.dweb;
// in the packaged app process.execPath is the Electron binary — this env
// makes it behave as plain node for the spawned MCP proxies (harmless in dev)
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

// ── permission broker (ported from agentcal drivers/claude.js) ─────────
// A headless run that hits a permission acceptEdits doesn't cover should
// neither stall silently NOR get blanket-denied — it should ask the user.
// The broker is a net server on a per-turn socket; the proxy (spawned by
// the claude CLI) forwards asks over it and waits. Unanswered permission
// asks deny after timeoutMs with a keep-moving note; unanswered questions
// answer with "use your best judgment" — guidance, never a block.
interface Ask {
  id: string;
  kind: "permission" | "question";
  tool: string;
  input: Record<string, unknown>;
  at: number;
  /** raised by background work between turns */
  background?: boolean;
}
type AskBehavior = "allow" | "deny" | "answer";
type AskResolutionSource = "user" | "timeout" | "system";

// Ask rules outrank every allow list, the user's own settings.json included,
// so Ask for approval reaches the broker even where Write or Bash is allowed.
// Sandbox auto-allow is switched off too, or sandboxed Bash would skip them.
const ASK_SETTINGS = JSON.stringify({
  permissions: { ask: ["Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit"] },
  sandbox: { autoAllowBashIfSandboxed: false },
});
// Auto sends commands to the broker for approval; edits run under acceptEdits.
const AUTO_SETTINGS = JSON.stringify({
  permissions: { ask: ["Bash", "PowerShell"] },
  sandbox: { autoAllowBashIfSandboxed: false },
});

const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const QUESTION_TIMEOUT_NOTE = "OpenMausBot: nobody answered in time. Use your best judgment and continue.";
const DUPLICATE_ASK_ID_NOTE = "OpenMausBot: duplicate ask id — skipping this request.";

/** The system-source reply for an ask that outlives the turn — used both to
 * drain in-flight `pending` asks on close() and to answer one that arrives
 * on an already-closed broker (see the `closed` branch below). */
function systemEndedReply(kind: Ask["kind"]): { behavior: AskBehavior; message: string } {
  return kind === "question"
    ? { behavior: "answer", message: "OpenMausBot: the turn is ending — wrap up." }
    : { behavior: "deny", message: "OpenMausBot: the turn ended" };
}

/** The ask's full arguments; askSummary is this, cut for the card. */
function askArgs(ask: Ask): string {
  const input = ask.input ?? {};
  if (typeof input.question === "string") return input.question;
  if (typeof input.command === "string") return input.command;
  if (typeof input.url === "string") return input.url;
  const text = JSON.stringify(input);
  return text === "{}" ? (ask.tool ?? "tool") : text;
}

/** One human-readable line for an ask — what the card subtitle shows. */
function askSummary(ask: Ask): string {
  return askArgs(ask).slice(0, typeof ask.input?.question === "string" ? 300 : 200);
}

export function permissionSocketPath(threadId: string, generation = 1) {
  // A readable prefix alone is not unique: ids that agree on their first
  // characters ("t-perm-dup-1", "t-perm-dup-2") would share a socket. POSIX
  // hides that — a new broker's listen replaces the socket FILE, so the name
  // always points at the fresh server — but Windows named pipes live in a
  // global namespace that is never unlinked, and a reused name races the
  // previous broker's async teardown. Half the tag is a digest of the FULL
  // id so distinct threads get distinct sockets; the tag stays at 8 chars
  // total because the POSIX path already brushes the 104-byte sun_path
  // limit under deep tmp home dirs. Later Windows generations append a
  // suffix so a leftover listener cannot EADDRINUSE the replacement.
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(threadId).digest("hex").slice(0, 4);
  const path = brokerSocketPath(DATA_DIR, `${prefix}${digest}`);
  if (generation > 1 && process.platform === "win32") return `${path}-g${generation}`;
  return path;
}

function createPermissionBroker(opts: {
  socketPath: string;
  onAsk: (ask: Ask) => void;
  onResolve: (resolved: Ask & { behavior: AskBehavior; source: AskResolutionSource }) => void;
  isActive?: () => boolean;
  /** Between turns: "auto" when live background work keeps its turn's Auto
   * approvals, "denied" when it has nobody to ask, null when there is none. */
  backgroundAsks?: () => "auto" | "denied" | null;
  timeoutMs?: number;
}) {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pending = new Map<
    string,
    { ask: Ask; finish: (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource) => void }
  >();
  // server.close() only stops accepting NEW connections — it does not touch
  // a connection that's already open. A still-alive child's MCP proxy can
  // keep sending asks on such a connection after the turn has ended, and
  // this handler stays fully wired to it. Without this flag those asks would
  // become new `pending` entries and `request.opened` cards for a turn the
  // driver already forgot (`active.delete(threadId)` already ran), which can
  // never be answered — the "zombie card" in issue #211.
  let closed = false;
  try {
    unlinkSync(opts.socketPath);
  } catch {}
  const server = createNetServer((conn) => {
    conn.on("error", () => {});
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.t !== "ask") continue;
        const askId = String(msg.id ?? newId());
        const kind = msg.kind === "question" ? ("question" as const) : ("permission" as const);
        if (closed) {
          // Closure is terminal and takes precedence over every active-turn
          // rule, including duplicate-id rejection. Never register a pending
          // entry or notify onAsk, but always answer an existing connection:
          // permission-proxy.ts only resolves on an explicit answer (or a
          // connection error/close), so a silent drop would hang the tool.
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
          } catch {}
          continue;
        }
        // A retained Claude process keeps its proxy connection between
        // turns. Late/background asks must still fail closed without opening
        // a card for a turn that has already settled.
        let background = false;
        if (opts.isActive && !opts.isActive()) {
          const work = kind === "permission" ? (opts.backgroundAsks?.() ?? null) : null;
          if (work !== "auto") {
            const reply = work === "denied" ? { behavior: "deny" as const, message: BACKGROUND_DENY_NOTE } : systemEndedReply(kind);
            try {
              conn.write(JSON.stringify({ t: "answer", id: askId, ...reply }) + "\n");
            } catch {}
            continue;
          }
          background = true;
        }
        // `pending` is server-scoped, not per-connection: two asks with the
        // same id — a buggy/adversarial client, never a legitimate retry
        // (permission-proxy mints a fresh randomUUID per ask) — would
        // otherwise let the second `pending.set` silently overwrite the
        // first, orphaning it as an unanswerable card once the first
        // resolves and deletes the shared key. Reject before either ask
        // becomes visible to onAsk.
        if (pending.has(askId)) {
          // askId is client-controlled; JSON.stringify escapes newlines and
          // control characters so it can't corrupt the log line or terminal.
          console.error(`permission broker on ${opts.socketPath}: duplicate ask id ${JSON.stringify(askId)} — denying`);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior: "deny", message: DUPLICATE_ASK_ID_NOTE }) + "\n");
          } catch {}
          continue;
        }
        const ask: Ask = { id: askId, kind, tool: msg.tool ?? "tool", input: msg.input ?? {}, at: Date.now(), ...(background ? { background } : {}) };
        const finish = (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource) => {
          if (!pending.delete(askId)) return;
          clearTimeout(timer);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior, message }) + "\n");
          } catch {}
          opts.onResolve({ ...ask, behavior, source });
        };
        const timer = setTimeout(
          () =>
            kind === "question"
              ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout")
              : finish("deny", DENY_TIMEOUT_NOTE, "timeout"),
          timeoutMs,
        );
        timer.unref?.();
        pending.set(askId, { ask, finish });
        opts.onAsk(ask);
      }
    });
  });
  // A broker that never came up used to be silent — every approval then
  // timed out into a deny nobody could explain. Keep the turn fail-closed,
  // but leave an actionable diagnostic.
  server.on("error", (error) => {
    console.error(`permission broker unavailable on ${opts.socketPath}: ${error.message}`);
  });
  server.listen(opts.socketPath);
  const drain = () => {
    for (const p of [...pending.values()]) {
      const { behavior, message } = systemEndedReply(p.ask.kind);
      p.finish(behavior, message, "system");
    }
  };
  return {
    answer(askId: string, behavior: AskBehavior, message?: string): boolean {
      const p = pending.get(askId);
      if (!p) return false;
      if (p.ask.kind === "question" ? behavior !== "answer" : behavior === "answer") return false;
      p.finish(behavior, message, "user");
      return true;
    },
    pause() {
      drain();
    },
    close() {
      closed = true;
      drain();
      try {
        server.close();
      } catch {}
      try {
        unlinkSync(opts.socketPath);
      } catch {}
    },
  };
}

function decodeToolList(value: unknown, field: "tools" | "disallowedTools"): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`claude: ${field} must be an array of non-empty strings`);
  const decoded: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`claude: ${field} must be an array of non-empty strings`);
    }
    const normalized = entry.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    decoded.push(normalized);
  }
  return decoded;
}

function decodeConfig(raw: unknown): ClaudeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = o.permissionMode;
  if (mode !== undefined && mode !== "acceptEdits" && mode !== "auto" && mode !== "bypassPermissions") {
    throw new Error(`claude: invalid permissionMode ${JSON.stringify(mode)}`);
  }
  const tools = decodeToolList(o.tools, "tools");
  const disallowedTools = decodeToolList(o.disallowedTools, "disallowedTools");
  return {
    cli: typeof o.cli === "string" ? o.cli : "claude",
    permissionMode: (mode as ClaudeConfig["permissionMode"]) ?? "acceptEdits",
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
  };
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
  }
  return "";
}

type ClaudeContentBlock = { type?: string; text?: string; thinking?: string };

/** Plain reply text, and narration the CLI flagged, kept apart so a summary never joins the real reply. */
function replySegments(content: ClaudeContentBlock[] | string | undefined, narration: number[] | undefined) {
  if (!Array.isArray(content) || !Array.isArray(narration)) {
    const text = firstText(content);
    return text.trim() ? [{ text }] : [];
  }
  const flagged = new Set(narration);
  const segments: Array<{ text: string; summarized?: true }> = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    const summarized = block?.type === "thinking" && flagged.has(i);
    const text = block?.type === "text" ? String(block.text ?? "") : summarized ? String(block.thinking ?? "").trim() : "";
    if (!text) continue;
    const last = segments.at(-1);
    if (last && Boolean(last.summarized) === Boolean(summarized)) last.text += text;
    else segments.push(summarized ? { text, summarized: true } : { text });
  }
  return segments.filter((segment) => segment.text.trim());
}

const NARRATION_NOTICE_MAX = 600;

function narrationNotice(summary: string): string {
  const quoted = summary.slice(0, NARRATION_NOTICE_MAX);
  return `[Wink note, not from the user] Your last message between tool calls was long, so the user saw only this summary of it: "${quoted}". If it held anything they need word for word (links, numbers, commands, steps), send just that again now in one short line, or put it in your final reply. Otherwise ignore this note and don't mention it.`;
}

type TurnUsage = { input: number; output: number; cachedInput?: number };

// cache reads count as input: billed (at the cache rate) and they fill the
// window. Reported separately too, so the UI can show how much of the figure
// was context re-read rather than new text.
function claudeUsage(usage: any): TurnUsage | undefined {
  if (!usage) return undefined;
  return {
    input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
    output: usage.output_tokens || 0,
    ...(typeof usage.cache_read_input_tokens === "number" ? { cachedInput: usage.cache_read_input_tokens } : {}),
  };
}

function addUsage(a: TurnUsage, b?: TurnUsage): TurnUsage {
  if (!b) return a;
  const cached = a.cachedInput !== undefined || b.cachedInput !== undefined ? { cachedInput: (a.cachedInput ?? 0) + (b.cachedInput ?? 0) } : {};
  return { input: a.input + b.input, output: a.output + b.output, ...cached };
}

const SUMMARY_MAX = 120;

function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (!rel) return "";
  return !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : basename(path);
}

const lineCount = (text: string) => (text ? text.replace(/\n$/, "").split("\n").length : 0);

/** What a tool call targeted, for its chip. Never the tool's output or a file's contents. */
export function claudeToolSummary(name: string, input: unknown, cwd: string, result?: string): string | undefined {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (key: string) => (typeof o[key] === "string" && o[key] ? (o[key] as string) : undefined);
  let out: string | undefined;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit": {
      const path = str("file_path") ?? str("notebook_path");
      if (!path) break;
      out = displayPath(path, cwd);
      if (name === "Edit" && typeof o.new_string === "string" && typeof o.old_string === "string") {
        out += ` +${lineCount(o.new_string)} -${lineCount(o.old_string)}`;
      } else if (name === "Write" && typeof o.content === "string") out += ` +${lineCount(o.content)}`;
      break;
    }
    case "Bash": {
      const command = str("command");
      if (!command) break;
      out = redactSecretsInText(command.replace(/\s+/g, " ").trim()).slice(0, 60);
      const exit = result?.match(/^Exit code (\d+)/);
      if (exit) out += ` · exit ${exit[1]}`;
      break;
    }
    case "Grep":
    case "Glob": {
      const pattern = str("pattern");
      const path = str("path");
      out = [pattern, path && displayPath(path, cwd)].filter(Boolean).join(" in ") || undefined;
      break;
    }
    case "WebFetch": {
      const url = str("url");
      try {
        out = url ? new URL(url).host : undefined;
      } catch {
        out = undefined;
      }
      break;
    }
    case "WebSearch":
      out = str("query");
      break;
    default:
      out = Object.values(o).find((value): value is string => typeof value === "string" && value.trim() !== "");
  }
  if (!out) return undefined;
  const text = redactSecretsInText(out.replace(/\s+/g, " ").trim());
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

const NATIVE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const NATIVE_IMAGE_MAX_COUNT = 8;
const NATIVE_IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const ATTACHED_IMAGE_TAG = /<attached-image\s+path="([^"]*)"\s*\/?>/g;

type ClaudeImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
type ClaudeUserContent = string | Array<{ type: "text"; text: string } | ClaudeImageBlock>;

const unescapeAttribute = (value: string) =>
  value.replace(/&(amp|quot|lt|gt|#9|#13|#10);/g, (_m, e: string) =>
    ({ amp: "&", quot: '"', lt: "<", gt: ">", "#9": "\t", "#13": "\r", "#10": "\n" })[e]!,
  );

function storeImage(path: string, storeDir: string): { block: ClaudeImageBlock; realPath: string; bytes: number } | null {
  try {
    const file = realpathSync(path);
    if (dirname(file) !== realpathSync(storeDir)) return null;
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > NATIVE_IMAGE_MAX_BYTES) return null;
    const bytes = readFileSync(file);
    const mime = sniffImageMime(bytes);
    if (!mime) return null;
    return { block: { type: "image", source: { type: "base64", media_type: mime, data: bytes.toString("base64") } }, realPath: file, bytes: bytes.length };
  } catch {
    return null;
  }
}

/** Attached store images ride along as native blocks; anything else stays the plain string.
 * Newest tags win the 8-image and 20 MiB budgets, so a replayed turn's old history can't
 * starve out the image the user just attached. A replayed turn also marks where history
 * ends and the user's latest message begins (`REPLY_MARKER`); tags before that marker are
 * old history re-attached as text, not something the user just sent, so only tags after it
 * are eligible. */
export function claudeUserContent(text: string, storeDir: string = ATTACHMENTS_DIR): ClaudeUserContent {
  const markerIndex = text.lastIndexOf(REPLY_MARKER);
  const matches = [...text.matchAll(ATTACHED_IMAGE_TAG)].filter((m) => markerIndex === -1 || m.index! > markerIndex);
  const tags = matches.map(([, raw]) => unescapeAttribute(raw!));
  const chosen = new Map<number, ClaudeImageBlock>();
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (let i = tags.length - 1; i >= 0 && chosen.size < NATIVE_IMAGE_MAX_COUNT; i--) {
    const stored = storeImage(tags[i]!, storeDir);
    if (!stored || seenPaths.has(stored.realPath)) continue;
    if (totalBytes + stored.bytes > NATIVE_IMAGE_MAX_TOTAL_BYTES) break;
    seenPaths.add(stored.realPath);
    totalBytes += stored.bytes;
    chosen.set(i, stored.block);
  }
  if (!chosen.size) return text;
  const images = tags.map((_, i) => chosen.get(i)).filter((b): b is ClaudeImageBlock => !!b);
  return [{ type: "text", text }, ...images];
}

const elideImageData = (content: ClaudeUserContent) =>
  Array.isArray(content)
    ? content.map((b) => (b.type === "image" ? { ...b, source: { ...b.source, data: `<${b.source.data.length} base64 chars>` } } : b))
    : content;

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  // Native Windows PowerShell installer. macOS/Linux stay on npm until a
  // later slice verifies those native one-liners.
  install: {
    command: {
      darwin: "npm install -g @anthropic-ai/claude-code",
      linux: "npm install -g @anthropic-ai/claude-code",
      win32: "irm https://claude.ai/install.ps1 | iex",
    },
    needsNode: true,
    docsUrl: "https://claude.com/claude-code",
    signInCommand: "claude",
  },
  models: STATIC_CLAUDE_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const catalogEnv: Record<string, string | undefined> = { ...process.env, ...input.environment };
    let models = STATIC_CLAUDE_MODELS;
    const refreshModels = async () => {
      try {
        const resolved = await mergeLocalInject(readClaudeModelCatalog(catalogEnv), catalogEnv);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when settings.json is unreadable.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread; a second send while busy is a caller bug
    const active = new Map<string, { stop: () => void; turnId: string; broker?: ReturnType<typeof createPermissionBroker> }>();

    // One live CLI process per thread, kept across turns. Under
    // --input-format stream-json the CLI settles a turn with `result` while
    // stdin stays open, takes the next user message on the same stdin as a
    // new turn, and folds a message that arrives MID-turn into the running
    // one before its next model call (verified against 2.1.221 — that fold
    // is what "steer" is). So a session is spawned once, reused while its
    // spawn contract (args, MCP config, cwd, model) is unchanged and the
    // harness still names this session, closed after SESSION_IDLE_MS of
    // quiet, and resumed by --resume when a matching cursor must attach
    // to a new process. An omitted cursor never reuses.
    interface Session {
      child: ReturnType<typeof spawnCli>;
      broker?: ReturnType<typeof createPermissionBroker>;
      mcpConfigPath: string | null;
      /** the spawn contract — a different one means a fresh process */
      argsKey: string;
      /** the CLI's session id from `init`, what --resume takes later */
      sessionId: string | null;
      /** the running turn, or null between turns */
      turn: {
        turnId: string;
        settled: boolean;
        sawStreamDelta: boolean;
        /** what a retry relaunches; absent on a continuation */
        launch?: { request: SendTurnInput; retry: { attempt: number; cancelled: boolean }; abort: AbortController };
        /** the model answered this prompt, so the session holds it */
        promptAccepted?: boolean;
        /** opened by the CLI waking on its own after `result`; never retried */
        continuation?: boolean;
        /** steers written since the CLI last sent a model request */
        unsentSteers?: number;
        /** summarized narration held until this response calls a tool */
        narrationNotice?: { parts: string[]; messageId?: string };
        /** a notice went out since the user's last message */
        narrationNoticeSent?: boolean;
        /** accounting of a `result` held open for those steers */
        carried?: { cost: number; usage?: TurnUsage };
        /** the main agent's first and latest call prompts, and its model */
        prompt?: { first: number; last: number };
        model?: string;
        /** that model's window, from the CLI's `result.modelUsage` */
        contextWindow?: number;
        timer: ReturnType<typeof startTurnTimer>;
      } | null;
      idleTimer: ReturnType<typeof setTimeout> | null;
      /** the last turn sendTurn started was attended and in Auto */
      autoAttended: boolean;
      /** backgrounded task_id -> start time, and whether the turn that
       * started it was attended Auto; such tasks die with this process */
      background: Map<string, { at: number; autoAttended: boolean }>;
      closing: boolean;
      stderr: string;
      /** settle the current turn; set once the spawn handlers exist */
      settleTurn?: (ok: boolean, stopReason: string | null) => void;
    }
    const sessions = new Map<string, Session>();
    const brokerGeneration = new Map<string, number>();
    const configuredIdleMinimum = Number(process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS);
    const sessionIdleMinimum = Number.isFinite(configuredIdleMinimum) && configuredIdleMinimum > 0
      ? configuredIdleMinimum
      : 10_000;
    const SESSION_IDLE_MS = Math.max(sessionIdleMinimum, Number(process.env.OMB_CLAUDE_SESSION_IDLE_MS) || 10 * 60_000);
    // a lost task_notification must not pin a session forever
    const BACKGROUND_TASK_TTL_MS = 2 * 60 * 60_000;
    const liveBackground = (s: Session) =>
      s.closing || s.child.exitCode !== null ? [] : [...s.background.values()].filter(({ at }) => Date.now() - at < BACKGROUND_TASK_TTL_MS);
    const hasLiveBackgroundWork = (s: Session) => liveBackground(s).length > 0;
    // An ask can't be traced to its task, so every live task must have come
    // from an attended Auto turn.
    const backgroundAutoAttended = (s: Session) => {
      const live = liveBackground(s);
      return live.length > 0 && live.every((task) => task.autoAttended);
    };

    /** Mark the session unusable for reuse and start process teardown.
     * Does not close the permission broker — Windows named pipes drop
     * existing clients on server.close()/unlink, and a late ask on a
     * still-open connection must still get "the turn ended" (#211). */
    const beginClose = (threadId: string, why: string): Session | undefined => {
      const s = sessions.get(threadId);
      if (!s) return undefined;
      if (s.closing) return s;
      s.closing = true;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      appendNative(threadId, { dir: "out", source: "claude.session", msg: { close: why } });
      // stdin EOF is the CLI's exit signal; give it a moment, then insist
      try {
        s.child.stdin.end();
      } catch {}
      const kill = setTimeout(() => {
        if (s.child.exitCode === null) killCliTree(s.child);
      }, 5_000);
      kill.unref?.();
      return s;
    };
    const detachBroker = (s: Session) => {
      const broker = s.broker;
      s.broker = undefined;
      broker?.close();
    };
    const closeSession = (threadId: string, why: string) => {
      const s = beginClose(threadId, why);
      if (!s) return;
      // Broker ownership belongs to this session. Detach and close it now,
      // before a replacement can bind the same per-thread socket; the old
      // child's later close event must never unlink a new broker.
      detachBroker(s);
    };
    const armIdle = (threadId: string) => {
      const s = sessions.get(threadId);
      if (!s) return;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => {
        // closing stdin ends the CLI and every background task it still runs
        if (hasLiveBackgroundWork(s)) armIdle(threadId);
        else closeSession(threadId, "idle");
      }, SESSION_IDLE_MS);
      s.idleTimer.unref?.();
    };
    const writeUser = (s: Session, threadId: string, text: string, attachImages = true): Promise<boolean> => {
      const content = attachImages ? claudeUserContent(text) : text;
      const promptMsg = { type: "user", message: { role: "user", content } };
      if (!s.child.stdin.writable || s.child.stdin.destroyed) return Promise.resolve(false);
      return new Promise((resolve) => {
        try {
          s.child.stdin.write(JSON.stringify(promptMsg) + "\n", (error) => {
            if (error) return resolve(false);
            const logged = { ...promptMsg, message: { ...promptMsg.message, content: elideImageData(content) } };
            appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: logged });
            resolve(true);
          });
        } catch {
          resolve(false);
        }
      });
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
    // retry bookkeeping lives PER THREAD, not per sendTurn call: a relaunch
    // is a fresh sendTurn, and the attempt cap must survive across launches
    const retryState = new Map<string, { attempt: number; cancelled: boolean }>();

    // A relaunch (resume fallback, transient retry) is the same logical turn:
    // the harness holds the first id as live and drops events from any other.
    const sendTurn = async (turn: SendTurnInput, relaunchOf?: string) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && config.permissionMode === "bypassPermissions") {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const turnId = relaunchOf ?? newId();
    const turnTimer = startTurnTimer({
      engine: "claude",
      model: turn.model,
      effort: turn.effort ?? null,
      systemPromptChars: typeof turn.system === "string" ? turn.system.length : 0,
    });
    turnTimer.mark("dispatch");
      const retryAbort = new AbortController();
      const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
      retry.cancelled = false;
      retryState.set(threadId, retry);
      // a retry relaunches the whole CLI; the backoff is scaled down in tests
      // so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CLAUDE_RETRY_SCALE ?? "1");
      const sessionId = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      const newSessionId = sessionId ? null : newId();
      const asks = turn.approval === "ask" && config.permissionMode !== "bypassPermissions";
      const autoAttended = turn.approval === "auto" && turn.attended === true;

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose", // required by stream-json output
        // token-level streaming: content_block_delta events between the
        // whole-message frames, so the bubble grows as the model writes
        "--include-partial-messages",
        "--permission-mode", asks ? "default" : config.permissionMode === "auto" ? "acceptEdits" : config.permissionMode,
      ];
      if (asks) args.push("--settings", ASK_SETTINGS);
      else if (turn.approval === "auto" && config.permissionMode !== "bypassPermissions") {
        args.push("--settings", AUTO_SETTINGS);
      }
      if (config.tools !== undefined) args.push("--tools", config.tools.join(","));
      if (config.disallowedTools?.length) {
        args.push("--disallowedTools", config.disallowedTools.join(","));
      }
      const turnEnvironment: NodeJS.ProcessEnv = { ...process.env, ...input.environment };
      const turnModel = await resolveClaudeTurnModel(turn.model, turnEnvironment);
      const injected = applyClaudeInject({ ...turnEnvironment }, turnModel);
      if (injected.model) args.push("--model", injected.model);
      if (turn.effort) args.push("--effort", turn.effort);
      if (turn.leanStartup === true) args.push("--setting-sources", "project");
      if (turn.system) args.push("--append-system-prompt", turn.system);

      // integrations → MCP servers; pre-allow their tools (a headless
      // acceptEdits run silently denies anything unlisted)
      const mcpServers: Record<string, unknown> = {};
      const allowed: string[] = [];
      // Orbit's own servers skip ToolSearch deferral; a fresh CLI session
      // would otherwise re-fetch their schemas every time.
      const orbitOwned = { alwaysLoad: true };
      if (turn.integrations?.composio) {
        mcpServers.composio = { ...turn.integrations.composio };
        allowed.push("mcp__composio");
      }
      if (turn.integrations?.computer) {
        mcpServers.computer = {
          command: process.execPath,
          args: [PROXY_PATH],
          env: { ...NODE_ENV_FLAG, ...computerProxyEnv(turn.integrations.computer) },
          ...orbitOwned,
        };
        allowed.push("mcp__computer");
      } else if (turn.integrations?.localComputer) {
        const local = turn.integrations.localComputer;
        mcpServers.computer = {
          command: local.command,
          args: local.args,
          env: local.env,
        };
        // The isolated Local VM preserves the established pre-allow behavior.
        // Host tools always route through OpenMausBot's permission broker.
        if (!controlsHost) allowed.push("mcp__computer");
      }
      // peer-agent comms (list_bots/ask_bot) — the harness builds the whole
      // spawn contract (command/args/env incl. the boot token) in
      // agentsIntegration(); pre-allowing matters doubly here, or the CLI's
      // own ListAgents look-alike shadows it and "@Bot" asks go nowhere
      if (turn.integrations?.agents) {
        mcpServers.agents = { ...turn.integrations.agents, ...orbitOwned };
        allowed.push("mcp__agents");
      }
      if (turn.integrations?.phone) {
        mcpServers.phone = { ...turn.integrations.phone, ...orbitOwned };
        allowed.push("mcp__phone");
      }
      if (turn.integrations?.browser) {
        mcpServers.browser = { ...turn.integrations.browser, ...orbitOwned };
        allowed.push("mcp__browser");
      }
      if (turn.integrations?.terminal) {
        mcpServers.terminal = { ...turn.integrations.terminal, ...orbitOwned };
        allowed.push("mcp__terminal__terminal_read");
      }
      // dweb network daemon (status / repo / opencode model access) via
      // server/drivers/dweb-proxy.ts — points at the configured dweb instance
      if (turn.integrations?.dweb) {
        mcpServers.dweb = {
          command: process.execPath,
          args: [DWEB_PROXY_PATH],
          env: {
            ...NODE_ENV_FLAG,
            DWEB_URL: turn.integrations.dweb.url,
          },
          ...orbitOwned,
        };
        allowed.push("mcp__dweb");
      }
      // permission broker: anything acceptEdits would silently deny becomes
      // an Allow/Deny card in chat, and the agent gets ask_user. Skipped in
      // bypassPermissions (fullAuto) — nothing would ever ask.
      let broker: ReturnType<typeof createPermissionBroker> | undefined;
      let socketPath: string | null = null;
      const ogbArgs = [PERM_PROXY_PATH, ""];
      if (config.permissionMode !== "bypassPermissions") {
        socketPath = permissionSocketPath(threadId);
        ogbArgs[1] = socketPath;
        args.push("--permission-prompt-tool", "mcp__ogb__approve");
        mcpServers.ogb = { command: process.execPath, args: ogbArgs, env: { ...NODE_ENV_FLAG }, ...orbitOwned };
        allowed.push("mcp__ogb");
      }
      // The MCP config carries credentials — a Composio consumer key in a
      // header, the box token in the computer proxy's env, the comms token in
      // the agents proxy's env. On argv every one of those is world-readable
      // through `ps` for the life of the turn, to any local process. The CLI
      // accepts a FILE for this flag, so the secrets go in a 0600 file that
      // is removed when the turn settles.
      let mcpConfigPath: string | null = null;
      if (Object.keys(mcpServers).length || turn.system) {
        mcpConfigPath = join(mkdtempSync(join(tmpdir(), "omb-mcp-")), "mcp.json");
        writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
        if (Object.keys(mcpServers).length) {
          args.push("--mcp-config", mcpConfigPath);
          args.push("--allowedTools", allowed.join(","));
        }
      }

      const env = claudeEnvironment(turnModel, turnEnvironment);
      const cwd = turn.cwd ?? homedir();
      // everything that shapes the process, minus session/turn specifics
      // (the --mcp-config file is a fresh temp path each time; its CONTENT
      // is what matters and mcpServers carries that)
      const keyArgs = args.filter((a, i) => a !== "--mcp-config" && args[i - 1] !== "--mcp-config");
      const argsKey = JSON.stringify({ args: keyArgs, mcpServers, cwd, model: injected.model ?? null, base: env.ANTHROPIC_BASE_URL ?? null });

      // Reuse the live process only when it is idle, unchanged, and the
      // harness named that same session. An omitted cursor (Orbit recycled
      // after compaction or a pre-compact soak) must spawn a fresh
      // --session-id — otherwise summary+tail appends onto the fat CLI
      // history and defeats the bound.
      // A matching cursor still reuses (Stop / Continuity on uncompacted
      // threads) or --resumes after a contract change.
      const live = sessions.get(threadId);
      if (live && !live.turn && !live.closing && live.child.exitCode === null && live.argsKey === argsKey && sessionId !== null && sessionId === live.sessionId) {
        if (live.idleTimer) clearTimeout(live.idleTimer);
        turnTimer.mark("spawnOrReuse");
        turnTimer.mark("cliReady");
        live.turn = { turnId, settled: false, sawStreamDelta: false, timer: turnTimer, launch: { request: turn, retry, abort: retryAbort } };
        live.autoAttended = autoAttended;
        active.set(threadId, {
          stop: () => {
            retry.cancelled = true;
            retryAbort.abort();
            killCliTree(live.child);
            beginClose(threadId, "interrupted");
            live.settleTurn?.(false, "exit_before_result");
          },
          turnId,
          broker: live.broker,
        });
        emit({ ...base(threadId, turnId), type: "turn.started" });
        const written = await writeUser(live, threadId, turn.text);
        if (!written) {
          active.delete(threadId);
          live.turn = null;
          closeSession(threadId, "stdin write failed");
          throw new Error("claude session stdin is not writable");
        }
        // the MCP config was for the first spawn; nothing to clean here
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        return { turnId };
      }
      if (live) {
        closeSession(
          threadId,
          sessionId === null
            ? "fresh session required"
            : sessionId === live.sessionId
              ? "spawn contract changed"
              : "session cursor mismatch",
        );
      }

      // Only create a broker for a new process. A compatible retained process
      // keeps its existing proxy connection and broker across turns.
      if (socketPath) {
        const generation = (brokerGeneration.get(threadId) ?? 0) + 1;
        brokerGeneration.set(threadId, generation);
        const nextPath = permissionSocketPath(threadId, generation);
        if (nextPath !== socketPath) {
          socketPath = nextPath;
          ogbArgs[1] = nextPath;
          if (mcpConfigPath) writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
        }
        // remembers which tool each pending ask came from, so the resolved
        // event can scope approvals to real desktop-control tools only
        const askTools = new Map<string, string | undefined>();
        broker = createPermissionBroker({
          socketPath,
          isActive: () => Boolean(sessions.get(threadId)?.turn),
          backgroundAsks: () => {
            const s = sessions.get(threadId);
            if (!s || !hasLiveBackgroundWork(s)) return null;
            return backgroundAutoAttended(s) ? "auto" : "denied";
          },
          onAsk: (ask) => {
            const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
            askTools.set(ask.id, typeof ask.tool === "string" ? ask.tool : undefined);
            emit({
              ...base(threadId, eventTurnId),
              type: "request.opened",
              requestId: ask.id,
              requestType: ask.kind,
              tool: ask.tool,
              summary: askSummary(ask),
              inputDigest: inputDigest(ask.input ?? askArgs(ask)),
              approvalScope:
                typeof ask.tool === "string" && controlsHost && ask.tool.startsWith("mcp__computer")
                  ? "local-computer"
                  : undefined,
              choices: Array.isArray(ask.input?.choices) ? (ask.input.choices as string[]).slice(0, 5) : undefined,
              ...(ask.background ? { background: true } : {}),
            });
          },
          onResolve: (resolved) => {
            const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
            emit({
              ...base(threadId, eventTurnId),
              type: "request.resolved",
              requestId: resolved.id,
              behavior: resolved.behavior,
              source: resolved.source,
              approvalScope:
                controlsHost && typeof askTools.get(resolved.id) === "string" && askTools.get(resolved.id)!.startsWith("mcp__computer") ? "local-computer" : undefined,
            });
            askTools.delete(resolved.id);
          },
        });
      }
      if (sessionId) args.push("--resume", sessionId);
      else args.push("--session-id", newSessionId!);

      turnTimer.mark("spawnOrReuse");
      let child: ReturnType<typeof spawnCli>;
      try {
        if (turn.system && mcpConfigPath) {
          const systemPromptPath = join(dirname(mcpConfigPath), "system.txt");
          writeFileSync(systemPromptPath, turn.system, { mode: 0o600 });
          // Reuse compares the text; only the actual launch uses the file.
          args.splice(args.indexOf("--append-system-prompt"), 2, "--append-system-prompt-file", systemPromptPath);
        }
        child = spawnCli(config.cli, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        broker?.close();
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        throw error;
      }
      turnTimer.mark("cliReady");
      const session: Session = {
        child,
        broker,
        mcpConfigPath,
        argsKey,
        sessionId: sessionId ?? newSessionId,
        turn: { turnId, settled: false, sawStreamDelta: false, timer: turnTimer, launch: { request: turn, retry, abort: retryAbort } },
        idleTimer: null,
        autoAttended,
        background: new Map(),
        closing: false,
        stderr: "",
      };
      sessions.set(threadId, session);

      // settles the TURN, not the process: the CLI stays for the next
      // message until it has been quiet for SESSION_IDLE_MS
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: TurnUsage,
      ) => {
        const t = session.turn;
        if (!t || t.settled) return;
        t.narrationNotice = undefined;
        t.settled = true;
        // a held `result` already spent; keep it even when this turn ends
        // without one (interrupt, exit)
        if (t.carried) {
          cost = t.carried.cost + (cost ?? 0);
          usage = t.carried.usage ? addUsage(t.carried.usage, usage) : usage;
        }
        // Resolve any ask still open for this turn, but keep the broker
        // listening for the next turn on the retained process. Between turns
        // isActive() rejects late background asks without creating cards.
        session.broker?.pause();
        // the config file holds live credentials — the CLI read it at start;
        // it must not sit on disk for the life of the session
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
          session.mcpConfigPath = null;
        }
        // Only drop *this* turn. A replacement sendTurn after interrupt may
        // already own `active`; a late close must not steal it.
        if (active.get(threadId)?.turnId === t.turnId) active.delete(threadId);
        session.turn = null;
        // A settled turn owns no retry budget. Retained CLI sessions may run
        // many later turns on this thread, and each must start fresh.
        retryState.delete(threadId);
        t.timer.mark("turnDone");
        t.timer.finish();
        emit({
          ...base(threadId, t.turnId),
          type: "turn.completed",
          ok,
          stopReason,
          cost,
          ...(usage ? { usage } : {}),
          prompt: t.prompt,
          contextWindow: t.contextWindow,
          ...(t.promptAccepted ? { promptAccepted: true } : {}),
        });
        if (session.child.exitCode === null && !session.closing) armIdle(threadId);
      };
      session.settleTurn = settle;
      // A retained process can wake after `result` on its own: a background
      // Bash task's notification restarts the agent loop. That is real work,
      // so it gets a turn of its own instead of every ask being denied.
      const openContinuation = () => {
        if (session.turn || session.closing || session.child.exitCode !== null) return;
        if (sessions.get(threadId) !== session || active.has(threadId)) return;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = null;
        const continuationId = newId();
        const timer = startTurnTimer({ engine: "claude", model: turn.model, effort: turn.effort ?? null });
        session.turn = { turnId: continuationId, settled: false, sawStreamDelta: false, continuation: true, timer };
        active.set(threadId, {
          stop: () => {
            killCliTree(session.child);
            beginClose(threadId, "interrupted");
            settle(false, "exit_before_result");
          },
          turnId: continuationId,
          broker: session.broker,
        });
        emit({ ...base(threadId, continuationId), type: "turn.started" });
      };
      const currentTurnId = () => session.turn?.turnId ?? turnId;
      const toolCalls = new Map<string, { at: number; name: string; input: unknown; summary?: string }>();

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o });
        // a subagent's output belongs to the turn that spawned it; it never opens one
        if (
          !session.turn &&
          !o.parent_tool_use_id &&
          ((o.type === "system" && o.subtype === "init") || o.type === "stream_event" || o.type === "assistant" || o.type === "user")
        ) {
          openContinuation();
        }
        switch (o.type) {
          case "system":
            if (o.subtype === "init") {
              if (typeof o.session_id === "string") session.sessionId = o.session_id;
              emit({ ...base(threadId, currentTurnId()), type: "session.started", sessionId: o.session_id, model: o.model });
            } else if (o.subtype === "thinking_tokens") {
              emit({ ...base(threadId, currentTurnId()), type: "item.updated", itemType: "reasoning", tokens: o.estimated_tokens });
            } else if (o.subtype === "status" && o.status === "requesting" && session.turn) {
              session.turn.unsentSteers = 0;
            } else if (o.subtype === "task_started" && o.is_backgrounded === true && typeof o.task_id === "string") {
              // between turns only background work starts tasks; inherit from it
              session.background.set(o.task_id, {
                at: Date.now(),
                autoAttended: session.turn ? session.autoAttended : backgroundAutoAttended(session),
              });
            } else if (o.subtype === "task_notification" && typeof o.task_id === "string") {
              session.background.delete(o.task_id);
            }
            break;
          case "stream_event": {
            if (session.turn) session.turn.promptAccepted = true;
            // subagent narration is dropped — N parallel Tasks would
            // interleave their prose into one bubble (upstream-verified bug)
            if (o.parent_tool_use_id) break;
            const ev = o.event ?? {};
            if (ev.type !== "content_block_delta") break;
            const d = ev.delta ?? {};
            if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
              if (session.turn) session.turn.sawStreamDelta = true;
              session.turn?.timer.mark("firstVisible");
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: d.text });
            } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "reasoning_text", delta: d.thinking });
            }
            break;
          }
          case "assistant": {
            if (session.turn) session.turn.promptAccepted = true;
            const msg = o.message ?? {};
            // a subagent's final report is the main agent's input, not a reply
            if (!o.parent_tool_use_id) {
              const turn = session.turn;
              const messageId: string | undefined = msg.id || undefined;
              // A later assistant message is a new response unless it carries this id.
              if (turn?.narrationNotice && (turn.narrationNotice.messageId === undefined || turn.narrationNotice.messageId !== messageId)) {
                turn.narrationNotice = undefined;
              }
              const streamed = Boolean(turn?.sawStreamDelta);
              let sawPlain = false;
              for (const segment of replySegments(msg.content, o.narration_block_indexes)) {
                if (segment.summarized) {
                  // no delta: a summary must not flash as an unlabeled reply
                  turn?.timer.mark("firstVisible");
                  emit({
                    ...base(threadId, currentTurnId()),
                    type: "item.completed",
                    itemType: "assistant_text",
                    text: segment.text,
                    summarized: true,
                  });
                  if (turn && !turn.settled) {
                    const pending = turn.narrationNotice ?? { parts: [], messageId };
                    pending.parts.push(segment.text);
                    turn.narrationNotice = pending;
                  }
                  continue;
                }
                sawPlain = true;
                // fallback delta for CLIs/paths that never streamed the block
                if (!streamed) {
                  turn?.timer.mark("firstVisible");
                  emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: segment.text });
                }
                emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "assistant_text", text: segment.text });
              }
              if (turn && sawPlain) turn.sawStreamDelta = false;
              const blocks = Array.isArray(msg.content) ? msg.content : [];
              let callsTool = false;
              for (const block of blocks) {
                if (block?.type === "tool_use") callsTool = true;
              }
              if (turn && !turn.settled && callsTool && turn.narrationNotice?.parts.length) {
                const summary = turn.narrationNotice.parts.join(" / ");
                turn.narrationNotice = undefined;
                // Quoted summary of prose the CLI hid between tool calls; one per user message.
                if (!turn.narrationNoticeSent) {
                  turn.narrationNoticeSent = true;
                  void deliverSteer(session, threadId, narrationNotice(summary), false);
                }
              }
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "tool_use") {
                const summary = claudeToolSummary(b.name, b.input, cwd);
                toolCalls.set(b.id, { at: Date.now(), name: b.name, input: b.input, summary });
                emit({
                  ...base(threadId, currentTurnId()),
                  type: "item.started",
                  itemType: "tool",
                  itemId: b.id,
                  title: b.name,
                  ...(summary ? { summary } : {}),
                });
              }
            }
            if (msg.usage) {
              // this call's whole prompt: cache reads and writes fill the window too
              const prompt = (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0);
              // a subagent's calls carry its own context, not this session's
              if (session.turn && !o.parent_tool_use_id) {
                session.turn.prompt = { first: session.turn.prompt?.first ?? prompt, last: prompt };
                if (msg.model) session.turn.model = msg.model;
              }
              emit({
                ...base(threadId, currentTurnId()),
                type: "thread.token-usage.updated",
                input: prompt,
                output: msg.usage.output_tokens || 0,
                ...(typeof msg.usage.cache_read_input_tokens === "number"
                  ? { cachedInput: msg.usage.cache_read_input_tokens }
                  : {}),
              });
            }
            break;
          }
          case "user":
            for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
              if (b.type === "tool_result") {
                const call = toolCalls.get(b.tool_use_id);
                toolCalls.delete(b.tool_use_id);
                const summary = call?.name === "Bash" ? claudeToolSummary(call.name, call.input, cwd, firstText(b.content).slice(0, 40)) : undefined;
                emit({
                  ...base(threadId, currentTurnId()),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: b.tool_use_id,
                  ok: !b.is_error,
                  ...(summary && summary !== call?.summary ? { summary } : {}),
                  ...(call ? { durationMs: Date.now() - call.at } : {}),
                });
              }
            }
            break;
          case "rate_limit_event": {
            // the account's subscription windows, read by the CLI from the
            // API's rate-limit headers. Per account, so the harness keeps
            // the newest per instance rather than banking it on the task
            const windows = claudeRateLimitWindows(o.rate_limit_info);
            if (windows.length > 0) emit({ ...base(threadId, currentTurnId()), type: "account.rate-limits.updated", windows });
            break;
          }
          case "result":
            if (session.turn) session.turn.narrationNotice = undefined;
            // a local host's window is the catalog's; the CLI only guesses it
            if (session.turn && !injected.injected) {
              const window = o.modelUsage?.[session.turn.model ?? ""]?.contextWindow;
              if (Number.isSafeInteger(window) && window > 0) session.turn.contextWindow = window;
            }
            // A steer that missed the last request is answered as its own
            // query right after this `result`. Settling here frees the thread
            // under it, so a queued send races the CLI and lands out of order.
            if (o.is_error !== true && session.turn?.unsentSteers) {
              const t = session.turn;
              t.unsentSteers = 0;
              const usage = claudeUsage(o.usage);
              t.carried = {
                cost: (t.carried?.cost ?? 0) + (o.total_cost_usd ?? 0),
                usage: t.carried?.usage ? addUsage(t.carried.usage, usage) : usage,
              };
              break;
            }
            // result.usage is this invocation's total — one process per turn,
            // so it is the turn's figure (settle adds any held result).
            settle(o.is_error !== true, o.stop_reason ?? o.terminal_reason ?? null, o.total_cost_usd ?? null, claudeUsage(o.usage));
            break;
        }
      };

      let buf = "";
      // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
      // multibyte characters that straddle two reads and corrupts the text
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handleLine(line);
        }
      });

      child.stderr.on("data", (c) => {
        session.stderr += c;
        if (session.stderr.length > 8192) session.stderr = session.stderr.slice(-8192);
      });

      child.on("error", (e) => {
        emit({ ...base(threadId, currentTurnId()), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });

      child.on("close", (code) => {
        // a turn still running when the process died is a failed turn; a
        // process that exited between turns (idle close, contract change)
        // is just a session ending
        // A retained process may be on a later turn than the one that
        // spawned it: retry, cancel and relaunch THAT turn, not this
        // closure's, or the harness sees a settled id and stays busy.
        const t = session.turn;
        const launch = t?.launch;
        if (t && !t.settled) {
          const message = `claude exited ${code} before result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`;
          const resumeRejected = Boolean(
            launch &&
            sessionId &&
            launch.request.resumeFallback &&
            !t.sawStreamDelta &&
            isResumeCursorRejected(session.stderr),
          );
          if (launch && resumeRejected) {
            session.broker?.pause();
            session.broker?.close();
            if (session.mcpConfigPath) {
              try {
                rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
              } catch {}
              session.mcpConfigPath = null;
            }
            sessions.delete(threadId);
            t.narrationNotice = undefined;
            session.turn = null;
            active.delete(threadId);
            retryState.delete(threadId);
            emit({ ...base(threadId, t.turnId), type: "turn.retrying", attempt: 1, delayMs: 0, reason: "resume_cursor" });
            void sendTurn({
              ...launch.request,
              text: launch.request.resumeFallback!.text,
              resumeCursor: undefined,
              resumeFallback: undefined,
            }, t.turnId).catch((error) => {
              emit({
                ...base(threadId, t.turnId),
                type: "runtime.error",
                message: error instanceof Error ? error.message : String(error),
              });
              t.timer.mark("turnDone");
              t.timer.finish();
              emit({ ...base(threadId, t.turnId), type: "turn.completed",
                ok: false,
                stopReason: "resume_fallback_failed",
                cost: null,
              });
            });
            return;
          }
          const verdict = classifyError({ exitCode: code, stderr: message });
          if (
            launch &&
            !launch.retry.cancelled &&
            code !== 0 &&
            verdict.transient &&
            !t.sawStreamDelta &&
            launch.retry.attempt < RETRY_MAX_ATTEMPTS - 1
          ) {
            // the CLI is gone but the TURN continues: keep the thread busy,
            // emit no terminal event, and relaunch after the backoff. The
            // `active` entry STAYS — it is what makes an interrupt during
            // the backoff reach this turn's stop() and cancel the retry.
            const failedBroker = session.broker;
            session.broker = undefined;
            failedBroker?.pause();
            failedBroker?.close();
            if (session.mcpConfigPath) {
              try {
                rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
              } catch {}
              session.mcpConfigPath = null;
            }
            sessions.delete(threadId);
            t.narrationNotice = undefined;
            session.turn = null;
            launch.retry.attempt++;
            const delayMs = computeBackoff(launch.retry.attempt - 1);
            emit({
              ...base(threadId, t.turnId),
              type: "turn.retrying",
              attempt: launch.retry.attempt,
              delayMs,
              reason: verdict.reason,
            });
            void (async () => {
              const wait = interruptibleDelay(delayMs * retryScale, launch.abort.signal);
              await wait.promise;
              // an interrupt during the backoff landed here via stop(); the
              // turn settles as interrupted and no zombie relaunch happens
              if (launch.retry.cancelled) {
                active.delete(threadId);
                retryState.delete(threadId);
                t.timer.mark("turnDone");
                t.timer.finish();
                emit({ ...base(threadId, t.turnId), type: "turn.completed",
                  ok: false,
                  stopReason: "interrupted",
                  cost: null,
                });
                return;
              }
              // hand the thread back before recursing — the relaunch's own
              // guard would otherwise reject it as "already running"
              active.delete(threadId);
              try {
                const cursor = session.sessionId ?? sessionId ?? undefined;
                await sendTurn({ ...launch.request, resumeCursor: cursor }, t.turnId);
              } catch (e) {
                retryState.delete(threadId);
                emit({
                  ...base(threadId, t.turnId),
                  type: "runtime.error",
                  message: e instanceof Error ? e.message : String(e),
                });
                t.timer.mark("turnDone");
                t.timer.finish();
                emit({ ...base(threadId, t.turnId), type: "turn.completed",
                  ok: false,
                  stopReason: "exit_before_result",
                  cost: null,
                });
              }
            })();
            return;
          }
          retryState.delete(threadId);
          emit({
            ...base(threadId, currentTurnId()),
            type: "runtime.error",
            message,
          });
          settle(false, "exit_before_result");
        }
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.broker?.close();
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        if (sessions.get(threadId) === session) sessions.delete(threadId);
      });

      const stop = () => {
        retry.cancelled = true;
        retryAbort.abort();
        killCliTree(child);
        // Release the thread now. On Windows killCliTree is async taskkill, so
        // waiting for `close` before active.delete rejects Resume-after-Stop
        // with "a turn is already running on this thread". Keep the broker
        // listening until the child exits (or a replacement sendTurn binds).
        beginClose(threadId, "interrupted");
        settle(false, "exit_before_result");
        if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
      };
      active.set(threadId, { stop, turnId, broker });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // prompt over stdin as a stream-json message — never argv (ARG_MAX).
      // stdin stays OPEN: that is what keeps the session alive for a
      // mid-turn steer or the next turn; closeSession() ends it.
      if (!(await writeUser(session, threadId, turn.text))) {
        settle(false, "stdin_write_failed");
        closeSession(threadId, "stdin write failed");
      }

      return { turnId };
    };

    /** Same stdin write and unsent-steer count as a user steer. */
    const deliverSteer = (s: Session, threadId: string, text: string, attachImages = true): Promise<boolean> => {
      const turn = s.turn;
      if (!turn || turn.settled || s.closing || s.child.exitCode !== null) return Promise.resolve(false);
      turn.unsentSteers = (turn.unsentSteers ?? 0) + 1;
      return writeUser(s, threadId, text, attachImages).then((written) => {
        if (!written && turn.unsentSteers) turn.unsentSteers -= 1;
        return written;
      });
    };

    /** A user message into the running turn: the CLI delivers it before its
     * next model call. False when nothing is running here to steer. */
    const steer = (threadId: string, text: string): Promise<boolean> => {
      const s = sessions.get(threadId);
      if (!s) return Promise.resolve(false);
      if (s.turn) s.turn.narrationNoticeSent = false;
      return deliverSteer(s, threadId, text);
    };

    const signedIn = cachedSignIn(() =>
      claudeSignedIn(config.cli, claudeEnvironment(undefined, { ...process.env, ...input.environment })),
    );
    const snapshot = async (opts?: { rescan?: boolean }): Promise<ProviderSnapshot> => {
      const env = claudeEnvironment(undefined, { ...process.env, ...input.environment });
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const authenticated = await signedIn(opts?.rescan);
      // claudeEnvironment strips ANTHROPIC_API_KEY, so turns run on the
      // CLI's own login (Pro/Max): the cost it reports is what the call
      // WOULD bill, not a charge
      return { state: "available", version, authenticated, billing: "subscription" };
    };

    /** One-shot Claude call with the prompt on stdin, never argv. Approval
     * summaries can contain paths, commands, or secrets, so the generic
     * `claude -p "prompt"` shape is not safe for review. No tools or MCP
     * servers are mounted in this isolated process. */
    const generateReview = (prompt: string, signal?: AbortSignal): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawnCli(
          config.cli,
          ["-p", "--model", "claude-haiku-4-5", "--output-format", "text"],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: claudeEnvironment("claude-haiku-4-5", { ...process.env, ...input.environment }),
          },
        );
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(stdout.trim());
        };
        const onAbort = () => {
          killCliTree(child);
          finish(new Error("Claude review aborted"));
        };
        const timer = setTimeout(() => {
          killCliTree(child);
          finish(new Error("Claude review timed out"));
        }, 60_000);
        timer.unref?.();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.length > 1_000_000) {
            killCliTree(child);
            finish(new Error("Claude review output exceeded 1 MB"));
          }
        });
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-8_192);
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
          if (code === 0) finish();
          else finish(new Error(stderr.trim() || `Claude review exited ${code}`));
        });
        if (signal?.aborted) onAbort();
        else {
          signal?.addEventListener("abort", onAbort, { once: true });
          child.stdin.end(prompt);
        }
      });

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
          agentsMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          browserMcp: true,
          images: true,
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
          queueing: true,
          localComputerMcp: config.permissionMode !== "bypassPermissions",
          askApproval: config.permissionMode !== "bypassPermissions",
          rateLimits: true,
        },
        sendTurn,
        steer,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          // fail-closed by construction: no broker, or an ask that already
          // timed out / settled, is `unavailable` — the caller denies
          const broker = sessions.get(threadId)?.broker ?? active.get(threadId)?.broker;
          if (!broker) return "unavailable";
          const behavior = decision.behavior === "answer" ? "answer" : decision.behavior;
          if (!broker.answer(requestId, behavior, decision.message)) return "unavailable";
          return behavior === "allow" ? "allowed-once" : behavior === "answer" ? "answered" : "rejected";
        },
        hasSession: (threadId) => active.has(threadId),
        hasBackgroundWork: (threadId) => {
          const s = sessions.get(threadId);
          return Boolean(s && hasLiveBackgroundWork(s));
        },
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
          for (const threadId of [...sessions.keys()]) closeSession(threadId, "stopAll");
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt) => generateReview(prompt),
      reviewPermission: generateReview,
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        for (const threadId of [...sessions.keys()]) closeSession(threadId, "dispose");
        listeners.clear();
      },
    };
  },
};
