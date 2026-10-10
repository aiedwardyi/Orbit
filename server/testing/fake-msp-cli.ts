#!/usr/bin/env node
// Fake of `muse serve`'s MSP stdio surface, for driver tests of
// drivers/msp/runtime.ts. Speaks JSON-RPC 2.0 over stdin/stdout: answers
// initialize / session/start / session/resume / turn/start / turn/cancel /
// model/list, and streams item/delta + turn/completed for a scripted turn.
//
//   FAKE_MSP_MODE   happy (default) | hang | exit-early | fail-after-text
//                   | auth-failure (turn/completed failed authRequired)
//                   | approval (approval/requested, then waits for decide)
//                   | approval-request (approval/request with id: the client
//                     must answer the receipt before the card resolves)
//                   | approval-both (approval/request with id AND
//                     approval/requested for the same approval, like Muse
//                     1.3; a second decide is rejected as already resolved)
//                   | approval-staged (a three-stage shell approval: each
//                     decide is answered by approval/updated moving
//                     currentRequirementId on, like Muse 1.4; the turn
//                     completes only after the last stage)
//                   | approval-stale (approval/requested, then the decide is
//                     rejected as stale and the turn completes anyway)
//                   | approval-decide-fails (approval/requested, then the
//                     decide is rejected with the settlement failure a real
//                     host reports when the turn is already tearing down;
//                     the turn itself stays open)
//                   | approval-settle-fails (approval/requested; the first
//                     decide is taken but answered with that settlement
//                     failure, like Muse 1.4.2; a later decide is rejected
//                     as already resolved and the tool completes the turn)
//                   | resume-stale-cancel (before the turn/start ack, the
//                     resumed session replays turn/completed cancelled for
//                     the prior turn a killed host left open; then happy)
//                   | userinput (userInput/requested, then waits for answer)
//                   | resume-fails (session/resume rejects, like a
//                     --no-session-log host)
//                   | resume-poisoned (first turn/start on a foreign session
//                     is accepted then fails turn/completed with the
//                     incompatible-history poison; afterwards happy)
//                   | resume-poisoned-rpc (same trigger, but turn/start
//                     itself returns the poison as a JSON-RPC error;
//                     afterwards happy)
//                   | resume-encrypted-poisoned (switching to Contributor
//                     1.3 fails once with the provider's encrypted reasoning
//                     replay error; afterwards happy)
//                   | usage-auth (usage/read returns an auth error)
//                   | usage-transport (usage/read exits before a result)
//   FAKE_MSP_STATE  path to a JSON file holding per-session models across
//                   the one-process-per-turn spawns, so a switch sticks.
//   FAKE_MSP_DUMP   path to write {argv, env, cwd} as JSON, so a test can assert
//                   the spawn shape. session/start params land next to it in
//                   `<path>.config.json`; turn/start input in `<path>.turn.json`.
//   FAKE_MSP_COALESCE  1 = buffer every reply/notification produced while
//                   handling one inbound message and write them as a single
//                   stdout chunk, the framing a busy real host produces.
//   FAKE_MSP_RPC_DUMP  path to write the method sequence seen this run.
//   FAKE_MSP_USAGE     JSON result for usage/read.
//   FAKE_MSP_USAGE_CHANGED  JSON params for a usage/changed notification.
//   FAKE_MSP_INIT_DELAY_MS  hold the initialize result this long.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_MSP_MODE ?? "happy";

const argv = process.argv.slice(2);
const dumpEnv = Object.fromEntries(
  ["PATH", "HOME", "USERPROFILE", "SystemRoot", "META_API_KEY", "WSLENV", "FAKE_MSP_MODE"].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]] as const,
  ),
);
if (process.env.FAKE_MSP_DUMP) {
  writeFileSync(process.env.FAKE_MSP_DUMP, JSON.stringify({ argv, env: dumpEnv, cwd: process.cwd() }, null, 2));
}
if (argv.includes("--version")) {
  console.log("fake-msp 0.0.0");
  process.exit(0);
}

