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
//                   | approval-decide-fails (approval/requested, then the
//                     decide is rejected with the settlement failure a real
//                     host reports when the turn is already tearing down;
//                     the turn itself stays open)
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
//   FAKE_MSP_DUMP   path to write {argv, env} as JSON, so a test can assert
//                   the spawn shape. session/start params land next to it in
//                   `<path>.config.json`; turn/start input in `<path>.turn.json`.
//   FAKE_MSP_RPC_DUMP  path to write the method sequence seen this run.
//   FAKE_MSP_USAGE     JSON result for usage/read.
//   FAKE_MSP_USAGE_CHANGED  JSON params for a usage/changed notification.
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
  writeFileSync(process.env.FAKE_MSP_DUMP, JSON.stringify({ argv, env: dumpEnv }, null, 2));
}
if (argv.includes("--version")) {
  console.log("fake-msp 0.0.0");
  process.exit(0);
}

const out = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
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
      result(msg.id, {
        experimentalApi: false,
        grantedCapabilities: [],
        serverInfo: { name: "fake-msp", version: "0.0.0" },
        sessionDurability: "durable",
      });
      break;
    }
    case "session/start": {
      recordConfig({ method: "session/start", modelId: msg.params?.modelId ?? null });
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
      if (mode === "approval" || mode === "approval-request" || mode === "approval-decide-fails") {
        if (mode === "approval-request") {
          out({ jsonrpc: "2.0", id: 7001, method: "approval/request", params: approvalParams });
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
