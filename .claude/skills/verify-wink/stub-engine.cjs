// Stand-in for the five engine CLIs, at the same stdio boundary the drivers spawn.
// Usage (as a configured `cli`): "<node>" "<this file>" <claude|grok|codex|antigravity|muse> ...driver args
// Replies read: STUB <ENGINE> <model> | re: <last line of the prompt> | <n> image
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");

const [engine, ...args] = process.argv.slice(2);
const DELAY = Number(process.env.WINK_STUB_DELAY_MS ?? 300);
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const note = (kind, extra = {}) => {
  if (process.env.WINK_STUB_LOG) appendFileSync(process.env.WINK_STUB_LOG, `${JSON.stringify({ at: Date.now(), pid: process.pid, engine, kind, ...extra })}\n`);
};
const flag = (...names) => {
  const at = args.findIndex((arg) => names.includes(arg));
  return at >= 0 ? args[at + 1] : undefined;
};

function reply(model, content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const text = blocks.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
  const last = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  const images = blocks.filter((block) => /image/i.test(String(block?.type))).length;
  // The last line only: after a Stop, Wink's task record quotes the stopped message above the next prompt.
  const delay = last.includes("[hold]") ? 15_000 : DELAY;
  note("prompt", { model, last, images, delay });
  return { delay, text: [`STUB ${engine.toUpperCase()} ${model}`, last && `re: ${last.slice(0, 60)}`, images && `${images} image`].filter(Boolean).join(" | ") };
}

function lines(onMessage) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      onMessage(JSON.parse(line));
    } catch (error) {
      note("bad-line", { error: error.message });
    }
  }).on("close", () => process.exit(0));
}

function readAll() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => resolve(text));
  });
}

const rpc = (id, result) => out({ jsonrpc: "2.0", id, result });
const notify = (method, params) => out({ jsonrpc: "2.0", method, params });

const VERSIONS = { claude: "2.1.200 (wink-verify stub)", grok: "grok 1.0.46", codex: "codex-cli 0.147.0", antigravity: "1.1.12", muse: "muse 1.4.2" };
if (!VERSIONS[engine]) {
  process.stderr.write(`stub-engine: unknown engine ${engine}\n`);
  process.exit(2);
}
if (args.includes("--version")) {
  console.log(VERSIONS[engine]);
  process.exit(0);
}
note("spawn", { args });

if (engine === "claude") {
  if (args[0] === "auth") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
    process.exit(0);
  }
  const model = flag("--model") ?? "claude";
  // One-shot helpers (notes, reviews) read stdin and expect plain text; an empty answer adds nothing.
  if (flag("--output-format") === "text") readAll().then(() => process.exit(0));
  else {
    const session = randomUUID();
    let initialized = false;
    lines((message) => {
      if (message.type === "control_request") {
        out({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
        return;
      }
      if (message.type !== "user") return;
      if (!initialized) {
        initialized = true;
        out({ type: "system", subtype: "init", session_id: session, model });
      }
      out({ type: "system", subtype: "status", status: "requesting" });
      const { text, delay } = reply(model, message.message?.content);
      const half = Math.ceil(text.length / 2);
      setTimeout(() => out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(0, half) } } }), delay / 2);
      setTimeout(() => {
        out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(half) } } });
        out({ type: "assistant", message: { id: randomUUID(), content: [{ type: "text", text }] } });
        out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
      }, delay);
    });
  }
}

if (engine === "grok") {
  const sessionId = randomUUID();
  let model = flag("-m", "--model") ?? "grok";
  lines((message) => {
    if (message.id === undefined || message.result !== undefined) return;
    const { method, params } = message;
    if (method === "session/prompt") {
      const { text, delay } = reply(model, params?.prompt);
      setTimeout(() => {
        notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
        rpc(message.id, { stopReason: "end_turn" });
      }, delay);
      return;
    }
    if (method === "session/set_config_option" && params?.configId === "model") model = params.value;
    const options = [{ id: "model", currentValue: model }, { id: "reasoning_effort", category: "thought_level", currentValue: "high" }];
    const results = {
      initialize: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cached_token", name: "Stub" }] },
      "session/new": { sessionId, configOptions: options },
      "session/load": { sessionId, configOptions: options },
      "session/set_config_option": { configOptions: options },
      "_x.ai/billing": { windows: [] },
    };
    rpc(message.id, results[method] ?? {});
  });
}