// A real host can land an RPC result and the notifications that follow it in
// one stdout chunk. FAKE_MSP_COALESCE forces that framing so a client is not
// allowed to depend on its own microtask ordering between the two.
const coalesce = process.env.FAKE_MSP_COALESCE === "1";
let outBuffer = "";
const out = (obj: unknown) => {
  const line = `${JSON.stringify(obj)}\n`;
  if (coalesce) outBuffer += line;
  else process.stdout.write(line);
};
const flushOut = () => {
  if (!outBuffer) return;
  const chunk = outBuffer;
  outBuffer = "";
  process.stdout.write(chunk);
};
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });
const rpcMethods: string[] = [];
const recordMethod = (method: string) => {
  rpcMethods.push(method);
  if (process.env.FAKE_MSP_RPC_DUMP) writeFileSync(process.env.FAKE_MSP_RPC_DUMP, JSON.stringify(rpcMethods));
};
const configCalls: unknown[] = [];
const recordConfig = (entry: unknown) => {
  configCalls.push(entry);
  if (process.env.FAKE_MSP_DUMP) {
    writeFileSync(`${process.env.FAKE_MSP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
  }
};

const SESSION_ID = "fake-msp-session";
const TURN_ID = "fake-msp-turn-1";
const ITEM_ID = "fake-msp-item-1";

// Session MCP, exactly as the real host gates it: servers live in the `config`
// extension (a top-level `mcpServers` is an unknown key the wire silently
// drops), the stdio arm of the closed union requires `transport`, and the
// whole feature needs the sessionMcp grant negotiated at initialize.
const GRANTABLE = ["userShell", "sessionMcp"];
let granted: string[] = [];
const sessionMcp = (msg: any) => msg.params?.config?.mcpServers ?? null;
function rejectSessionMcp(msg: any): boolean {
  const servers = sessionMcp(msg);
  if (!servers) return false;
  if (!granted.includes("sessionMcp")) {
    out({
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32010,
        message: "session MCP configuration requires the sessionMcp capability",
        data: { capability: "sessionMcp", kind: "capabilityRequired", retryable: false },
      },
    });
    return true;
  }
  for (const [name, server] of Object.entries(servers as Record<string, any>)) {
    if (server?.transport === "stdio" || server?.transport === "streamableHttp") continue;
    out({
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32602,
        message: `invalid ${msg.method} params: unknown variant for mcpServers.${name}, expected one of \`stdio\`, \`streamableHttp\``,
        data: { kind: "invalidParams" },
      },
    });
    return true;
  }
  return false;
}

