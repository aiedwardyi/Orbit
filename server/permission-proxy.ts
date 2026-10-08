// permission-proxy — the MCP stdio server the claude CLI spawns for
// --permission-prompt-tool (ported from agentcal's runPermissionProxy;
// dedicated entry file, so there is no argv-dispatch fork-bomb hazard).
// Forwards each ask over a unix socket to the broker living in the
// OpenMausBot server and waits for the human's answer.
//
//   approve   — the CLI calls this for any tool use its permission mode
//               would deny; the answer is the --permission-prompt-tool
//               JSON contract ({behavior:"allow"|"deny", …}).
//
// Questions are not asked here: the agents proxy's ask_user pins one for the
// user without pausing the bot.
//
// stdout is the MCP channel — never console.log here.
import { connect } from "node:net";
import { randomUUID } from "node:crypto";

const socketPath = process.argv[2] ?? "";

const waiting = new Map<string, (msg: any) => void>();
const conn = connect(socketPath);

interface AllowPermissionResult {
  behavior: "allow";
  updatedInput: object;
  updatedPermissions?: object[];
}
const dead = () => {
  for (const resolve of waiting.values()) {
    resolve({ behavior: "deny", message: "Wink: permission broker unavailable - skip this action" });
  }
  waiting.clear();
};
conn.on("error", dead);
conn.on("close", dead);

let connBuf = "";
conn.on("data", (chunk) => {
  connBuf += chunk;
  let nl;
  while ((nl = connBuf.indexOf("\n")) !== -1) {
    const line = connBuf.slice(0, nl);
    connBuf = connBuf.slice(nl + 1);
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.t === "answer") {
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  }
});

const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

const TOOLS = [
  {
    name: "approve",
    description: "Ask the Wink user whether a tool use is allowed",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      required: ["tool_name", "input"],
    },
  },
];

async function handle(msg: any) {
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-permissions", version: "1" },
      },
    });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name !== "approve") {
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    const askId = randomUUID();
    // the CLI may include its own suggested permission rules; on allow we
    // hand them straight back as updatedPermissions so claude stops asking
    // at its own layer — no invented rule syntax (agentcal)
    const suggestions = Array.isArray(args.permission_suggestions)
      ? args.permission_suggestions
      : Array.isArray(args.suggestions)
        ? args.suggestions
        : null;
    const answer: any = await new Promise((resolve) => {
      waiting.set(askId, resolve);
      if (conn.destroyed) return dead();
      const ask = { t: "ask", id: askId, tool: args.tool_name, input: args.input };
      try {
        conn.write(JSON.stringify(ask) + "\n");
      } catch {
        dead();
      }
    });
    let text: string;
    if (answer.behavior === "allow") {
      const result: AllowPermissionResult = { behavior: "allow", updatedInput: args.input ?? {} };
      if (answer.always && suggestions) result.updatedPermissions = suggestions;
      text = JSON.stringify(result);
    } else {
      text = JSON.stringify({ behavior: "deny", message: answer.message || "Denied from Wink" });
    }
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

let inBuf = "";
process.stdin.on("data", (chunk) => {
  inBuf += chunk;
  let nl;
  while ((nl = inBuf.indexOf("\n")) !== -1) {
    const line = inBuf.slice(0, nl);
    inBuf = inBuf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore malformed lines */
    }
  }
});
process.stdin.on("end", () => process.exit(0));
