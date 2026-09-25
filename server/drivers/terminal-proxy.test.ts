import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TOOLS, callTool, readTerminalSnapshot, terminalReadGrant, terminalSnapshotText, workerReportText } from "./terminal-proxy.ts";

describe("terminal proxy", () => {
  it("derives distinct bot-bound read grants", () => {
    expect(terminalReadGrant("bridge-secret", "bot-1")).not.toBe(terminalReadGrant("bridge-secret", "bot-2"));
    expect(() => terminalReadGrant("bridge-secret", "bot/2")).toThrow(/grant/);
  });

  it("exposes a read-only read tool and destructive send, spawn and close tools, all bot-scoped", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(["terminal_read", "terminal_send", "terminal_spawn", "terminal_close"]);
    expect(TOOLS[0]).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(Object.keys(TOOLS[0].inputSchema.properties)).toEqual(["sessionId"]);
    expect(TOOLS[1]).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { required: ["text", "sessionId", "generation"] } });
    expect(Object.keys(TOOLS[1].inputSchema.properties)).not.toContain("botId");
    expect(TOOLS[1].description).toContain("End with a newline to submit the line.");
    expect(TOOLS[1].description).toContain("Ctrl+C is refused");
    expect(TOOLS[2]).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { required: ["label"], additionalProperties: false } });
    expect(Object.keys(TOOLS[2].inputSchema.properties)).toEqual(["label", "cwd", "command"]);
    expect(TOOLS[3]).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { required: ["sessionId"], additionalProperties: false } });
  });

  it("carries the worker spawn recipe in the tool descriptions", () => {
    expect(TOOLS[2].description).toContain("claude --model <model-id> --dangerously-skip-permissions 'Read <card path> and do it.'");
    expect(TOOLS[2].description).toContain(`-s workspace-write ${workerReportText(process.platform).notify}'<prompt>'`);
    expect(TOOLS[2].description).toContain(workerReportText(process.platform).spawn);
    expect(TOOLS[0].description).toContain(workerReportText(process.platform).read);
    expect(TOOLS[2].description).toContain("NICKNAME | MODEL | EFFORT");
    expect(TOOLS[2].description).toContain("git worktree");
    expect(TOOLS[1].description).toContain("terminal_read until the Claude prompt is visible, then send \"/effort <level>\\n\"");
  });

  it("adds Codex notify and orbit-msg reports on Windows only", () => {
    const orbitMsg = join(homedir(), ".orbit", "bin", "orbit-msg.ps1").replace(/\\/g, "/");
    const win = workerReportText("win32");
    expect(win.notify).toBe(`-c 'notify=["powershell.exe","-NoProfile","-ExecutionPolicy","Bypass","-File","${orbitMsg}","--notify","last-assistant-message"]' `);
    expect(win.spawn).toContain("orbit-msg --report DONE|FAIL|BLOCKED <NICKNAME>");
    expect(win.read).toContain("pane note");
    const linux = workerReportText("linux");
    expect(linux.notify).toBe("");
    expect(linux.spawn).toContain("orbit-msg is not installed on this platform");
    expect(linux.read).not.toContain("pane note");
  });

  it("maps terminal_spawn args to a POST on the bot's open route", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ sessionId: "p1", generation: 1 }), { status: 200 }));
    const result = await callTool("terminal_spawn", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { label: "Opus 5.5 | high | ORCH", command: "claude" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("sessionId p1 (generation 1)");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1/v1/bots/bot-1/terminal/open");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ label: "Opus 5.5 | high | ORCH", command: "claude" });
  });

  it("rejects terminal_spawn without a label before fetching", async () => {
    const fetchImpl = vi.fn();
    const result = await callTool("terminal_spawn", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { command: "ls" });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps terminal_close to a POST on the bot's close route", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ closed: true }), { status: 200 }));
    const result = await callTool("terminal_close", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { sessionId: "p1" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Closed pane p1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1/v1/bots/bot-1/terminal/close");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: "p1" });
  });

  it("rejects terminal_close without a sessionId before fetching", async () => {
    const fetchImpl = vi.fn();
    const result = await callTool("terminal_close", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, {});
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads one pane by session id and lists every pane with its label", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      sessionId: "p1",
      generation: 1,
      label: "worker",
      screenText: "ok",
      panes: [
        { sessionId: "m1", generation: 3, label: null, main: true, exited: false },
        { sessionId: "p1", generation: 1, label: "worker", main: false, exited: false },
      ],
    }), { status: 200 }));
    const result = await callTool("terminal_read", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { sessionId: "p1" });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:1/v1/bots/bot-1/terminal?sessionId=p1");
    expect(result.content[0].text).toContain("Label: worker");
    expect(result.content[0].text).toContain("- main: sessionId m1 (generation 3), main");
    expect(result.content[0].text).toContain("- worker: sessionId p1 (generation 1)");
  });

  it("maps terminal_send args to a POST on the bot's send route", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ sessionId: "s1", generation: 2, screenText: "echo ok", seq: 3 }), { status: 200 }));
    const result = await callTool(
      "terminal_send",
      fetchImpl,
      { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" },
      { text: "echo ok\r", sessionId: "s1", generation: 2 },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("echo ok");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1/v1/bots/bot-1/terminal/send");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: "s1", generation: 2, text: "echo ok\r" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer grant");
  });

  it.each([
    ["LF submits", "echo ok\n", "echo ok\r"],
    ["CRLF does not double-submit", "echo ok\r\n", "echo ok\r"],
    ["plain text stays unchanged", "echo ok", "echo ok"],
  ])("normalizes terminal_send text: %s", async (_label, text, expected) => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ screenText: "ok" }), { status: 200 }));
    await callTool(
      "terminal_send",
      fetchImpl,
      { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" },
      { text, sessionId: "s1", generation: 2 },
    );
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init?.body)).text).toBe(expected);
  });

  it("prints the capture time the send route returns", async () => {
    const capturedAt = Date.parse("2026-09-21T01:02:03.000Z");
    const fetchImpl = async () => new Response(JSON.stringify({ botId: "bot-1", sessionId: "s1", generation: 2, capturedAt, exited: false, screenText: "ok" }), { status: 200 });
    const result = await callTool("terminal_send", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { text: "x", sessionId: "s1", generation: 2 });
    expect(result.content[0].text).toContain("Captured at: 2026-09-21T01:02:03.000Z");
    expect(result.content[0].text).toContain("State: running");
  });

  it("surfaces bridge send errors as tool errors", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "Terminal session is stale; take a fresh snapshot" }), { status: 409 });
    const result = await callTool("terminal_send", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { text: "x", sessionId: "s1", generation: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("stale");
  });

  it("rejects terminal_send without a session pair before fetching", async () => {
    const fetchImpl = vi.fn();
    const result = await callTool("terminal_send", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { text: "x" });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("formats session identity, screen, and truncation metadata", () => {
    expect(terminalSnapshotText({
      sessionId: "session-1",
      generation: 2,
      cwd: "C:\\work",
      seq: 9,
      capturedAt: Date.parse("2026-09-18T05:52:00.000Z"),
      exited: false,
      screenText: "ready >",
      recentText: "previous",
      truncated: true,
    })).toContain("generation 2");
    expect(terminalSnapshotText({ state: "no-terminal" })).toContain("no active Orbit terminal");
  });

  it("returns a read error when the bridge is unavailable", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "stale terminal" }), { status: 409 });
    const result = await callTool("terminal_read", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("stale terminal");
  });

  it("does not fetch when terminal sharing is disabled", async () => {
    const fetchImpl = vi.fn();
    const result = await callTool("terminal_read", fetchImpl);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not enabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the already bot-scoped bearer without exposing a master token", async () => {
    const grant = terminalReadGrant("bridge-secret", "bot-1");
    let authorization = "";
    const snapshot = await readTerminalSnapshot(
      async (_url, init) => {
        authorization = String(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify({ state: "no-terminal" }), { status: 200 });
      },
      { host: "http://127.0.0.1:1", token: grant, botId: "bot-1" },
    );
    expect(snapshot).toMatchObject({ state: "no-terminal" });
    expect(authorization).toBe(`Bearer ${grant}`);
  });
});