// Durable per-session models, so a switch sticks across the one-process-per
// turn spawns. FAKE_MSP_STATE points at a JSON file shared by the run.
const STATE_PATH = process.env.FAKE_MSP_STATE;
function readModels(): Record<string, string> {
  if (!STATE_PATH) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function writeModels(models: Record<string, string>) {
  if (!STATE_PATH) return;
  writeFileSync(STATE_PATH, JSON.stringify(models));
}

const decideCalls: unknown[] = [];
const recordDecide = (entry: unknown) => {
  decideCalls.push(entry);
  if (process.env.FAKE_MSP_DUMP) {
    writeFileSync(`${process.env.FAKE_MSP_DUMP}.decide.json`, JSON.stringify(decideCalls, null, 2));
  }
};

const approvalParams = {
  approvalId: "fake-approval-1",
  availableChoices: [
    { choiceId: "allow-once", decision: "approved", label: "Allow once", scope: "once" },
    { choiceId: "deny", decision: "denied", label: "Deny", scope: "once" },
  ],
  currentRequirementId: { approvalId: "fake-approval-1", sourceIndex: 0 },
  itemId: ITEM_ID,
  sessionId: SESSION_ID,
  toolName: "shell",
  rawArgs: "echo hi",
  turnId: TURN_ID,
};

const userInputParams = {
  userInputId: "fake-ui-1",
  questions: [
    {
      id: "q1",
      header: "Pick",
      question: "Which one?",
      selection: { mode: "single" },
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
  toolName: "ask",
  toolCallId: "tc-1",
  turnId: TURN_ID,
  sessionId: SESSION_ID,
};

let awaitingDecide = false;
let decided = false;
let awaitingAnswer = false;
// Poison disarm: the poisoned modes fail exactly ONCE per process, on the
// first turn/start aimed at a foreign (resumed) session id.
let poisonSpent = false;
const POISON_MESSAGE =
  "provider-private history is incompatible with the active route: reasoning replay `rs_aaa:rs_bbb` has no provider mapping";
const ENCRYPTED_POISON_MESSAGE =
  "API 400: reasoning `encrypted_content` was not issued to this caller (invalid_request_error)";
const completeTurn = () =>
  out({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { sessionId: SESSION_ID, turnId: TURN_ID, terminal: "completed", viewCursor: "v:6" },
  });

const usageChanged = () => {
  const raw = process.env.FAKE_MSP_USAGE_CHANGED;
  if (!raw) return;
  try {
    out({ jsonrpc: "2.0", method: "usage/changed", params: JSON.parse(raw) });
  } catch {
    // malformed fixture: the runtime should ignore it
  }
};

function playHappyTurn(sessionId: string) {
  out({
    jsonrpc: "2.0",
    method: "turn/started",
    params: { commandId: "fake-cmd", sessionId, turnId: TURN_ID, viewCursor: "v:2" },
  });
  out({
    jsonrpc: "2.0",
    method: "item/started",
    params: { item: { id: ITEM_ID, kind: "agentMessage" }, sessionId, viewCursor: "v:3" },
  });
  out({
    jsonrpc: "2.0",
    method: "item/delta",
    params: { itemId: ITEM_ID, delta: "hello from fake msp", sessionId, viewCursor: "v:4" },
  });
  out({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { item: { id: ITEM_ID, kind: "agentMessage", text: "hello from fake msp" }, sessionId, viewCursor: "v:5" },
  });
  out({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { sessionId, turnId: TURN_ID, terminal: "completed", viewCursor: "v:6" },
  });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl: number;
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
    if (msg.method) handle(msg);
    else if (msg.id === 7001 && msg.result !== undefined) recordDecide({ method: "approval/receipt", result: msg.result });
    flushOut();
  }
});

function handle(msg: any) {
  recordMethod(msg.method);
  if (msg.id === undefined) {
    // notifications need no answer; turn/interrupt still counts as observed
    if (msg.method === "turn/interrupt") {
      out({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { sessionId: SESSION_ID, turnId: TURN_ID, terminal: "cancelled", viewCursor: "v:9" },
      });
    }
    return;
  }
  switch (msg.method) {
    case "initialize": {
      if (mode === "exit-early") {
        process.stderr.write("fake-msp: simulated crash before result\n");
        process.exit(3);
      }
      if (msg.params?.clientInfo === undefined) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "invalid initialize params: missing clientInfo" } });
        break;
      }
      const requested: unknown = msg.params?.capabilities?.requestedCapabilities;
      granted = (Array.isArray(requested) ? requested : []).filter((name) => GRANTABLE.includes(name as string));
      const reply = () =>
        result(msg.id, {
          experimentalApi: false,
          grantedCapabilities: granted,
          serverInfo: { name: "fake-msp", version: "0.0.0" },
          sessionDurability: "durable",
        });
      const delay = Number(process.env.FAKE_MSP_INIT_DELAY_MS ?? 0);
      if (delay > 0) setTimeout(reply, delay);
      else reply();
      break;
    }
    case "session/start": {
      if (rejectSessionMcp(msg)) break;
      recordConfig({
        method: "session/start",
        modelId: msg.params?.modelId ?? null,
        ...(sessionMcp(msg) ? { mcpServers: sessionMcp(msg) } : {}),
        // undefined drops out of the JSON dump: only check sessions send approvalMode
        approvalMode: msg.params?.approvalMode,
        workspaceRoot: msg.params?.approvalMode ? msg.params.workspaceRoot : undefined,
      });
      const modelId = typeof msg.params?.modelId === "string" ? msg.params.modelId : "fake-msp-default";
      const models = readModels();
      models[SESSION_ID] = modelId;
      writeModels(models);
      // The real host emits the notification before the result.
      out({ jsonrpc: "2.0", method: "session/started", params: { session: { sessionId: SESSION_ID, modelId }, viewCursor: "v:1" } });
      result(msg.id, { session: { sessionId: SESSION_ID, modelId }, viewCursor: "v:1" });
      break;
    }
    case "session/resume": {
      if (rejectSessionMcp(msg)) break;
      recordConfig({ method: "session/resume", params: msg.params ?? null });
      if (mode === "resume-fails") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
        break;
      }
      const resumedId = msg.params?.sessionId ?? SESSION_ID;
      result(msg.id, {
        session: { sessionId: resumedId, modelId: readModels()[resumedId] ?? "fake-msp-resumed" },
        history: { mode: "none" },
        pendingRequests: [],
        viewCursor: "v:1",
      });
      break;
    }
    case "turn/start": {
      if (process.env.FAKE_MSP_DUMP) {
        writeFileSync(`${process.env.FAKE_MSP_DUMP}.turn.json`, JSON.stringify(msg.params?.input ?? null, null, 2));
        writeFileSync(
          `${process.env.FAKE_MSP_DUMP}.turn-params.json`,
          JSON.stringify(msg.params ?? null, null, 2),
        );
      }
      const isPoisonedResume =
        ((mode === "resume-poisoned" || mode === "resume-poisoned-rpc") &&
          typeof msg.params?.sessionId === "string" &&
          msg.params.sessionId !== SESSION_ID) ||
        (mode === "resume-encrypted-poisoned" &&
          typeof msg.params?.sessionId === "string" &&
          readModels()[msg.params.sessionId] === "muse-spark-1.3-contributor");
      if (!poisonSpent && isPoisonedResume) {
        poisonSpent = true;
        const poisonMessage = mode === "resume-encrypted-poisoned" ? ENCRYPTED_POISON_MESSAGE : POISON_MESSAGE;
        if (mode === "resume-poisoned-rpc") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: poisonMessage } });
          break;
        }
        result(msg.id, {
          commandId: msg.params?.commandId ?? null,
          disposition: "started",
          startedNewTurn: true,
          status: "accepted",
          turnId: TURN_ID,
        });
        out({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            sessionId: msg.params.sessionId,
            turnId: TURN_ID,
            terminal: "failed",
            error: { message: poisonMessage },
            viewCursor: "v:5",
          },
        });
        break;
      }
      if (mode === "resume-stale-cancel") {
        out({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { sessionId: msg.params?.sessionId, turnId: "fake-msp-turn-0", terminal: "cancelled", viewCursor: "v:2" },
        });
      }
      result(msg.id, {
        commandId: msg.params?.commandId ?? null,
        disposition: "started",
        startedNewTurn: true,
        status: "accepted",
        turnId: TURN_ID,
      });
      if (mode === "hang") return;
      usageChanged();
      if (mode === "auth-failure") {
        out({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            sessionId: SESSION_ID,
            turnId: TURN_ID,
            terminal: "failed",
            error: { kind: "authRequired", message: "login expired", retryable: false },
            viewCursor: "v:5",
          },
        });
        return;
      }
      if (mode === "approval" || mode === "approval-request" || mode === "approval-both" || mode === "approval-staged" || mode === "approval-stale" || mode === "approval-decide-fails" || mode === "approval-settle-fails") {
        if (mode === "approval-request") {
          out({ jsonrpc: "2.0", id: 7001, method: "approval/request", params: approvalParams });
        } else if (mode === "approval-both") {
          out({ jsonrpc: "2.0", id: 7001, method: "approval/request", params: approvalParams });
          out({ jsonrpc: "2.0", method: "approval/requested", params: approvalParams });
        } else {
          out({ jsonrpc: "2.0", method: "approval/requested", params: approvalParams });
        }
        awaitingDecide = true;
        return;
      }
      if (mode === "userinput") {
        out({ jsonrpc: "2.0", method: "userInput/requested", params: userInputParams });
        awaitingAnswer = true;
        return;
      }
      if (mode === "fail-after-text") {
        out({
          jsonrpc: "2.0",
          method: "item/delta",
          params: { itemId: ITEM_ID, delta: "half a report, then a crash", sessionId: SESSION_ID, viewCursor: "v:4" },
        });
        out({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            sessionId: SESSION_ID,
            turnId: TURN_ID,
            terminal: "failed",
            error: { message: "fake msp: turn failed after streaming" },
            viewCursor: "v:5",
          },
        });
        return;
      }
      playHappyTurn(SESSION_ID);
      break;
    }
    case "turn/cancel":
    case "turn/interrupt": {
      out({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { sessionId: SESSION_ID, turnId: TURN_ID, terminal: "cancelled", viewCursor: "v:9" },
      });
      result(msg.id, { commandId: msg.params?.commandId ?? null, status: "accepted" });
      break;
    }
    case "model/list": {
      result(msg.id, {
        models: [
          { modelId: "muse-spark-1.3", displayLabel: "muse-spark-1.3" },
          { modelId: "muse-spark-1.3-contributor", displayLabel: "muse-spark-1.3-contributor" },
        ],
      });
      break;
    }
    case "usage/read": {
      if (mode === "usage-auth") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: 401, message: "login expired" } });
        break;
      }
      if (mode === "usage-transport") {
        process.stderr.write("fake-msp: simulated usage transport failure\n");
        process.exit(7);
      }
      try {
        result(msg.id, process.env.FAKE_MSP_USAGE ? JSON.parse(process.env.FAKE_MSP_USAGE) : {});
      } catch {
        result(msg.id, {});
      }
      break;
    }
    case "session/setReasoningEffort": {
      recordConfig({ method: msg.method, params: msg.params ?? null });
      result(msg.id, { commandId: msg.params?.commandId ?? null, status: "accepted" });
      break;
    }
    case "session/setModel": {
      recordConfig({ method: "session/setModel", params: msg.params ?? null });
      const target = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : SESSION_ID;
      const next = msg.params?.model?.modelId;
      if (typeof next === "string") {
        const models = readModels();
        models[target] = next;
        writeModels(models);
        out({
          jsonrpc: "2.0",
          method: "session/modelChanged",
          params: { session: { sessionId: target, modelId: next }, viewCursor: "v:7" },
        });
      }
      result(msg.id, { commandId: msg.params?.commandId ?? null, status: "accepted" });
      break;
    }
    case "approval/decide": {
      recordDecide({ method: "approval/decide", params: msg.params ?? null });
      if (mode === "approval-decide-fails") {
        // A real host reports this when the turn is already tearing down:
        // the decision is refused at settlement and the turn stays open.
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32000,
            message:
              "approval decide settlement failed: approval ledger durability fence: background task failed: retained acknowledgement fence left records unflushed (failed=0)",
          },
        });
        break;
      }
      if (mode === "approval-settle-fails" && !decided) {
        decided = true;
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32000,
            message:
              "approval decide settlement failed: approval ledger durability fence: background task failed: retained acknowledgement fence left records unflushed (failed=0, pending=2)",
          },
        });
        setTimeout(completeTurn, 50);
        break;
      }
      if (mode === "approval-staged") {
        const stage = msg.params?.requirementId?.sourceIndex ?? 0;
        if (stage < 2) {
          out({
            jsonrpc: "2.0",
            method: "approval/updated",
            params: {
              ...approvalParams,
              change: { kind: "stageResolved", choiceId: msg.params?.choiceId, requirementId: msg.params?.requirementId },
              currentRequirementId: { approvalId: approvalParams.approvalId, sourceIndex: stage + 1 },
            },
          });
          result(msg.id, { commandId: msg.params?.commandId ?? null, status: "accepted" });
        } else {
          result(msg.id, { commandId: msg.params?.commandId ?? null, status: "accepted" });
          completeTurn();
        }
        break;
      }
      if (mode === "approval-stale") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: `approval ${msg.params?.approvalId} requirement is stale` },
        });
        completeTurn();
        break;
      }
      if (decided) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: `approval ${msg.params?.approvalId} is already resolved` },
        });
        break;
      }
      decided = true;
      result(msg.id, { commandId: msg.params?.commandId ?? null, status: "accepted" });
      if (awaitingDecide) {
        awaitingDecide = false;
        completeTurn();
      }
      break;
    }
    case "userInput/answer":
    case "userInput/cancel": {
      recordDecide({ method: msg.method, params: msg.params ?? null });
      result(msg.id, { commandId: msg.params?.commandId ?? null, status: "accepted" });
      if (awaitingAnswer) {
        awaitingAnswer = false;
        completeTurn();
      }
      break;
    }
    default:
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
