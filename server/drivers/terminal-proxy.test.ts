import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import { TOOLS, callTool, claudeState, readTerminalSnapshot, terminalReadGrant, terminalSnapshotText, workerReportText } from "./terminal-proxy.ts";

const CONFIG = { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" };
const BUSY = "● Working on it\n✽ Undulating… (3s · ↓ 75 tokens · thought for 2s)\n────────────────────\n❯\n────────────────────";
const IDLE = "● pong\n✻ Sautéed for 5s · done 11:34 PM\n──⏸─manual─mode─on──────────\n❯\n────────────────────";

type FetchMock = Mock<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>;

// GETs walk the given reads (the last repeats); POSTs answer with a mid-render screen.
function scripted(...reads: object[]): FetchMock {
  let next = 0;
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    new Response(JSON.stringify(init?.method === "POST" ? { screenText: "mid-render" } : reads[Math.min(next++, reads.length - 1)]), { status: 200 }));
}

const posted = (fetchImpl: FetchMock) => fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)).text);
const methods = (fetchImpl: FetchMock) => fetchImpl.mock.calls.map(([, init]) => init?.method ?? "GET");

async function send(fetchImpl: typeof fetch, args: Parameters<typeof callTool>[3]) {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    const result = callTool("terminal_send", fetchImpl, CONFIG, args);
    await vi.runAllTimersAsync();
    return await result;
  } finally {
    vi.useRealTimers();
  }
}

