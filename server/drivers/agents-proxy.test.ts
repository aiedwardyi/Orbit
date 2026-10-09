// Contract test for the agent-to-agent comms MCP proxy (agents-proxy.ts):
// spawn it exactly the way a driver's mcpServers entry does (process.execPath
// + entry file + env) against a scripted stub of the harness's /api/internal
// endpoints, and drive the MCP stdio surface end to end. No shebang, no
// shell — plain node child, so this runs on every OS like index.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const TOKEN = "test-comms-token";

// scripted harness stub
let stub: Server;
let stubPort = 0;
let lastAuth: string | undefined;
let lastAskBody: any = null;
let askResponse: unknown = { botName: "Helper", text: "hi from helper" };
let lastDelegateBody: any = null;
let lastDelegationUrl: string | null = null;
let delegationStatusResponse: unknown = { status: "done", toBotName: "Helper", result: "All done." };
let delegateResponse: unknown = { queued: true, message: "Delegation queued." };
let lastCreateBody: any = null;
let lastCreateChannelBody: any = null;
let lastCredentialBody: any = null;
let lastShowImageBody: any = null;
let lastAskUserBody: any = null;
let lastGenerateImageBody: any = null;
let lastCallApiBody: any = null;
let lastRoutineQuery = "";
let routinesResponse: unknown = {
  now: "2026-08-28T10:30:00.000Z",
  timeZone: "Asia/Kolkata",
  routines: [
    {
      id: "routine-1",
      name: "Morning brief",
      enabled: true,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      nextRunAt: "2026-08-31T03:30:00.000Z",
    },
  ],
};
let lastRoutineRequestBody: any = null;
interface TaskStateRequestBody {
  pause_automatic_wakes?: boolean;
  fromBotId: string;
  fromThreadId: string;
  goal?: string;
  plan?: Array<{ step: string; status: string }>;
  completed_note?: string;
  next_action?: string;
  blockers?: Array<{ kind: string; note: string }>;
  artifacts?: Array<{ ref: string; label: string }>;
}
let lastTaskStateBody: TaskStateRequestBody | null = null;
let botWakesPaused = false;

let child: ChildProcess;
const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}
const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

beforeAll(async () => {
  stub = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/agents")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          bots: [{ id: "bot-helper", name: "Helper", section: "Work", model: "fake-model", busy: false }],
        }),
      );
    }
    if (req.method === "POST" && req.url === "/api/internal/ask-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAskBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(askResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/delegate-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastDelegateBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(delegateResponse));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/delegations/")) {
      lastDelegationUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(delegationStatusResponse));
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/create-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCreateBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "bot-designer", name: "Pixel", section: "Work" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/create-channel") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCreateChannelBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "channel-two-bot",
            name: lastCreateChannelBody.name,
            memberIds: ["bot-asker", ...(lastCreateChannelBody.memberIds ?? [])],
            section: lastCreateChannelBody.section ?? "Work",
            threadId: "thread-channel-two-bot",
          }),
        );
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/request-credential") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCredentialBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        if (lastCredentialBody.credentialId === "custom") {
          return res.end(JSON.stringify({ messageId: "msg-custom", label: "Acme" }));
        }
        if (lastCredentialBody.credentialId === "openaiImageApiKey") {
          return res.end(JSON.stringify({ alreadyConfigured: true, label: "OpenAI API key" }));
        }
        res.end(JSON.stringify({ messageId: "msg-key", label: "Gemini API key" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/ask-user") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAskUserBody = JSON.parse(data);
        if (lastAskUserBody.question === "refuse me") {
          res.writeHead(403, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "source thread does not belong to sender" }));
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ messageId: "msg-ask" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/show-image") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastShowImageBody = JSON.parse(data);
        if (lastShowImageBody.path.endsWith("fake.png")) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "not a PNG, JPEG, GIF, or WebP image" }));
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ messageId: "msg-img", url: "/api/attachments/abc.png" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/generate-image") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastGenerateImageBody = JSON.parse(data);
        if (lastGenerateImageBody.prompt === "no key") {
          res.writeHead(409, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            error: "No image key saved. Call request_credential with openaiImageApiKey, end the turn, then retry generate_image.",
          }));
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          path: "C:\proj\generated-images\logo-ab12cd34.png",
          ...(lastGenerateImageBody.show ? { url: "/api/attachments/gen.png" } : {}),
        }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/call-api") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCallApiBody = JSON.parse(data);
        if (lastCallApiBody.credentialId === "geminiApiKey") {
          res.writeHead(409, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            error: "No Gemini API key saved. Call request_credential with geminiApiKey, end the turn, then retry call_api.",
          }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (lastCallApiBody.credentialId === "ttsKey") {
          return res.end(JSON.stringify({ status: 200, path: "/proj/api-files/response-ab12cd34.mp3", contentType: "audio/mpeg" }));
        }
        res.end(JSON.stringify({ status: 401, text: "HTTP 401\nbad key [key]" }));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/routines?")) {
      lastRoutineQuery = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(routinesResponse));
    }
    if (req.method === "POST" && req.url === "/api/internal/routine-requests") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastRoutineRequestBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ requestId: "routine-request-1", summary: "Weekdays at 09:00 (Asia/Kolkata)" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/task-state") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body: TaskStateRequestBody = JSON.parse(data);
        lastTaskStateBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, nextAction: body.next_action, automaticWakesPaused: botWakesPaused || body.pause_automatic_wakes === true }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown" }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubPort = (stub.address() as { port: number }).port;

  child = spawn(process.execPath, [PROXY], {
    windowsHide: true,
    env: {
      ...process.env,
      OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
      OMB_BOT_ID: "bot-asker",
      OMB_THREAD_ID: "thread-asker-routine",
      OMB_COMMS_TOKEN: TOKEN,
      OMB_TURN_DEPTH: "0",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  child.stdout!.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub.close(() => r()));
});

