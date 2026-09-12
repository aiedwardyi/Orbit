#!/usr/bin/env node
// Fake of an ACP (Agent Client Protocol) CLI's stdio surface, for driver
// tests of acp/core.ts + its harness shims (grok, gemini). Speaks JSON-RPC
// 2.0 over stdin/stdout: answers initialize / authenticate / session/new /
// session/prompt, and streams session/update notifications for a scripted
// turn. Failure modes mirror how real ACP agents misbehave:
//
//   FAKE_ACP_MODE   happy (default) | empty-reply | exit-early | fail-after-text | hang | no-auth | auth-required | permission | channel-peer
//                   | usage-limit (prompt rejects -32603 with rate-limit data)
//                   | usage-limit-silent (same rejection, no data at all)
//                   | permission-twice (two sequential cards in one turn)
//                   | interleave (message → tool → message → tool → message)
//                   | no-session-config (reject session/set_mode + set_model
//                     with -32601, i.e. an agent predating those methods)
//                   | ask-peer (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//                   | delegate-peer (same as ask-peer but uses delegate_bot —
//                     returns immediately, the peer runs after our turn)
//                   | create-peer (a Chief creates a specialist, then delegates
//                     work to it through the returned id)
//                   | echo-gated (reply by echoing the full prompt, and when
//                     FAKE_ACP_GATE_FILE is set hold the turn open until that
//                     file exists — a deterministic busy window for the
//                     steer-queue e2e, with the echo pinning exactly what a
//                     drained turn was sent)
//   FAKE_ACP_DUMP   path to write {argv, env} as JSON, so a test can assert
//                   argv shape (agent/stdio flags) and env hygiene. Per-session
//                   settings land next to it in `<path>.config.json`, so a test
//                   can assert the model the driver actually transmitted.
//   FAKE_ACP_MODELS      comma-separated model ids. Enables the opencode-shaped
//                        surface: session/new and session/load return
//                        configOptions, and session/set_config_option switches
//                        the model (rejecting an unadvertised one with -32602).
//   FAKE_ACP_MODEL_STICKS  session/set_config_option succeeds but leaves the
//                        model where it was, so the confirmation guard in
//                        core.ts has something to catch
//   FAKE_ACP_USAGE_ROOT  put the prompt result's usage at the root instead of
//                        under _meta (what opencode 1.18.18 actually does)
//   FAKE_ACP_PERMISSION_KINDS  comma-separated ACP option kinds, in the order
//                        the agent advertises them (e.g.
//                        "allow_always,allow_once,reject_always,reject_once").
//                        Unset keeps the two-option list every existing mode
//                        already sees. The chosen optionId lands in
//                        `$FAKE_ACP_DUMP.permission.json`.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
let runningPromptId: number | undefined;
// opencode-shaped surface: the session carries its own model catalog and the
// model is chosen with session/set_config_option, because `opencode acp` takes
// no -m. Off unless FAKE_ACP_MODELS is set, so every existing mode is byte-
// identical to before.
const models = (process.env.FAKE_ACP_MODELS ?? "").split(",").filter(Boolean);
let currentModel: string | null = models[0] ?? null;
const configOptions = () =>
  models.length
    ? [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: models.map((value) => ({ value, name: value })),
        },
      ]
    : null;
// cursor-shaped surface: the session advertises `models.availableModels` with
// parameterised ids (`default[]`) that differ from the argv `--model` slugs
// (`auto`). Off unless FAKE_ACP_SESSION_MODELS is set, so every existing mode
// stays byte-identical. Format: "id|Name,id|Name" — the name is optional.
const acpModels = (process.env.FAKE_ACP_SESSION_MODELS ?? "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [modelId, name] = entry.split("|");
    return name ? { modelId, name } : { modelId };
  });
const sessionModels = () =>
  acpModels.length ? { currentModelId: acpModels[0].modelId, availableModels: acpModels } : null;

