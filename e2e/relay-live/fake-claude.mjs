import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const REPLY = "pong from the fake engine";
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const countPrompt = () => fetch(`http://127.0.0.1:${process.env.RELAY_E2E_FAKE_PORT}/prompt`, { method: "POST", signal: AbortSignal.timeout(5_000) });

if (argv.includes("--version")) {
  console.log("2.1.232 (Relay E2E fake)");
} else if (argv[0] === "auth" && argv[1] === "status") {
  out({ loggedIn: true });
} else if (!argv.includes("-p")) {
  out({});
} else if (!argv.includes("stream-json")) {
  for await (const chunk of process.stdin) {}
  await countPrompt();
  console.log(REPLY);
} else {
  const sessionId = randomUUID();
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      out({});
      continue;
    }
    if (message.type === "user") {
      await countPrompt();
      out({ type: "system", subtype: "init", session_id: sessionId });
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: REPLY }] } });
      out({ type: "result", subtype: "success", is_error: false, result: REPLY, stop_reason: "end_turn", session_id: sessionId, total_cost_usd: 0 });
    } else if (message.request_id !== undefined) {
      out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    } else if (message.id !== undefined) {
      out({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
}