describe("agents-proxy MCP surface", () => {
  it("answers the MCP handshake and lists the tool surface", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toContain("agents");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_bots",
      "update_task_state",
      "ask_bot",
      "delegate_bot",
      "check_delegation",
      "wait_delegation",
      "create_bot",
      "create_channel",
      "react",
      "ask_user",
      "show_image",
      "generate_image",
      "call_api",
      "request_credential",
      "list_routines",
      "propose_routine",
      "propose_routine_action",
    ]);
  });

  it("asks the user through the harness and returns at once without waiting", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "ask_user");
    expect(tool.description).toContain("It does not pause you");
    expect(tool.description).toContain("including yes/no and permission questions");
    expect(tool.inputSchema.required).toEqual(["question"]);
    const res = await callTool("ask_user", { question: " Ship to prod or staging? ", choices: ["Prod", 3, "Staging"] });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe("Asked. Their answer will arrive as a new message.");
    expect(lastAskUserBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      question: "Ship to prod or staging?",
      choices: ["Prod", 3, "Staging"],
    });
  });

  it("surfaces ask_user rejections and an empty question as tool errors", async () => {
    const refused = await callTool("ask_user", { question: "refuse me" });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("source thread does not belong to sender");
    const empty = await callTool("ask_user", { question: "  " });
    expect(empty.result.isError).toBe(true);
    expect(empty.result.content[0].text).toContain("needs a question");
  });

  it("publishes a local image into the caller's thread and returns its URL", async () => {
    const res = await callTool("show_image", { path: "C:\\out\\mockup.png", caption: " Home screen " });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("/api/attachments/abc.png");
    expect(lastShowImageBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      path: "C:\\out\\mockup.png",
      caption: "Home screen",
    });
  });

  it("surfaces show_image rejections as tool errors", async () => {
    const fake = await callTool("show_image", { path: "C:\\out\\fake.png" });
    expect(fake.result.isError).toBe(true);
    expect(fake.result.content[0].text).toContain("not a PNG, JPEG, GIF, or WebP image");
    const empty = await callTool("show_image", { path: " " });
    expect(empty.result.isError).toBe(true);
    expect(empty.result.content[0].text).toContain("needs a path");
  });

  it("generates an image through the harness and returns its path and URL", async () => {
    const res = await callTool("generate_image", { prompt: " a teal fox logo ", filename: "logo", size: "1536x1024" });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("C:\proj\generated-images\logo-ab12cd34.png");
    expect(res.result.content[0].text).toContain("/api/attachments/gen.png");
    expect(lastGenerateImageBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      prompt: "a teal fox logo",
      show: true,
      filename: "logo",
      size: "1536x1024",
    });
    const hidden = await callTool("generate_image", { prompt: "icon", show: false });
    expect(hidden.result.content[0].text).not.toContain("/api/attachments/");
    expect(lastGenerateImageBody.show).toBe(false);
  });

  it("tells the bot how to get an image key when none is saved", async () => {
    const res = await callTool("generate_image", { prompt: "no key" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Call request_credential with openaiImageApiKey");
    const empty = await callTool("generate_image", { prompt: " " });
    expect(empty.result.content[0].text).toContain("needs a prompt");
  });

  it("calls an API through the harness key broker", async () => {
    const res = await callTool("call_api", { credential_id: "xaiApiKey", method: "post", url: "https://api.x.ai/v1/chat", body: { q: 1 } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("HTTP 401\nbad key [key]");
    expect(lastCallApiBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      credentialId: "xaiApiKey",
      method: "POST",
      url: "https://api.x.ai/v1/chat",
      body: { q: 1 },
    });
    const audio = await callTool("call_api", { credential_id: "ttsKey", method: "GET", url: "https://api.elevenlabs.io/v1/x" });
    expect(audio.result.isError).toBe(false);
    expect(audio.result.content[0].text).toContain("/proj/api-files/response-ab12cd34.mp3");
    const missing = await callTool("call_api", { credential_id: "geminiApiKey", method: "GET", url: "https://generativelanguage.googleapis.com/v1beta/models" });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toContain("Call request_credential with geminiApiKey");
  });

  it("points a configured image key at generate_image", async () => {
    const res = await callTool("request_credential", { credential_id: "openaiImageApiKey" });
    expect(res.result.content[0].text).toBe("OpenAI API key is already configured. Use generate_image.");
  });

  it("forwards durable task progress with source ownership", async () => {
    lastTaskStateBody = null;
    const res = await callTool("update_task_state", {
      goal: "Publish the weekly brief",
      plan: [{ step: "Verify citations", status: "active" }],
      completed_note: "Drafted five sections",
      next_action: "Verify citations",
      blockers: [],
      artifacts: [{ ref: "brief.md", label: "Weekly brief" }],
    });

    expect(lastTaskStateBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      goal: "Publish the weekly brief",
      plan: [{ step: "Verify citations", status: "active" }],
      completed_note: "Drafted five sections",
      next_action: "Verify citations",
      blockers: [],
      artifacts: [{ ref: "brief.md", label: "Weekly brief" }],
    });
    expect(res.result.content[0].text).toContain("Next action: Verify citations");
  });

  it("forwards an explicit wake pause without claiming the current turn ended", async () => {
    lastTaskStateBody = null;
    const res = await callTool("update_task_state", { pause_automatic_wakes: true });
    expect(lastTaskStateBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", pause_automatic_wakes: true });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("End this turn");
    expect(res.result.content[0].text).not.toContain("You can change models now");
  });

  it("keeps later turns running on a paused bot", async () => {
    botWakesPaused = true;
    const res = await callTool("update_task_state", { next_action: "Verify citations" });
    botWakesPaused = false;
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("Next action: Verify citations");
    expect(res.result.content[0].text).not.toContain("End this turn");
  });

  it("does not let a bot clear a user wake pause", async () => {
    lastTaskStateBody = null;
    const res = await callTool("update_task_state", { pause_automatic_wakes: false });
    expect(res.result.isError).toBe(true);
    expect(lastTaskStateBody).toBeNull();
  });

  it("rejects blank task fields before calling the harness", async () => {
    const list = await rpc("tools/list");
    const update = list.result.tools.find((tool: { name: string }) => tool.name === "update_task_state");
    expect(update.inputSchema.properties.goal).toMatchObject({ minLength: 1, pattern: "\\S" });
    expect(update.inputSchema.properties.plan.items.properties.step).toMatchObject({ minLength: 1, pattern: "\\S" });

    lastTaskStateBody = null;
    const res = await callTool("update_task_state", {
      plan: [{ step: "   ", status: "active" }],
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("cannot be blank");
    expect(lastTaskStateBody).toBeNull();
  });

  it("rejects unknown and misshapen task fields with the allowed list", async () => {
    lastTaskStateBody = null;
    const unknown = await callTool("update_task_state", { goal: "Ship", notes: "x", done: true });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0].text).toContain("unknown field notes, done");
    expect(unknown.result.content[0].text).toContain("allowed: goal, plan, completed_note, next_action, blockers, artifacts");

    const empty = await callTool("update_task_state", {});
    expect(empty.result.content[0].text).toContain("allowed: goal, plan");

    const plan = await callTool("update_task_state", { plan: "step one, step two" });
    expect(plan.result.isError).toBe(true);
    expect(plan.result.content[0].text).toContain("plan must be an array");
    expect(lastTaskStateBody).toBeNull();
  });

  it("publishes a flat routine schedule schema that survives provider conversion", async () => {
    const list = await rpc("tools/list");
    const create = list.result.tools.find((t: { name: string }) => t.name === "propose_routine");
    expect(create.inputSchema.required).toEqual(["name", "instructions", "schedule"]);
    const schedule = create.inputSchema.properties.schedule;
    // No composition keywords anywhere in the tool surface: several agent
    // CLIs flatten or drop oneOf/anyOf/const when converting MCP tools for
    // their model API, and a model that never saw the branches guesses
    // shapes forever (the 0.1.38 field failure).
    expect(JSON.stringify(create.inputSchema)).not.toMatch(/"oneOf"|"anyOf"|"allOf"|"const"/);
    expect(schedule.type).toBe("object");
    expect(schedule.required).toEqual(["type"]);
    expect(schedule.properties.type.enum).toEqual(["once", "weekly", "daily"]);
    expect(schedule.properties.weekdays.items.enum).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ]);
    expect(create.description).toContain("does NOT enable");
  });

  it("list_bots renders the roster and authenticates with the shared token", async () => {
    const res = await callTool("list_bots", {});
    const text = res.result.content[0].text;
    expect(text).toContain("Helper");
    expect(text).toContain("bot-helper");
    expect(text).toContain("section: Work");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("ask_bot forwards sender + depth and returns the reply", async () => {
    askResponse = { botName: "Helper", text: "hi from helper" };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toContain("Helper replied:");
    expect(res.result.content[0].text).toContain("hi from helper");
    expect(lastAskBody).toMatchObject({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      toBotId: "bot-helper",
      message: "ping",
      depth: 0,
    });
  });

  it("renders a busy peer as a clean answer, not an error", async () => {
    askResponse = { busy: true };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toContain("busy");
    expect(res.result.isError).toBeFalsy();
  });

  it("surfaces the harness's depth refusal as a tool error", async () => {
    askResponse = { error: "message chains are limited to one hop" };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("one hop");
  });

  it("reports a per-turn ask budget as a limit, not as an unreachable peer", async () => {
    askResponse = { limit: "this turn has already used its 4 teammate messages — use delegate_bot for the rest." };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toContain("already used its 4 teammate messages");
    expect(res.result.content[0].text).not.toContain("Couldn't reach that bot");
  });

  it("forwards the source thread when queueing a delegation", async () => {
    delegateResponse = { queued: true, message: "Delegation queued." };
    const res = await callTool("delegate_bot", {
      bot_id: "bot-helper",
      message: "take this",
      reason: "follow-up",
    });
    expect(res.result.content[0].text).toContain("Delegation queued");
    expect(lastDelegateBody).toMatchObject({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      toBotId: "bot-helper",
      message: "take this",
      reason: "follow-up",
      depth: 0,
    });
  });

  it("returns queue refusal guidance to the agent as a tool error", async () => {
    delegateResponse = { error: "delegation chains are limited to one hop — do this one yourself" };
    const res = await callTool("delegate_bot", { bot_id: "bot-helper", message: "take this" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("do this one yourself");
  });

  it("lets a Chief create a bounded specialist through the harness", async () => {
    const res = await callTool("create_bot", {
      name: "Pixel",
      role: "Product designer",
      instructions: "Design and review the user experience.",
    });
    expect(res.result.content[0].text).toContain("Created @Pixel in Work");
    expect(res.result.content[0].text).toContain("create_channel");
    expect(lastCreateBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      name: "Pixel",
      role: "Product designer",
      instructions: "Design and review the user experience.",
    });
  });

  it("create_channel tells the model to call the tool instead of scanning localhost", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "create_channel");
    expect(tool).toBeTruthy();
    expect(tool.description).toMatch(/two-bot channel|shared channel|shared room/i);
    expect(tool.description).toMatch(/Never scan/i);
    expect(tool.description).toContain("ask_bot");
    expect(tool.inputSchema.required).toEqual(["name", "member_ids"]);
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"oneOf"|"anyOf"|"allOf"|"const"/);
  });

  it("forwards a two-bot channel to the harness and points the user at the room", async () => {
    lastCreateChannelBody = null;
    const res = await callTool("create_channel", {
      name: "Skye & Nova",
      member_ids: ["bot-designer"],
      // a room joins the sender's section; a section the model invents is
      // never forwarded, so it cannot file the user's rooms for them
      section: "Work",
      bulletin: "Talk here, not in 1:1.",
    });
    expect(lastCreateChannelBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      name: "Skye & Nova",
      memberIds: ["bot-designer"],
      bulletin: "Talk here, not in 1:1.",
    });
    expect(res.result.content[0].text).toContain("Created channel");
    expect(res.result.content[0].text).toContain("Skye & Nova");
    expect(res.result.content[0].text).toContain("channel-two-bot");
    expect(res.result.content[0].text).toMatch(/ask_bot/i);
    expect(res.result.content[0].text).toMatch(/1:1/);
    expect(res.result.isError).toBeFalsy();
  });

  it("rejects create_channel without a name or members before calling the harness", async () => {
    lastCreateChannelBody = null;
    const missingName = await callTool("create_channel", { member_ids: ["bot-designer"] });
    expect(missingName.result.isError).toBe(true);
    expect(missingName.result.content[0].text).toContain("name");
    expect(lastCreateChannelBody).toBeNull();

    const missingMembers = await callTool("create_channel", { name: "Empty" });
    expect(missingMembers.result.isError).toBe(true);
    expect(missingMembers.result.content[0].text).toContain("member_ids");
    expect(lastCreateChannelBody).toBeNull();
  });

  it("requests an allowlisted credential without putting a secret in the request", async () => {
    const res = await callTool("request_credential", {
      credential_id: "geminiApiKey",
      reason: "The selected model needs it.",
    });
    expect(res.result.content[0].text).toContain("secure Gemini API key card");
    expect(res.result.content[0].text).toContain("End this turn");
    expect(lastCredentialBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      credentialId: "geminiApiKey",
      reason: "The selected model needs it.",
    });
    expect(JSON.stringify(lastCredentialBody)).not.toContain("secret");
  });

  it("requests a custom key locked to one host", async () => {
    const res = await callTool("request_credential", { credential_id: "custom", service: { name: "Acme", host: "api.acme.dev" } });
    expect(res.result.content[0].text).toContain("call_api with credential_id custom:api.acme.dev");
    expect(lastCredentialBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      credentialId: "custom",
      service: { name: "Acme", host: "api.acme.dev", header: "authorization", prefix: "Bearer " },
    });
    lastCredentialBody = null;
    for (const service of [{ name: "Acme", host: "https://api.acme.dev" }, { name: "Acme", host: "api.acme.dev", header: "cookie" }]) {
      const bad = await callTool("request_credential", { credential_id: "custom", service });
      expect(bad.result.isError).toBe(true);
    }
    expect(lastCredentialBody).toBeNull();
    const call = await callTool("call_api", { credential_id: "custom:api.acme.dev", method: "GET", url: "https://api.acme.dev/v1" });
    expect(call.result.content[0].text).not.toContain("secret");
    expect(lastCallApiBody.credentialId).toBe("custom:api.acme.dev");
  });

  it("rejects credential ids outside the fixed allowlist locally", async () => {
    lastCredentialBody = null;
    const res = await callTool("request_credential", { credential_id: "arbitrary.config.path" });
    expect(res.result.isError).toBe(true);
    expect(lastCredentialBody).toBeNull();
  });

  it("hands the delegator its task id and the tools to read the outcome", async () => {
    delegateResponse = {
      queued: true,
      taskId: "task-abc123",
      message: "Delegation queued — @Helper will pick it up after your current turn finishes.",
    };
    const res = await callTool("delegate_bot", { bot_id: "bot-helper", message: "do the thing" });
    expect(res.result.content[0].text).toContain("Task id: task-abc123");
    expect(res.result.content[0].text).toContain("wait_delegation");
    delegateResponse = { queued: true, message: "Delegation queued." };
  });

  it("check/wait_delegation: flat schemas, guided errors, and the read-back wire", async () => {
    const list = await rpc("tools/list");
    for (const name of ["check_delegation", "wait_delegation"]) {
      const tool = list.result.tools.find((t: { name: string }) => t.name === name);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(oneOf|anyOf|allOf|const|format)":/);
      expect(tool.inputSchema.properties.task_id.description).toContain("unique prefix of 8+ characters");
    }

    lastDelegationUrl = null;
    const bad = await callTool("check_delegation", { task_id: "!" });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('"task_id"');
    expect(lastDelegationUrl).toBeNull(); // guidance is free

    const done = await callTool("check_delegation", { task_id: "task-abc123" });
    expect(done.result.content[0].text).toContain("@Helper finished task task-abc123");
    expect(done.result.content[0].text).toContain("All done.");
    expect(lastDelegationUrl).toContain("/api/internal/delegations/task-abc123?");
    expect(lastDelegationUrl).toContain("wait_ms=0");
    expect(lastDelegationUrl).toContain("fromBotId=bot-asker");

    delegationStatusResponse = { status: "queued", toBotName: "Helper" };
    const waiting = await callTool("wait_delegation", { task_id: "task-abc123", timeout_seconds: 45 });
    expect(waiting.result.content[0].text).toContain("still queued");
    expect(waiting.result.content[0].text).toContain("after 45s");
    expect(lastDelegationUrl).toContain("wait_ms=45000");
    delegationStatusResponse = { status: "done", toBotName: "Helper", result: "All done." };
  });

  it("lists only the current bot's routines with authoritative time context", async () => {
    routinesResponse = {
      now: "2026-08-28T10:30:00.000Z",
      timeZone: "Asia/Kolkata",
      routines: [{ id: "routine-1", name: "Morning brief", enabled: true }],
    };
    const res = await callTool("list_routines", {});
    expect(res.result.content[0].text).toContain("routine-1");
    expect(res.result.content[0].text).toContain("Asia/Kolkata");
    const query = new URL(lastRoutineQuery, "http://localhost").searchParams;
    expect(query.get("fromBotId")).toBe("bot-asker");
    expect(query.get("fromThreadId")).toBe("thread-asker-routine");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("proposes a weekly routine through a confirmation-only request", async () => {
    lastRoutineRequestBody = null;
    const res = await callTool("propose_routine", {
      name: "Morning brief",
      instructions: "Summarize today's priorities.",
      schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] },
      run_on: "maus",
      duration_minutes: 45,
    });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "create",
      routine: {
        name: "Morning brief",
        instructions: "Summarize today's priorities.",
        schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] },
        runOn: "maus",
        durationMinutes: 45,
      },
    });
    expect(res.result.content[0].text).toContain("confirmation card");
    expect(res.result.content[0].text).toContain("has not been applied");
    expect(res.result.content[0].text).toContain("do not claim");
    expect(res.result.isError).toBeFalsy();
  });

  it("proposes a one-time routine with the explicit-offset timestamp intact", async () => {
    await callTool("propose_routine", {
      name: "Send follow-up",
      instructions: "Draft the follow-up for review.",
      schedule: { type: "once", at: "2026-09-01T09:00:00+05:30" },
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({
      type: "once",
      at: "2026-09-01T09:00:00+05:30",
    });
  });

  it("proposes routine updates and destructive actions without applying them", async () => {
    const update = await callTool("propose_routine_action", {
      routine_id: "routine-1",
      action: "update",
      changes: { name: "Weekday brief", duration_minutes: 60 },
    });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "update",
      routineId: "routine-1",
      changes: { name: "Weekday brief", durationMinutes: 60 },
    });
    expect(update.result.content[0].text).toContain("has not been applied");

    await callTool("propose_routine_action", { routine_id: "routine-1", action: "delete" });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "delete",
      routineId: "routine-1",
    });
  });

  it("coerces the schedule shapes models actually send", async () => {
    // "daily" is the natural word for every-day; it becomes weekly on all
    // seven days on the wire, so the harness dialect stays unchanged.
    await callTool("propose_routine", {
      name: "Daily check",
      instructions: "Check things.",
      schedule: { type: "daily", time: "09:00" },
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({
      type: "weekly",
      time: "09:00",
      weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    });

    // Capitalized and short weekday names have one obvious meaning.
    await callTool("propose_routine", {
      name: "Caps",
      instructions: "x.",
      schedule: { type: "weekly", time: "09:00", weekdays: ["Monday", "FRI"] },
    });
    expect(lastRoutineRequestBody.routine.schedule.weekdays).toEqual(["monday", "friday"]);

    // Models routinely deliver nested objects as JSON strings.
    await callTool("propose_routine", {
      name: "Str",
      instructions: "x.",
      schedule: JSON.stringify({ type: "weekly", time: "09:00", weekdays: ["monday"] }),
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({ type: "weekly", time: "09:00", weekdays: ["monday"] });
  });

  it("answers unsupported schedules with instructions, before calling the harness", async () => {
    lastRoutineRequestBody = null;
    const interval = await callTool("propose_routine", {
      name: "Interval",
      instructions: "x.",
      schedule: { type: "interval", minutes: 30 },
    });
    expect(interval.result.isError).toBe(true);
    expect(interval.result.content[0].text).toContain("sub-day intervals");
    expect(interval.result.content[0].text).toContain('"type":"daily"');

    const noDays = await callTool("propose_routine", {
      name: "NoDays",
      instructions: "x.",
      schedule: { type: "weekly", time: "09:00" },
    });
    expect(noDays.result.isError).toBe(true);
    expect(noDays.result.content[0].text).toContain("weekdays");
    expect(noDays.result.content[0].text).toContain("daily");

    const unknown = await callTool("propose_routine_action", {
      routine_id: "routine-1",
      action: "update",
      changes: { schedule: { type: "fortnightly", time: "09:00" } },
    });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0].text).toContain("Unknown schedule type");
    expect(lastRoutineRequestBody).toBeNull();
  });

  it("rejects malformed routine proposals before calling the harness", async () => {
    lastRoutineRequestBody = null;
    const missing = await callTool("propose_routine", {
      name: "No schedule",
      instructions: "This cannot be scheduled yet.",
    });
    expect(missing.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();

    const badUpdate = await callTool("propose_routine_action", {
      routine_id: "routine-1",
      action: "update",
      changes: {},
    });
    expect(badUpdate.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();
  });

  it("rejects unknown tools with -32602", async () => {
    const res = await rpc("tools/call", { name: "made_up", arguments: {} });
    expect(res.error.code).toBe(-32602);
  });

  it("requires bot_id and message", async () => {
    const res = await callTool("ask_bot", { bot_id: "", message: "" });
    expect(res.result.isError).toBe(true);
  });
});

/** A short-lived proxy with exactly this OMB_* identity: its tools/list and a react call. */
function probeWithIdentity(identity: Record<string, string>): Promise<{ list: any; call: any }> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OMB_")));
  const proxy = spawn(process.execPath, [PROXY], {
    windowsHide: true,
    env: { ...inherited, OMB_HARNESS_URL: "http://127.0.0.1:9", ...identity },
    stdio: ["pipe", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const replies = new Map<number, any>();
    const timer = setTimeout(() => {
      proxy.kill();
      reject(new Error("proxy probe timed out"));
    }, 10_000);
    let buf = "";
    proxy.stdout!.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        replies.set(msg.id, msg);
      }
      if (!replies.has(1) || !replies.has(2)) return;
      clearTimeout(timer);
      proxy.kill();
      resolve({ list: replies.get(1), call: replies.get(2) });
    });
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "react", arguments: { emoji: "👍" } } }) + "\n");
  });
}

describe("agents-proxy identity gate", () => {
  it.each([
    ["no identity", {}],
    ["a terminal-only identity", { OMB_BOT_ID: "bot-asker", OMB_COMMS_TOKEN: TOKEN }],
  ])("lists no tools and refuses calls with %s", async (_label, identity) => {
    const { list, call } = await probeWithIdentity(identity);
    expect(list.result.tools).toEqual([]);
    expect(call.error.code).toBe(-32602);
  });

  it("lists every tool once the bot, thread and comms token are all set", async () => {
    const { list } = await probeWithIdentity({ OMB_BOT_ID: "bot-asker", OMB_THREAD_ID: "thread-asker", OMB_COMMS_TOKEN: TOKEN });
    expect(list.result.tools).toHaveLength(17);
  });
});