if (engine === "codex") {
  if (args[0] === "login") {
    process.stderr.write("Logged in using ChatGPT\n");
    process.exit(0);
  }
  let model = "codex";
  lines((message) => {
    const { id, method, params } = message;
    if (id === undefined || method === undefined) return;
    if (method === "initialize") return rpc(id, { userAgent: "wink-verify-stub" });
    // An error keeps the driver on Wink's built-in catalog.
    if (method === "model/list") return out({ jsonrpc: "2.0", id, error: { code: -32601, message: "stub has no catalog" } });
    if (method === "thread/start" || method === "thread/resume") {
      model = params?.model ?? model;
      return rpc(id, { thread: { id: params?.threadId ?? randomUUID() }, model });
    }
    if (method !== "turn/start") return rpc(id, {});
    model = params?.model ?? model;
    const turnId = randomUUID();
    rpc(id, { turn: { id: turnId } });
    notify("turn/started", { threadId: params?.threadId, turn: { id: turnId } });
    const { text, delay } = reply(model, params?.input);
    setTimeout(() => {
      notify("item/agentMessage/delta", { itemId: "m1", delta: text });
      notify("item/completed", { item: { id: "m1", type: "agentMessage", text } });
      notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } } });
      notify("turn/completed", { turn: { id: turnId, status: "completed" } });
    }, delay);
  });
}

if (engine === "antigravity") {
  const model = flag("--model") ?? "antigravity";
  const conversation = flag("--conversation") ?? randomUUID();
  const prompt = flag("--input-format") === "stream-json"
    ? readAll().then((raw) => JSON.parse(raw.split(/\r?\n/).find((line) => line.trim()) ?? "{}").message?.content)
    : Promise.resolve(flag("-p", "--print"));
  prompt.then((content) => {
    if (content === undefined) process.exit(0);
    const { text, delay } = reply(model, content);
    out({ event: "init", conversation_id: conversation, init: { cwd: process.cwd(), tools: [], permission_mode: "accept-edits" } });
    setTimeout(() => {
      const usage = { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 };
      out({ event: "step_update", conversation_id: conversation, step_update: { conversation_id: conversation, step_index: 0, state: "DONE", step_type: "agent_response", usage } });
      out({ event: "result", conversation_id: conversation, result: { conversation_id: conversation, status: "SUCCESS", response: text, duration_seconds: 1, num_turns: 1, usage } });
      process.exit(0);
    }, delay);
  });
}

if (engine === "muse") {
  const sessionId = randomUUID();
  let model = "muse-spark-1.3";
  let running = null;
  lines((message) => {
    const { id, method, params } = message;
    // Wink's Stop sends turn/interrupt as a notification, with no id.
    if (method === "turn/cancel" || method === "turn/interrupt") {
      if (running) {
        clearTimeout(running.timer);
        notify("turn/completed", { sessionId: running.session, turnId: running.turnId, terminal: "cancelled", viewCursor: "v:9" });
        running = null;
      }
      if (id !== undefined) rpc(id, { commandId: params?.commandId ?? null, status: "accepted" });
      return;
    }
    if (id === undefined || method === undefined) return;
    if (method === "initialize") return rpc(id, { experimentalApi: false, grantedCapabilities: [], serverInfo: { name: "wink-verify-stub", version: "0.0.0" }, sessionDurability: "durable" });
    if (method === "session/start") {
      model = params?.modelId ?? model;
      notify("session/started", { session: { sessionId, modelId: model }, viewCursor: "v:1" });
      return rpc(id, { session: { sessionId, modelId: model }, viewCursor: "v:1" });
    }
    if (method === "session/resume") return rpc(id, { session: { sessionId: params?.sessionId ?? sessionId, modelId: model }, history: { mode: "none" }, pendingRequests: [], viewCursor: "v:1" });
    if (method === "session/setModel") model = params?.model?.modelId ?? model;
    if (method === "model/list") return rpc(id, { models: [{ modelId: "muse-spark-1.3", displayLabel: "muse-spark-1.3" }] });
    if (method === "usage/read") return rpc(id, {});
    if (method !== "turn/start") return rpc(id, { commandId: params?.commandId ?? null, status: "accepted" });
    const session = params?.sessionId ?? sessionId;
    const turnId = randomUUID();
    rpc(id, { commandId: params?.commandId ?? null, disposition: "started", startedNewTurn: true, status: "accepted", turnId });
    const { text, delay } = reply(model, params?.input);
    notify("turn/started", { commandId: params?.commandId ?? null, sessionId: session, turnId, viewCursor: "v:2" });
    notify("item/started", { item: { id: "item-1", kind: "agentMessage" }, sessionId: session, viewCursor: "v:3" });
    const timer = setTimeout(() => {
      running = null;
      notify("item/delta", { itemId: "item-1", delta: text, sessionId: session, viewCursor: "v:4" });
      notify("item/completed", { item: { id: "item-1", kind: "agentMessage", text }, sessionId: session, viewCursor: "v:5" });
      notify("turn/completed", { sessionId: session, turnId, terminal: "completed", viewCursor: "v:6" });
    }, delay);
    running = { session, turnId, timer };
  });
}