const argv = process.argv.slice(2);
const dumpEnv = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "FAKE_ACP_MODE",
    "FAKE_ACP_RPC_DUMP",
    "TEST_POLICY",
    "OPENCODE_API_KEY",
    "OPENCODE_CONFIG_CONTENT",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "BOX_TOKEN",
    "OMB_TTS_KEY",
    "FACTORY_API_KEY",
    "UNSLOTH_STUDIO_AUTH_TOKEN",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
    "MINIMAX_API_KEY",
    "OPENAI_COMPAT_API_KEY",
    "OPENAI_COMPAT_URL",
    "OMB_OPENAI_IMAGE_KEY",
    "COMPOSIO_API_KEY",
    "OMB_COMPOSIO_BROKER_TOKEN",
    "ACME_API_KEY",
    "NEWPROVIDER_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_DISPLAY_NAME",
    "TEST_TURN_MODEL",
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]] as const)),
);
const dumpState: Record<string, unknown> = { argv, env: dumpEnv };
if (process.env.FAKE_ACP_DUMP) {
  writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify({ argv, env: dumpEnv }, null, 2));
}
if (argv.includes("--version")) {
  console.log("fake-acp 1.0.0");
  process.exit(0);
}
// Cursor's driver probes `agent status` / `agent models` on the same binary
// it later spawns for ACP. Answer those without entering the JSON-RPC loop
// so catalog/auth tests do not hang on stdin.
if (argv[0] === "status" || argv[0] === "whoami") {
  const authenticated = process.env.FAKE_ACP_AUTH !== "0";
  console.log(JSON.stringify({ isAuthenticated: authenticated }));
  process.exit(0);
}
if (argv[0] === "models" || argv.includes("--list-models")) {
  if (models.length) {
    const verbose = argv.includes("--verbose");
    console.log(
      models.flatMap((slug) => verbose
        ? [
            slug,
            JSON.stringify({
              id: slug.slice(slug.indexOf("/") + 1),
              providerID: slug.slice(0, slug.indexOf("/")),
              name: slug,
              status: "active",
              limit: { context: 200_000 },
            }, null, 2),
          ]
        : [slug]).join("\n"),
    );
    process.exit(0);
  }
  console.log(
    [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5 (current)",
      "gpt-5.3-codex - Codex 5.3",
      "cursor-live - Cursor Live",
    ].join("\n"),
  );
  process.exit(0);
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });
const rpcMethods: string[] = [];
const recordMethod = (method: string) => {
  rpcMethods.push(method);
  if (process.env.FAKE_ACP_RPC_DUMP) writeFileSync(process.env.FAKE_ACP_RPC_DUMP, JSON.stringify(rpcMethods));
};

interface ConfigCallParams {
  sessionId?: string;
  modeId?: string;
  modelId?: string;
  configId?: string;
  value?: string;
}
// session/set_mode + session/set_model + session/set_config_option calls seen
// this run
const configCalls: Array<{ method: string; params: unknown }> = [];
const recordConfigCall = (method: string, params: ConfigCallParams) => {
  configCalls.push({ method, params });
  if (process.env.FAKE_ACP_DUMP) {
    writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
  }
};

// Permission options this run advertises, in order. Unset env keeps the list
// every existing mode already sees, so those stay byte-identical.
const permissionKinds = (process.env.FAKE_ACP_PERMISSION_KINDS ?? "").split(",").filter(Boolean);
const permissionOptions = () =>
  permissionKinds.length
    ? permissionKinds.map((kind) => ({ optionId: kind, kind }))
    : [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ];

// optionIds the client actually selected, so a test can assert the driver sent
// back the option the human chose and not merely one of the right family
const permissionPicks: Array<string | null> = [];
const recordPermissionPick = (msg: any) => {
  permissionPicks.push(msg.result?.outcome?.optionId ?? null);
  if (process.env.FAKE_ACP_DUMP) {
    writeFileSync(`${process.env.FAKE_ACP_DUMP}.permission.json`, JSON.stringify(permissionPicks, null, 2));
  }
};

// pending server→client permission request id → resolver
let pendingPermissionId: number | null = null;
let onPermissionAnswered: (() => void) | null = null;

// ask-peer mode: the "agents" MCP server entry from session/new's mcpServers
type McpEntry = { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;

/** Minimal one-shot MCP stdio client: initialize, call each tool in
 * sequence, return the text of the last result. Dependency-free. */
function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => object }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    child.on("error", reject);
    const timer = setTimeout(() => (child.kill(), reject(new Error("mcp timeout"))), 60_000);
    let step = -1; // -1 = initialize in flight
    let last = "";
    const write = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
    const next = () => {
      step += 1;
      if (step >= calls.length) {
        clearTimeout(timer);
        child.kill();
        return resolve(last);
      }
      const call = calls[step];
      write({ jsonrpc: "2.0", id: step + 2, method: "tools/call", params: { name: call.name, arguments: call.args(last) } });
    };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(msg.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });
}

function playTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello from fake acp" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
}

