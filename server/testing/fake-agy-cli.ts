#!/usr/bin/env node
// Fake of the Antigravity `agy` CLI's print-mode stdio surface, for driver
// tests of drivers/antigravity.ts. On `--version` it prints a version; on a
// stream-json print-mode invocation (`--input-format stream-json
// --output-format stream-json`) it reads one NDJSON user event from stdin
// (agy 1.1.15+ / verified 1.2.4: {"event":"user","message":{...}}), then
// emits a canned NDJSON turn: init → tool step (ACTIVE then DONE) →
// agent_response step with usage → result with status SUCCESS.
// Deterministic, no network.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
if (process.env.FAKE_AGY_READY_FILE) {
  writeFileSync(process.env.FAKE_AGY_READY_FILE, "ready");
}
if (argv.includes("--version")) {
  if (process.env.FAKE_AGY_DUMP) {
    writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: process.env }, null, 2));
  }
  console.log("1.1.12");
  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function promptFromStreamJson(raw: string): string | undefined {
  const line = raw.split(/\r?\n/).find((row) => row.trim());
  if (!line) return undefined;
  let msg: { event?: unknown; message?: { content?: unknown } };
  try {
    msg = JSON.parse(line) as { event?: unknown; message?: { content?: unknown } };
  } catch {
    process.stderr.write("error: stream input message is not valid JSON\n");
    process.exit(1);
  }
  if (msg.event !== "user") {
    process.stderr.write('error: stream input message is missing the "event" field\n');
    process.exit(1);
  }
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (content == null) return undefined;
  return JSON.stringify(content);
}

const inputFormatIdx = argv.indexOf("--input-format");
const inputFormat = inputFormatIdx !== -1 ? argv[inputFormatIdx + 1] : undefined;
const printIdx = argv.includes("--print") ? argv.indexOf("--print") : argv.indexOf("-p");
let stdinRaw = "";
let prompt: string | undefined;
if (inputFormat === "stream-json") {
  stdinRaw = await readStdin();
  prompt = promptFromStreamJson(stdinRaw);
} else if (printIdx !== -1) {
  prompt = argv[printIdx + 1];
}

if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(
    process.env.FAKE_AGY_DUMP,
    JSON.stringify(
      {
        argv,
        env: process.env,
        // Lengths only — tests that need the prompt body read `prompt` explicitly.
        stdinBytes: Buffer.byteLength(stdinRaw),
        promptChars: prompt?.length ?? 0,
        prompt,
      },
      null,
      2,
    ),
  );
}

const delayMs = Number(process.env.FAKE_AGY_DELAY_MS ?? 0);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
if (process.env.FAKE_AGY_MCP_DUMP) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let config = "null";
  try {
    config = readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8");
  } catch {}
  writeFileSync(process.env.FAKE_AGY_MCP_DUMP, config);
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const CONV = "conv-fake-123";
const systemNotice = "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>internal notice</SYSTEM_MESSAGE>";
const cancelledTool = process.env.FAKE_AGY_CANCELLED_TOOL === "1";

// stream-json / --print with no prompt yields no turn (mirrors real CLI).
if (!prompt) process.exit(0);
if (process.env.FAKE_AGY_RESUME_FAIL && argv.includes("--conversation")) {
  const diagnostic = process.env.FAKE_AGY_RESUME_FAIL === "multiline"
    ? "agy: conversation 8f2c\nnot found\n"
    : "agy: conversation not found\n";
  await new Promise<never>(() => {
    process.stderr.write(diagnostic, () => process.exit(4));
  });
}

out({ event: "init", conversation_id: CONV, init: { cwd: process.cwd(), tools: ["run_command", "write_to_file"], permission_mode: "accept-edits" } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: {} } } });
out({
  event: "step_update",
  conversation_id: CONV,
  step_update: {
    conversation_id: CONV,
    step_index: 0,
    state: cancelledTool ? "ERROR" : "DONE",
    step_type: "tool",
    tool_name: "write_to_file",
    tool_info: cancelledTool
      ? { name: "write_to_file", parameters: {}, output: "context canceled" }
      : { name: "write_to_file", parameters: {} },
  },
});
if (process.env.FAKE_AGY_SYSTEM_NOTICE === "1") {
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 2, state: "DONE", step_type: "agent_response", text_delta: systemNotice } });
}
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
out({
  event: "result",
  conversation_id: CONV,
  result: {
    conversation_id: CONV,
    status: "SUCCESS",
    response: process.env.FAKE_AGY_SYSTEM_NOTICE === "1"
      ? systemNotice
      : process.env.FAKE_AGY_NO_FINAL === "1"
        ? ""
        : cancelledTool
          ? "final text after cancellation"
          : "done from fake agy",
    duration_seconds: 1,
    num_turns: 1,
    usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 },
  },
});
const postResultDelayMs = Number(process.env.FAKE_AGY_POST_RESULT_DELAY_MS ?? 0);
if (Number.isFinite(postResultDelayMs) && postResultDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
}
process.exit(0);