describe("terminal proxy", () => {
  it("derives distinct bot-bound read grants", () => {
    expect(terminalReadGrant("bridge-secret", "bot-1")).not.toBe(terminalReadGrant("bridge-secret", "bot-2"));
    expect(() => terminalReadGrant("bridge-secret", "bot/2")).toThrow(/grant/);
  });

  it("exposes a read-only read tool and destructive send, spawn and close tools, all bot-scoped", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(["terminal_read", "terminal_send", "terminal_spawn", "terminal_close"]);
    expect(TOOLS[0]).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(Object.keys(TOOLS[0].inputSchema.properties)).toEqual(["sessionId", "waitFor", "timeoutMs"]);
    expect(TOOLS[1]).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { required: ["sessionId", "generation"] } });
    expect(Object.keys(TOOLS[1].inputSchema.properties)).not.toContain("botId");
    expect(TOOLS[1].description).toContain("End with a newline to submit the line.");
    expect(TOOLS[1].description).toContain("Ctrl+C is refused");
    expect(TOOLS[1].description).toContain("esc interrupts a running Claude turn, so it is refused while the pane shows Claude: busy.");
    expect(TOOLS[0].description).toContain("\"Claude: busy\" while its spinner line says a turn is running");
    expect(TOOLS[2]).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { required: ["label"], additionalProperties: false } });
    expect(Object.keys(TOOLS[2].inputSchema.properties)).toEqual(["label", "cwd", "command"]);
    expect(TOOLS[3]).toMatchObject({ annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { required: ["sessionId"], additionalProperties: false } });
  });

  it("carries the worker spawn recipe in the tool descriptions", () => {
    expect(TOOLS[2].description).toContain("claude --model <model-id> --dangerously-skip-permissions 'Read <card path> and do it.'");
    expect(TOOLS[2].description).toContain(`--dangerously-bypass-approvals-and-sandbox ${workerReportText(process.platform).env}${workerReportText(process.platform).notify}'<prompt>'`);
    expect(TOOLS[2].description).toContain(workerReportText(process.platform).spawn);
    expect(TOOLS[0].description).toContain(workerReportText(process.platform).read);
    expect(TOOLS[2].description).toContain("NICKNAME | MODEL | EFFORT");
    expect(TOOLS[2].description).toContain("git worktree");
    expect(TOOLS[1].description).toContain("terminal_read with waitFor set to the Claude prompt text, then send \"/effort <level>\\n\"");
  });

  it("adds Codex pane env, notify and orbit-msg reports on Windows only", () => {
    const orbitMsg = join(homedir(), ".orbit", "bin", "orbit-msg.ps1").replace(/\\/g, "/");
    const win = workerReportText("win32");
    expect(win.env).toBe(["ORBIT_PANE", "ORBIT_BOT", "ORBIT_TEACHER", "ORBIT_URL", "ORBIT_MSG_AUTH"].map((name) => `-c "shell_environment_policy.set.${name}='$env:${name}'" `).join(""));
    expect(win.env).not.toContain("inherit");
    expect(win.notify).toBe(`-c 'notify=["powershell.exe","-NoProfile","-ExecutionPolicy","Bypass","-File","${orbitMsg}","--notify","last-assistant-message"]' `);
    expect(win.spawn).toContain("orbit-msg --report DONE|FAIL|BLOCKED <NICKNAME>");
    expect(win.read).toContain("pane note");
    const linux = workerReportText("linux");
    expect(linux.env).toBe("");
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

  it("posts one launch note to the harness after a spawn", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ sessionId: "p1", generation: 1 }), { status: 200 }));
    const config = { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1", harness: "http://127.0.0.1:2", commsToken: "comms" };
    const result = await callTool("terminal_spawn", fetchImpl, config, { label: "worker" });
    expect(result.isError).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe("http://127.0.0.1:2/api/internal/launch-note");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer comms" });
    expect(JSON.parse(String(init?.body))).toEqual({ fromBotId: "bot-1", sessionId: "p1" });
  });

  it("posts no launch note when the spawn fails, and a failed note never fails the spawn", async () => {
    const config = { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1", harness: "http://127.0.0.1:2", commsToken: "comms" };
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "Too many bot terminals (limit 8)" }), { status: 400 }));
    expect((await callTool("terminal_spawn", refused, config, { label: "worker" })).isError).toBe(true);
    expect(refused).toHaveBeenCalledTimes(1);
    const harnessDown = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/api/internal/")) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ sessionId: "p1", generation: 1 }), { status: 200 });
    });
    const result = await callTool("terminal_spawn", harnessDown, config, { label: "worker" });
    expect(result.isError).toBeUndefined();
    expect(harnessDown).toHaveBeenCalledTimes(2);
  });

  it("returns a successful spawn without waiting on a stalled launch note", async () => {
    let release!: (value: Response) => void;
    const stalled = new Promise<Response>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes("/launch-note")
      ? stalled : new Response(JSON.stringify({ sessionId: "p1", generation: 1 }), { status: 200 }));
    const config = { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1", harness: "http://127.0.0.1:2", commsToken: "comms" };
    let settled = false;
    const result = callTool("terminal_spawn", fetchImpl, config, { label: "worker" }).then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settledBeforeNote = settled;
    release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect((await result).isError).toBeUndefined();
    expect(settledBeforeNote).toBe(true);
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

  it("reports success, not an error, when the pane was already closed", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ closed: true, alreadyClosed: true }), { status: 200 });
    const result = await callTool("terminal_close", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { sessionId: "p1" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Pane p1 was already closed");
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

  it("passes waitFor and timeoutMs as query params and reports a hit", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ sessionId: "p1", generation: 1, screenText: "ready>", waited: "hit" }), { status: 200 }));
    const result = await callTool("terminal_read", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { sessionId: "p1", waitFor: "ready>", timeoutMs: 20_000 });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:1/v1/bots/bot-1/terminal?sessionId=p1&waitFor=ready%3E&timeoutMs=20000");
    expect(result.content[0].text).toContain("Waited for text: found");
  });

  it("reports a timeout with the current screen when waitFor never matches", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ sessionId: "p1", generation: 1, screenText: "still booting", waited: "timeout" }), { status: 200 });
    const result = await callTool("terminal_read", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { sessionId: "p1", waitFor: "ready>" });
    expect(result.content[0].text).toContain("Waited for text: timed out");
    expect(result.content[0].text).toContain("still booting");
  });

  it("gives a waitFor read a margin above timeoutMs, still bounded, and leaves other calls alone", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ screenText: "" }), { status: 200 });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const config = { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" };

    await callTool("terminal_read", fetchImpl, config, { waitFor: "x", timeoutMs: 30_000 });
    expect(timeoutSpy.mock.calls.at(-1)?.[0]).toBe(35_000); // requested timeout plus 5s margin

    await callTool("terminal_read", fetchImpl, config, { waitFor: "x", timeoutMs: 999_999_999 });
    expect(timeoutSpy.mock.calls.at(-1)?.[0]).toBe(65_000); // clamped to the 60s max plus margin

    await callTool("terminal_read", fetchImpl, config, { waitFor: "x" });
    expect(timeoutSpy.mock.calls.at(-1)?.[0]).toBe(20_000); // default 15s wait plus margin

    await callTool("terminal_read", fetchImpl, config, {});
    expect(timeoutSpy.mock.calls.at(-1)?.[0]).toBe(10_000); // a plain read keeps its own deadline

    await callTool("terminal_close", fetchImpl, config, { sessionId: "p1" });
    expect(timeoutSpy.mock.calls.at(-1)?.[0]).toBe(10_000); // other routes are unaffected

    timeoutSpy.mockRestore();
  });

  it("does not send waitFor or timeoutMs when waitFor is omitted", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ screenText: "ok" }), { status: 200 }));
    await callTool("terminal_read", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, {});
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:1/v1/bots/bot-1/terminal");
  });

  it("maps terminal_send args to a POST on the bot's send route", async () => {
    const fetchImpl = scripted({ sessionId: "s1", generation: 2, screenText: "PS> echo ok", seq: 3 });
    const result = await send(fetchImpl, { text: "echo ok\r", sessionId: "s1", generation: 2 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("echo ok");
    const [url, init] = fetchImpl.mock.calls.find(([, call]) => call?.method === "POST")!;
    expect(url).toBe("http://127.0.0.1:1/v1/bots/bot-1/terminal/send");
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: "s1", generation: 2, text: "echo ok" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer grant");
  });

  it.each([
    ["LF submits", "echo ok\n", ["echo ok", "\r"]],
    ["CRLF does not double-submit", "echo ok\r\n", ["echo ok", "\r"]],
    ["plain text stays unchanged", "echo ok", ["echo ok"]],
  ])("normalizes terminal_send text: %s", async (_label, text, expected) => {
    const fetchImpl = scripted({ screenText: "echo ok" });
    await send(fetchImpl, { text, sessionId: "s1", generation: 2 });
    expect(posted(fetchImpl)).toEqual(expected);
  });

  it("submits with a separate Enter once the typed text shows, as a bracketed paste", async () => {
    const fetchImpl = scripted({ sessionId: "s1" }, { screenText: "❯", modes: [2004] }, { screenText: "❯" }, { screenText: "❯ Reply with\n  pong" });
    await send(fetchImpl, { text: "Reply with pong\n", sessionId: "s1", generation: 2 });
    expect(posted(fetchImpl)).toEqual(["\x1b[200~Reply with pong\x1b[201~", "\r"]);
    expect(methods(fetchImpl).slice(0, 6)).toEqual(["GET", "GET", "POST", "GET", "GET", "POST"]);
  });

  it("submits long text once Claude folds it into [Pasted text]", async () => {
    const text = Array.from({ length: 60 }, (_, line) => `step ${line}`).join("\n");
    const fetchImpl = scripted({ sessionId: "s1" }, { screenText: "❯", modes: [2004] }, { screenText: "❯ [Pasted text #1 +59 lines]" });
    await send(fetchImpl, { text: `${text}\n`, sessionId: "s1", generation: 2 });
    expect(posted(fetchImpl).at(-1)).toBe("\r");
    expect(methods(fetchImpl).slice(0, 5)).toEqual(["GET", "GET", "POST", "GET", "POST"]);
  });

  it("still presses Enter when the typed text never shows, after a bounded wait", async () => {
    const fetchImpl = scripted({ screenText: "❯" });
    await send(fetchImpl, { text: "hidden\n", sessionId: "s1", generation: 2 });
    const calls = methods(fetchImpl);
    expect(posted(fetchImpl)).toEqual(["hidden", "\r"]);
    expect(calls.indexOf("POST", 3) - calls.indexOf("POST") - 1).toBe(15);
  });

  it("keeps concurrent sends to one pane, by full id or prefix, from interleaving", async () => {
    const id = "0123456789abcdef";
    const writes: string[] = [];
    let line = "";
    const fetchImpl: FetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        const text: string = JSON.parse(String(init.body)).text;
        writes.push(text);
        line = text === "\r" ? "" : line + text;
      }
      return new Response(JSON.stringify({ sessionId: id, generation: 2, screenText: `PS> ${line}` }), { status: 200 });
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const one = callTool("terminal_send", fetchImpl, CONFIG, { text: "echo one\n", sessionId: id, generation: 2 });
      const two = callTool("terminal_send", fetchImpl, CONFIG, { text: "echo two\n", sessionId: id.slice(0, 8), generation: 2 });
      await vi.runAllTimersAsync();
      expect((await one).isError).toBeUndefined();
      expect((await two).isError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(writes).toEqual(["echo one", "\r", "echo two", "\r"]);
  });

  it("returns the snapshot after the screen settles, not the mid-render one", async () => {
    const fetchImpl = scripted({ sessionId: "s1" }, { screenText: "frame 1" }, { screenText: "frame 2" }, { screenText: "done" });
    const result = await send(fetchImpl, { key: "enter", sessionId: "s1", generation: 2 });
    expect(result.content[0].text).toContain("done");
    expect(result.content[0].text).not.toContain("mid-render");
    expect(methods(fetchImpl)).toEqual(["GET", "POST", "GET", "GET", "GET", "GET"]);
  });

  it("stops settling after a bounded number of reads when the screen keeps changing", async () => {
    let frame = 0;
    const fetchImpl: FetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({ screenText: init?.method === "POST" ? "mid-render" : `frame ${frame++}` }), { status: 200 }));
    const result = await send(fetchImpl, { key: "down", sessionId: "s1", generation: 2 });
    expect(methods(fetchImpl).filter((method) => method === "GET")).toHaveLength(14);
    expect(result.content[0].text).toContain("frame 13");
  });

  it("refuses esc while the Claude pane is busy, without sending it", async () => {
    const fetchImpl = scripted({ screenText: BUSY });
    const result = await send(fetchImpl, { key: "esc", sessionId: "s1", generation: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("esc would interrupt the running Claude turn");
    expect(posted(fetchImpl)).toEqual([]);
  });

  it("sends esc when the Claude pane is idle", async () => {
    const fetchImpl = scripted({ screenText: IDLE });
    const result = await send(fetchImpl, { key: "esc", sessionId: "s1", generation: 2 });
    expect(result.isError).toBeUndefined();
    expect(posted(fetchImpl)).toEqual(["\x1b"]);
  });

  it("prints the capture time the send route returns", async () => {
    const capturedAt = Date.parse("2026-09-21T01:02:03.000Z");
    const fetchImpl = async () => new Response(JSON.stringify({ botId: "bot-1", sessionId: "s1", generation: 2, capturedAt, exited: false, screenText: "ok" }), { status: 200 });
    const result = await send(fetchImpl, { text: "x", sessionId: "s1", generation: 2 });
    expect(result.content[0].text).toContain("Captured at: 2026-09-21T01:02:03.000Z");
    expect(result.content[0].text).toContain("State: running");
  });

  it("surfaces bridge send errors as tool errors", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "Terminal session is stale; take a fresh snapshot" }), { status: 409 });
    const result = await callTool("terminal_send", fetchImpl, CONFIG, { text: "x", sessionId: "s1", generation: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("stale");
  });

  it.each([
    ["up", "\x1b[A"],
    ["down", "\x1b[B"],
    ["enter", "\r"],
    ["esc", "\x1b"],
  ])("sends the %s key as its bytes", async (key, expected) => {
    const fetchImpl = scripted({ screenText: "ok" });
    const result = await send(fetchImpl, { key, sessionId: "s1", generation: 2 });
    expect(result.isError).toBeUndefined();
    expect(posted(fetchImpl)).toEqual([expected]);
  });

  it("adds each pane's Claude state to the pane list, and nothing for an unknown one", () => {
    const text = terminalSnapshotText({
      sessionId: "s1",
      generation: 1,
      panes: [
        { sessionId: "s1", generation: 1, label: null, main: true, screenText: "PS C:\\work>" },
        { sessionId: "s2", generation: 1, label: "A | M | H", screenText: BUSY },
        { sessionId: "s3", generation: 2, label: "B | M | H", screenText: IDLE },
      ],
    });
    const list = text.split("Panes:\n")[1].split("\n");
    expect(list[0]).not.toContain("Claude:");
    expect(list[1]).toMatch(/A \| M \| H: sessionId s2 \(generation 1\), Claude: busy$/);
    expect(list[2]).toMatch(/B \| M \| H: sessionId s3 \(generation 2\), Claude: idle$/);
  });

  it.each([
    ["a running turn", BUSY, "busy"],
    ["the first spinner frame", "❯ go\n* Fermenting…\n────────────\n❯", "busy"],
    ["a finished turn at its prompt", IDLE, "idle"],
    ["a shell", "PS C:\\work> echo done…", undefined],
  ])("reads the Claude state from %s", (_label, screenText, state) => {
    expect(claudeState(screenText)).toBe(state);
    const text = terminalSnapshotText({ sessionId: "s1", generation: 1, screenText });
    if (state) expect(text).toContain(`Claude: ${state}`);
    else expect(text).not.toContain("Claude:");
  });

  it.each([
    ["an unknown key", { key: "ctrl+c" }],
    ["both text and key", { key: "up", text: "x" }],
    ["neither text nor key", {}],
  ])("rejects terminal_send with %s before fetching", async (_label, input) => {
    const fetchImpl = vi.fn();
    const result = await callTool("terminal_send", fetchImpl, { host: "http://127.0.0.1:1", token: "grant", botId: "bot-1" }, { ...input, sessionId: "s1", generation: 2 });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
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
    expect(terminalSnapshotText({ state: "no-terminal" })).toContain("no active Wink terminal");
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
