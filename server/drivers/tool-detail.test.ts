import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, saveConfig } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { MuseAgentDriver } from "./acp/muse.ts";
import { CodexDriver } from "./codex.ts";
import { PiDriver } from "./pi.ts";

const TESTING = join(dirname(fileURLToPath(import.meta.url)), "..", "testing");
const engines = [
  { name: "Codex", driver: CodexDriver, cli: "fake-codex-app-server.ts", fixtureEnv: "FAKE_CODEX_TOOL_FIXTURE" },
  { name: "Grok", driver: GrokAgentDriver, cli: "fake-acp-cli.ts", fixtureEnv: "FAKE_ACP_TOOL_FIXTURE" },
  { name: "Muse ACP", driver: MuseAgentDriver, cli: "fake-acp-cli.ts", fixtureEnv: "FAKE_ACP_TOOL_FIXTURE" },
  { name: "Gemini", driver: GeminiAgentDriver, cli: "fake-acp-cli.ts", fixtureEnv: "FAKE_ACP_TOOL_FIXTURE" },
  { name: "Pi", driver: PiDriver, cli: "fake-pi-cli.ts", fixtureEnv: "FAKE_PI_TOOL_FIXTURE" },
];

interface ToolFixture {
  id: string;
  command?: string;
  path?: string;
  oldText?: string;
  newText?: string;
  output: string;
  failed?: boolean;
}