/** Scripted text → tool → text → tool → text turn for order-contract tests. */
function playInterleaveTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before one" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before two" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "after" } } } });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg: any) {
  // client's response to our permission request
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    recordPermissionPick(msg);
    onPermissionAnswered?.();
    return;
  }
  if (!msg.method) return;
  recordMethod(msg.method);

  switch (msg.method) {
    case "initialize": {
      if (mode === "exit-early") {
        process.stderr.write("fake-acp: simulated crash before result\n");
        process.exit(3);
      }
      const authMethods = mode === "no-auth" ? [] : [{ id: "cached_token" }];
      result(msg.id, { protocolVersion: 1, authMethods, _meta: { modelState: { currentModelId: "fake-acp-model" } } });
      break;
    }
    case "authenticate":
      result(msg.id, {});
      break;
    case "session/new": {
      if (mode === "auth-required") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "Authentication required", data: { providerId: "opencode-go" } },
        });
        break;
      }
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      if (process.env.FAKE_ACP_DUMP) {
        dumpState.mcpServers = servers;
        writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? null;
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(servers, null, 2));
      }
      const opts = configOptions();
      const mdls = sessionModels();
      result(msg.id, {
        sessionId: "fake-acp-session",
        ...(opts ? { configOptions: opts } : {}),
        ...(mdls ? { models: mdls } : {}),
      });
      break;
    }
    case "session/load": {
      if (mode === "load-fails") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "session not found" } });
        break;
      }
      const opts = configOptions();
      const mdls = sessionModels();
      result(msg.id, { ...(opts ? { configOptions: opts } : {}), ...(mdls ? { models: mdls } : {}) });
      break;
    }
    // per-session settings (droid sets model/autonomy here, not via argv).
    // Recorded to `$FAKE_ACP_DUMP.config.json`, with session/set_config_option
    // below, so a test can assert what the driver actually put on the wire.
    // NOTE: last writer wins — each turn spawns a fresh child, so a two-turn
    // test would only ever see the final turn's calls.
    case "session/set_mode":
    case "session/set_model": {
      if (mode === "no-session-config") {
        // an older agent that predates these methods
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      if (mode === "set-model-invalid-params" && msg.method === "session/set_model") {
        // an agent whose ACP model namespace does not contain the id it was
        // sent — Cursor's answer when handed an argv slug like `auto`.
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
      }
      const settingId = msg.method === "session/set_mode" ? "modeId" : "modelId";
      if (typeof msg.params?.sessionId !== "string" || typeof msg.params?.[settingId] !== "string") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: sessionId and ${settingId} must be strings` },
        });
        break;
      }
      recordConfigCall(msg.method, msg.params);
      result(msg.id, {});
      break;
    }
    case "session/set_config_option": {
      const { configId, value } = msg.params ?? {};
      // Recorded before validation: a test asserting what the driver put on
      // the wire must see a rejected switch too, not just an accepted one.
      recordConfigCall(msg.method, msg.params);
      if (configId !== "model" || !models.includes(value)) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: model not found: ${value}`, data: { modelId: value } },
        });
        break;
      }
      // FAKE_ACP_MODEL_STICKS: answer OK and keep the old model anyway. Nothing
      // in the protocol forbids it, and it is the shape core.ts's confirmation
      // guard exists for — an error is loud, this is silent.
      if (!process.env.FAKE_ACP_MODEL_STICKS) currentModel = value;
      result(msg.id, { configOptions: configOptions() });
      break;
    }
    case "session/prompt": {
      if (mode.startsWith("steer")) {
        if (runningPromptId === undefined) {
          runningPromptId = msg.id;
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "working" } } } });
        } else if (mode === "steer-result-first") {
          // the queued prompt's result lands before its interjection notice
          result(msg.id, { stopReason: "cancelled", _meta: { promptId: "injected-1", completionKind: "removedFromQueue" } });
          setTimeout(() => {
            out({ jsonrpc: "2.0", method: "_x.ai/session/interjection", params: { sessionId: msg.params.sessionId, interjectionId: "injected-1", text: msg.params.prompt[0].text } });
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: msg.params.prompt[0].text } } } });
            setTimeout(() => result(runningPromptId, { stopReason: "end_turn" }), 30);
          }, 10);
        } else if (mode === "steer-original-first") {
          // the running prompt ends before Grok interjects, so the queued one runs as its own prompt
          result(runningPromptId, { stopReason: "end_turn" });
          setTimeout(() => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: msg.params.prompt[0].text } } } });
            result(msg.id, { stopReason: "end_turn", _meta: { promptId: "injected-1" } });
          }, 30);
        } else {
          if (mode !== "steer-removed") {
            out({ jsonrpc: "2.0", method: "_x.ai/session/interjection", params: { sessionId: msg.params.sessionId, interjectionId: "injected-1", text: msg.params.prompt[0].text } });
          }
          result(msg.id, { stopReason: "cancelled", _meta: { promptId: "injected-1", completionKind: "removedFromQueue" } });
          if (mode !== "steer-removed") {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: msg.params.prompt[0].text } } } });
            setTimeout(() => result(runningPromptId, { stopReason: "end_turn" }), 30);
          }
        }
        break;
      }
      if (process.env.FAKE_ACP_DUMP) {
        dumpState.prompt = msg.params?.prompt;
        writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      if (mode === "hang") {
        // never resolve the prompt — lets tests exercise interrupt
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "usage-limit" || mode === "usage-limit-silent") {
        // Grok answers an exhausted subscription with a bare JSON-RPC
        // "Internal error"; only the silent variant leaves `data` empty.
        recordMethod("session/prompt.error");
        const error = { code: -32603, message: "Internal error" };
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: mode === "usage-limit"
            ? { ...error, data: { error: { type: "rate_limit_exceeded", message: "Rate limit exceeded" } } }
            : error,
        });
        return;
      }
      if (mode === "fail-after-text") {
        // Stream real text, THEN fail the turn — the shape of a crash
        // mid-answer. This is the one case where the routine-failed/done
        // notification dedup is load-bearing: the reply is non-empty, so
        // nothing else suppresses the generic done.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half a report, then a crash" } } } });
        recordMethod("session/prompt.error");
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fake acp: turn failed after streaming" } });
        return;
      }
      const complete = () => {
        recordMethod("session/prompt.result");
        result(
          msg.id,
          // FAKE_ACP_USAGE_ROOT reproduces opencode 1.18.18's shape: usage at
          // the result root with an empty _meta, instead of usage under _meta.
          process.env.FAKE_ACP_USAGE_ROOT
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, _meta: {} }
            : { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } },
        );
      };
      if (mode === "ask-peer" && agentsMcp) {
        // the comms e2e: reach a peer bot through the injected agents proxy
        // and reply with whatever it said (the peer's fake runs plain happy
        // — its depth-1 turn gets no agents server, so no recursion)
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "ask_bot",
            args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "ping from fake" }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer says: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "channel-peer" && agentsMcp) {
        // the create_channel e2e: a bot opening a shared room asks for a
        // section of its own choosing — the harness must not honour it
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "create_channel",
            args: (list) => ({
              name: "Launch room",
              member_ids: [/id: ([\w-]+)/.exec(list)?.[1] ?? ""],
              section: "Somewhere Else",
              bulletin: "Ship the launch.",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `channel: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `channel error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "create-peer" && agentsMcp) {
        void driveMcp(agentsMcp, [
          {
            name: "create_bot",
            args: () => ({
              name: "Pixel",
              role: "Product designer",
              instructions: "Design and review the user experience.",
            }),
          },
          {
            name: "delegate_bot",
            args: (created) => ({
              bot_id: /id: ([\w-]+)/.exec(created)?.[1] ?? "",
              message: "Review the new onboarding flow.",
              reason: "design review",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `team created: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `create error: ${message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "echo-gated") {
        // echoing the WHOLE prompt (system + turn text) lets a test assert
        // both what a drained turn was sent and what it was NOT sent (e.g.
        // the webhook untrusted-data paragraph a steered turn must not get)
        const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
        const finish = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `echo: ${promptText}` } } } });
          complete();
        };
        const gate = process.env.FAKE_ACP_GATE_FILE;
        if (gate && !existsSync(gate)) {
          const poll = setInterval(() => {
            if (!existsSync(gate)) return;
            clearInterval(poll);
            finish();
          }, 50);
          return;
        }
        finish();
        return;
      }
      if (mode === "delegate-peer" && agentsMcp) {
        // async peer-handoff e2e: queue the delegation and return
        // immediately; the harness fires the peer's depth-1 turn after our
        // turn settles. We don't need the peer's reply in our text — the
        // comms e2e verifies the channel mirroring on its own.
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "delegate_bot",
            args: (list) => ({
              bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: "delegated task",
              reason: "followup",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegated: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "interleave") playInterleaveTurn();
      else if (mode !== "empty-reply") playTurn();
      if (mode === "permission" || mode === "permission-twice") {
        // ask the client to approve a tool, then complete once answered
        const commands = mode === "permission-twice" ? ["echo hi", "echo again"] : ["echo hi"];
        const ask = () => {
          const command = commands.shift()!;
          pendingPermissionId = 9000 + commands.length;
          onPermissionAnswered = commands.length ? ask : complete;
          out({
            jsonrpc: "2.0",
            id: pendingPermissionId,
            method: "session/request_permission",
            params: {
              toolCall: { kind: "execute", rawInput: { command }, title: command },
              options: permissionOptions(),
            },
          });
        };
        ask();
        return;
      }
      complete();
      break;
    }
    case "_x.ai/billing":
      if (mode === "billing-hang") return;
      if (mode === "billing-fail") {
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "billing failed" } });
      }
      result(msg.id, {
        config: {
          creditUsagePercent: Number(process.env.FAKE_ACP_BILLING_PERCENT ?? 42),
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-08T00:00:00Z",
            end: "2026-09-15T12:00:00Z",
          },
        },
      });
      break;
    case "session/cancel":
      // the interrupted prompt resolves as cancelled
      break;
    default:
      recordMethod(`${msg.method}.error`);
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