describe.each(engines)("$name tool detail", ({ name, driver, cli, fixtureEnv }) => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let fixturePath: string;

  beforeEach(() => {
    ensureDirs();
    saveConfig({ features: { toolDetailCapture: undefined } });
    chmodSync(join(TESTING, cli), 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-engine-detail-"));
    fixturePath = join(scratch, "tools.json");
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    saveConfig({ features: { toolDetailCapture: false } });
    await removeTempDir(scratch);
  });

  const create = async () => {
    const grokHome = join(scratch, ".grok");
    mkdirSync(grokHome);
    writeFileSync(join(grokHome, "auth.json"), JSON.stringify({ xai: { key: "test-grok-login" } }));
    instance = await driver.create({
      instanceId: "tool-detail-test",
      displayName: name,
      enabled: true,
      config: { cli: join(TESTING, cli), fullAuto: true },
      environment: { [fixtureEnv]: fixturePath, GROK_HOME: grokHome, META_API_KEY: "test-meta-key" },
    });
    recorder = recordEvents(instance.adapter);
  };

  const writeFixture = (tools: ToolFixture[]) => {
    const frames = tools.map((tool) => {
      const input = tool.command === undefined
        ? { path: tool.path, oldText: tool.oldText, newText: tool.newText }
        : { command: tool.command };
      if (name === "Codex") {
        const item = tool.command === undefined
          ? { id: tool.id, type: "fileChange", changes: [{ path: tool.path, kind: { type: "update", move_path: null }, diff: `--- a/${tool.path}\n+++ b/${tool.path}\n@@ -1 +1 @@\n-${tool.oldText}\n+${tool.newText}\n` }], status: "completed" }
          : { id: tool.id, type: "commandExecution", command: tool.command, aggregatedOutput: tool.output, exitCode: tool.failed ? 1 : 0, status: "completed" };
        return [
          { method: "item/started", params: { item } },
          { method: "item/completed", params: { item } },
        ];
      }
      if (name === "Pi") {
        const toolName = tool.command === undefined ? "edit" : "bash";
        return [
          { type: "tool_execution_start", toolCallId: tool.id, toolName, args: input },
          { type: "tool_execution_end", toolCallId: tool.id, toolName, result: { content: [{ type: "text", text: tool.output }], details: {} }, isError: tool.failed ?? false },
        ];
      }
      const content = tool.command === undefined
        ? [{ type: "diff", path: tool.path, oldText: tool.oldText, newText: tool.newText }]
        : [{ type: "content", content: { type: "text", text: tool.output } }];
      return [
        { sessionUpdate: "tool_call", toolCallId: tool.id, title: tool.command ?? `Edit ${tool.path}`, kind: tool.command === undefined ? "edit" : "execute", rawInput: input },
        { sessionUpdate: "tool_call_update", toolCallId: tool.id, status: tool.failed ? "failed" : "completed", content },
      ];
    }).flat();
    writeFileSync(fixturePath, JSON.stringify(frames));
  };

  const run = async () => {
    await instance.adapter.sendTurn({ threadId: "t-detail", text: "inspect", cwd: scratch });
    await recorder.until((event) => event.type === "turn.completed");
    return recorder.events.filter((event) => event.type === "item.completed" && event.itemType === "tool");
  };

  const capture = async (tool: ToolFixture) => {
    writeFixture([tool]);
    saveConfig({ features: { toolDetailCapture: true } });
    await create();
    const [event] = await run();
    if (event?.type !== "item.completed" || event.itemType !== "tool") throw new Error("missing tool completion");
    return event;
  };

  it.skipIf(name === "Pi")("names a command and a file change with Claude Code verbs", async () => {
    writeFixture([
      { id: "command", command: "git status", output: "clean" },
      { id: "edit", path: "src/a.ts", oldText: "a", newText: "b", output: "edited" },
    ]);
    await create();
    await run();
    const started = recorder.events.filter((event) => event.type === "item.started");
    expect(started).toMatchObject(name === "Codex"
      ? [{ title: "git status", verb: "Bash" }, { title: "edit", verb: "Edit" }]
      : [{ title: "git status", verb: "Bash" }, { title: "Edit src/a.ts", verb: "Edit" }]);
  });

  it.skipIf(name !== "Codex")("names a web search WebSearch and leaves an MCP call unnamed", async () => {
    writeFileSync(fixturePath, JSON.stringify([
      { method: "item/started", params: { item: { id: "w", type: "webSearch", query: "orbit" } } },
      { method: "item/completed", params: { item: { id: "w", type: "webSearch", status: "completed", query: "orbit" } } },
      { method: "item/started", params: { item: { id: "m", type: "mcpToolCall", tool: "list_bots" } } },
      { method: "item/completed", params: { item: { id: "m", type: "mcpToolCall", status: "completed", tool: "list_bots" } } },
    ]));
    await create();
    await run();
    const started = recorder.events.filter((event) => event.type === "item.started");
    expect(started[0]).toMatchObject({ title: "web_search", verb: "WebSearch" });
    expect(started[1]).toMatchObject({ title: "list_bots" });
    expect(started[1]).not.toHaveProperty("verb");
  });

  it.skipIf(name === "Codex" || name === "Pi")("names read, search and fetch, and leaves other kinds unnamed", async () => {
    writeFileSync(fixturePath, JSON.stringify([
      { sessionUpdate: "tool_call", toolCallId: "r", title: "src/a.ts", kind: "read" },
      { sessionUpdate: "tool_call", toolCallId: "s", title: "verb", kind: "search" },
      { sessionUpdate: "tool_call", toolCallId: "f", title: "https://example.com", kind: "fetch" },
      { sessionUpdate: "tool_call", toolCallId: "t", title: "think", kind: "think" },
      { sessionUpdate: "tool_call", toolCallId: "n", title: "run" },
    ]));
    await create();
    await run();
    const started = recorder.events.filter((event) => event.type === "item.started");
    expect(started).toMatchObject([
      { title: "src/a.ts", verb: "Read" },
      { title: "verb", verb: "Grep" },
      { title: "https://example.com", verb: "WebFetch" },
      { title: "think" },
      { title: "run" },
    ]);
    expect(started[3]).not.toHaveProperty("verb");
    expect(started[4]).not.toHaveProperty("verb");
  });

  it("captures a command and its output", async () => {
    const event = await capture({ id: "command", command: "echo one", output: "one\r\ntwo\r\nthree\r\nfour\r\n" });
    expect(event.detail).toEqual({ input: "echo one", output: ["one", "two", "three"], more: 1 });
  });

  it("captures a file change", async () => {
    const event = await capture({ id: "edit", path: "src/app.ts", oldText: "old", newText: "new", output: "Updated src/app.ts" });
    expect(event.detail).toEqual(name === "Pi"
      ? { input: "src/app.ts", output: ["Updated src/app.ts"] }
      : { input: "src/app.ts", diff: ["-old", "+new"] });
  });

  it("keeps an error's first line", async () => {
    const event = await capture({ id: "error", command: "node missing.js", output: "Exit code 1\nreason\nstack\n", failed: true });
    expect(event).toMatchObject({ ok: false, detail: { input: "node missing.js", output: ["Exit code 1"], more: 2 } });
  });

  it.each(["env", "printenv", "set", "gh auth token", "cat .env.local", "type C:\\project\\.env", "Get-Content -LiteralPath '.env.production'", "echo token", "echo secret", "echo password", "echo credential", "echo api_key"])("hides secret-command output for %s", async (command) => {
    const event = await capture({ id: "hidden", command, output: "opaque-sensitive-value", failed: true });
    expect(event.detail).toEqual({ input: command, outputHidden: true });
  });

  it("redacts before applying the shared byte cap", async () => {
    const key = `sk-proj-${"abcdef0123456789".repeat(12)}`;
    const command = `echo ${"한🧠".repeat(50)} ${key}`;
    const event = await capture({ id: "redacted", command, output: `${"x".repeat(75)} ${key}\none\ntwo\nthree\nfour\n` });
    expect(event.detail?.output).toHaveLength(3);
    expect(event.detail?.more).toBe(2);
    expect(JSON.stringify(event.detail)).not.toContain("sk-proj-");
    expect(JSON.stringify(event.detail)).not.toContain("abcdef0123456789");
    expect(Buffer.byteLength(JSON.stringify(event.detail), "utf8")).toBeLessThanOrEqual(256);
  });

  it("keeps a redacted secret-command header", async () => {
    const event = await capture({ id: "header", command: "echo token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", output: "opaque-sensitive-value" });
    expect(event.detail).toEqual({ input: "echo token=«redacted 40 chars»", outputHidden: true });
  });

  it("hides a secret command when another input field is null", async () => {
    const input = { command: "env", path: null };
    const content = [{ type: "text", text: "opaque-sensitive-value" }];
    if (name === "Codex") {
      writeFileSync(fixturePath, JSON.stringify([{ method: "item/completed", params: { item: { id: "null-input", type: "mcpToolCall", arguments: input, status: "completed", result: { content }, error: null } } }]));
    } else if (name === "Pi") {
      writeFileSync(fixturePath, JSON.stringify([
        { type: "tool_execution_start", toolCallId: "null-input", toolName: "bash", args: input },
        { type: "tool_execution_end", toolCallId: "null-input", toolName: "bash", result: { content }, isError: false },
      ]));
    } else {
      writeFileSync(fixturePath, JSON.stringify([
        { sessionUpdate: "tool_call", toolCallId: "null-input", title: "run", kind: "execute", rawInput: input },
        { sessionUpdate: "tool_call_update", toolCallId: "null-input", status: "completed", content: content.map((block) => ({ type: "content", content: block })) },
      ]));
    }
    saveConfig({ features: { toolDetailCapture: true } });
    await create();
    expect(await run()).toMatchObject([{ detail: { input: "env", outputHidden: true } }]);
    expect(JSON.stringify(recorder.events.filter((event) => event.type === "item.completed"))).not.toContain("opaque-sensitive-value");
  });

  it("keeps inputs paired with interleaved completions", async () => {
    writeFixture(["one", "two"].map((id) => ({ id, command: `echo ${id}`, output: id })));
    const frames = JSON.parse(readFileSync(fixturePath, "utf8"));
    writeFileSync(fixturePath, JSON.stringify([frames[0], frames[2], frames[3], frames[1]]));
    saveConfig({ features: { toolDetailCapture: true } });
    await create();
    const events = await run();
    expect(events).toMatchObject([
      { itemId: "two", detail: { input: "echo two", output: ["two"] } },
      { itemId: "one", detail: { input: "echo one", output: ["one"] } },
    ]);
  });

  it("joins text content and ignores images", async () => {
    const content = [{ type: "text", text: "one" }, { type: "image", data: "opaque-image" }, { type: "text", text: "two" }];
    if (name === "Codex") {
      writeFileSync(fixturePath, JSON.stringify([{ method: "item/completed", params: { item: { id: "text", type: "mcpToolCall", arguments: { query: "hello" }, status: "completed", result: { content }, error: null } } }]));
    } else if (name === "Pi") {
      writeFileSync(fixturePath, JSON.stringify([
        { type: "tool_execution_start", toolCallId: "text", toolName: "custom", args: { query: "hello" } },
        { type: "tool_execution_end", toolCallId: "text", toolName: "custom", result: { content }, isError: false },
      ]));
    } else {
      writeFileSync(fixturePath, JSON.stringify([
        { sessionUpdate: "tool_call", toolCallId: "text", title: "custom", rawInput: { query: "hello" } },
        { sessionUpdate: "tool_call_update", toolCallId: "text", status: "completed", content: content.map((block) => ({ type: "content", content: block })) },
      ]));
    }
    saveConfig({ features: { toolDetailCapture: true } });
    await create();
    expect(await run()).toMatchObject([{ detail: { input: '{"query":"hello"}', output: ["one", "two"] } }]);
  });

  if (name === "Codex") {
    it.each(["add", "delete"])("captures raw file content for a %s patch", async (type) => {
      const diff = "one\r\ntwo\r\nghp_abcdefghijklmnopqrstuvwxyz0123456789\r\n";
      writeFileSync(fixturePath, JSON.stringify([{ method: "item/completed", params: { item: { id: "patch", type: "fileChange", status: "completed", changes: [{ path: "notes.md", kind: { type }, diff }] } } }]));
      saveConfig({ features: { toolDetailCapture: true } });
      await create();
      const prefix = type === "add" ? "+" : "-";
      expect(await run()).toMatchObject([{ detail: { input: "notes.md", diff: [`${prefix}one`, `${prefix}two`, `${prefix}«redacted 40 chars»`] } }]);
    });

    it("keeps an MCP error's first line", async () => {
      writeFileSync(fixturePath, JSON.stringify([{ method: "item/completed", params: { item: { id: "mcp-error", type: "mcpToolCall", arguments: { path: "missing.txt" }, status: "failed", result: null, error: { message: "File missing\nreason\nstack" } } } }]));
      saveConfig({ features: { toolDetailCapture: true } });
      await create();
      expect(await run()).toMatchObject([{ ok: false, detail: { input: "missing.txt", output: ["File missing"], more: 2 } }]);
    });
  }

  if (fixtureEnv === "FAKE_ACP_TOOL_FIXTURE") {
    it("retains raw arguments and output across null updates", async () => {
      writeFileSync(fixturePath, JSON.stringify([
        { sessionUpdate: "tool_call", toolCallId: "null-update", title: "run", kind: "execute", rawInput: { command: "echo hi" }, rawOutput: "hi\nthere" },
        { sessionUpdate: "tool_call_update", toolCallId: "null-update", status: "completed", rawInput: null, rawOutput: null },
      ]));
      saveConfig({ features: { toolDetailCapture: true } });
      await create();
      expect(await run()).toMatchObject([{ detail: { input: "echo hi", output: ["hi", "there"] } }]);
    });

    it("retains partial input and content updates through completion", async () => {
      writeFileSync(fixturePath, JSON.stringify([
        { sessionUpdate: "tool_call", toolCallId: "partial", title: "run", kind: "execute" },
        { sessionUpdate: "tool_call_update", toolCallId: "partial", rawInput: { command: "echo hi" }, content: [{ type: "content", content: { type: "text", text: "hi" } }], status: "in_progress" },
        { sessionUpdate: "tool_call_update", toolCallId: "partial", status: "completed" },
      ]));
      saveConfig({ features: { toolDetailCapture: true } });
      await create();
      expect(await run()).toMatchObject([{ detail: { input: "echo hi", output: ["hi"] } }]);
    });

    it("captures a tool already completed in its first notification", async () => {
      writeFileSync(fixturePath, JSON.stringify([{ sessionUpdate: "tool_call", toolCallId: "instant", title: "echo hi", kind: "execute", rawInput: { command: "echo hi" }, status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] }]));
      saveConfig({ features: { toolDetailCapture: true } });
      await create();
      expect(await run()).toMatchObject([{ detail: { input: "echo hi", output: ["hi"] } }]);
    });

    it("captures a new file from a null oldText diff", async () => {
      writeFileSync(fixturePath, JSON.stringify([
        { sessionUpdate: "tool_call", toolCallId: "new-file", title: "Write notes.md", kind: "edit" },
        { sessionUpdate: "tool_call_update", toolCallId: "new-file", status: "completed", content: [{ type: "diff", path: "notes.md", oldText: null, newText: "one\ntwo\n" }] },
      ]));
      saveConfig({ features: { toolDetailCapture: true } });
      await create();
      expect(await run()).toMatchObject([{ detail: { input: "notes.md", diff: ["+one", "+two"] } }]);
    });

    it("captures rawOutput when text content is absent", async () => {
      writeFileSync(fixturePath, JSON.stringify([
        { sessionUpdate: "tool_call", toolCallId: "raw", title: "run", kind: "execute", rawInput: { command: "echo hi" } },
        { sessionUpdate: "tool_call_update", toolCallId: "raw", status: "completed", rawOutput: "hi\nthere" },
      ]));
      saveConfig({ features: { toolDetailCapture: true } });
      await create();
      expect(await run()).toMatchObject([{ detail: { input: "echo hi", output: ["hi", "there"] } }]);
    });
  }

  it("emits no detail while off and picks up opt-in during a running turn", async () => {
    writeFixture(["before", "enabled", "after"].map((id) => ({ id, command: `echo ${id}`, output: id })));
    await create();
    const unsubscribe = instance.adapter.onEvent((event) => {
      if (event.type !== "item.completed" || event.itemType !== "tool") return;
      if (event.itemId === "before") saveConfig({ features: { toolDetailCapture: true } });
      if (event.itemId === "enabled") saveConfig({ features: { toolDetailCapture: false } });
    });
    try {
      const events = await run();
      expect(events).toHaveLength(3);
      expect(events[0]).not.toHaveProperty("detail");
      expect(events[1]).toMatchObject({ detail: { input: "echo enabled", output: ["enabled"] } });
      expect(events[2]).not.toHaveProperty("detail");
    } finally {
      unsubscribe();
    }
  });
});
