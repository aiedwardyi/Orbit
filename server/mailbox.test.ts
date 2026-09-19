import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installOrbitMsg, terminalPaneEnv } from "../electron/terminal-mailbox.mjs";
import {
  loadMailboxSecret, mailboxGrant, mailboxNoteText, mailboxScope, MAILBOX_NOTE_MAX_CHARS, MAILBOX_SECRET_FILE, MAILBOX_STALE_GRANT, readMailboxBody,
} from "./mailbox.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "a".repeat(48);
const PANE = "0f3c9a1e-7b2d-4c55-9e10-3a4b5c6d7e8f";
let child: ChildProcess;
let base: string;
let home: string;
const SCOPE = { pane: PANE, bot: "worker", teacher: "teacher" };
const GRANT = mailboxGrant(TOKEN, PANE, "worker", "teacher");

function scopeHeaders(scope: typeof SCOPE, grant: string) {
  return { authorization: `Bearer ${grant}`, "x-orbit-pane": scope.pane, "x-orbit-bot": scope.bot, "x-orbit-teacher": scope.teacher };
}

function post(body: unknown, scope = SCOPE, grant = GRANT) {
  return fetch(`${base}/api/mailbox`, {
    method: "POST",
    headers: { ...scopeHeaders(scope, grant), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Sends the request head and promises a body that never arrives. */
function headOnly(url: string, headers: Record<string, string>, partial = "") {
  const { hostname, port } = new URL(url);
  const socket = connect(Number(port), hostname);
  const lines = Object.entries({ host: `${hostname}:${port}`, "content-type": "application/json", "content-length": "1000", ...headers }).map(([k, v]) => `${k}: ${v}`);
  socket.write(`POST /api/mailbox HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n${partial}`);
  return socket;
}

// Async on purpose: a blocked event loop lets keep-alive sockets go stale under fetch.
function powershell(env: NodeJS.ProcessEnv, args: string[], input = "") {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { env, encoding: "utf8", windowsHide: true },
      (_error, stdout, stderr) => resolve({ status: child.exitCode, stdout, stderr }));
    child.stdin!.end(input);
  });
}

function paneShell(env: NodeJS.ProcessEnv, command: string) {
  return powershell(env, ["-EncodedCommand", Buffer.from(`$ProgressPreference = 'SilentlyContinue'; ${command}; exit $LASTEXITCODE`, "utf16le").toString("base64")]);
}

function orbitMsgFile(env: NodeJS.ProcessEnv, bin: string, args: string[], input?: string) {
  return powershell(env, ["-File", join(bin, "orbit-msg.ps1"), ...args], input);
}

async function transcript(threadId: string) {
  const response = await fetch(`${base}/api/threads/${threadId}/messages`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const page = await response.json() as { messages: Array<{ role: string; kind: string; text?: string }> };
  return page.messages;
}

beforeAll(async () => {
  const scratch = process.env.OMB_DATA_DIR ?? tmpdir();
  mkdirSync(scratch, { recursive: true });
  home = mkdtempSync(join(scratch, "mailbox-"));
  const data = join(home, "data");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
  }));
  const bot = (id: string) => ({
    id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: false, color: "purple", unread: false,
    modelSelection: { instanceId: "ghost", model: "ghost" }, resumeCursors: {}, computer: "off",
  });
  writeFileSync(join(data, "bots.json"), JSON.stringify([bot("teacher"), bot("worker")]));

  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0", OMB_COMMS_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.stdout!.resume();
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {}
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`server did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("mailbox note text", () => {
  it("strips escapes and controls, caps length and tags the pane", () => {
    expect(mailboxNoteText(PANE, "\x1b[31mdone\x1b[0m\r\n**ok**\x07")).toBe("[pane 0f3c9a1e] done\n**ok**");
    expect(mailboxNoteText(PANE, " \x1b[2J\n ")).toBeNull();
    expect(mailboxNoteText(PANE, "ok\u202eSPOOF\u2066\x9b31m")).toBe("[pane 0f3c9a1e] okSPOOF31m");
    expect(mailboxNoteText(PANE, "a\tb\nc")).toBe("[pane 0f3c9a1e] a\tb\nc");
    const long = mailboxNoteText(PANE, "x".repeat(MAILBOX_NOTE_MAX_CHARS + 50))!;
    expect(long.endsWith("x\n[truncated]")).toBe(true);
    expect(long.length).toBe("[pane 0f3c9a1e] ".length + MAILBOX_NOTE_MAX_CHARS + "\n[truncated]".length);
  });
});

describe("mailbox secret", () => {
  it("keeps an issued grant valid after the secret reloads from disk", () => {
    const dir = join(home, "user-data");
    const grant = mailboxGrant(loadMailboxSecret(dir), PANE, "worker", "teacher");
    const reloaded = loadMailboxSecret(dir);
    expect(mailboxScope(scopeHeaders(SCOPE, grant), reloaded)).toEqual({ ok: true, ...SCOPE });
    expect(readFileSync(join(dir, MAILBOX_SECRET_FILE), "utf8")).toBe(reloaded);
    if (process.platform !== "win32") expect(statSync(join(dir, MAILBOX_SECRET_FILE)).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, MAILBOX_SECRET_FILE), "corrupt");
    expect(mailboxScope(scopeHeaders(SCOPE, grant), loadMailboxSecret(dir))).toEqual({ ok: false, error: MAILBOX_STALE_GRANT });
  });
});

describe("POST /api/mailbox", () => {
  it("adds a plain note to the teacher chat without starting a turn", async () => {
    const response = await post({ text: "report: <b>tests</b> pass" });
    expect(response.status).toBe(200);
    expect(await transcript("teacher-thread")).toMatchObject([
      { role: "bot", kind: "note", text: "[pane 0f3c9a1e] report: <b>tests</b> pass" },
    ]);
    const { bots } = await (await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { bots: Array<{ id: string; busy?: boolean }> };
    expect(bots.find((bot) => bot.id === "teacher")?.busy).toBe(false);
    expect(await transcript("worker-thread")).toEqual([]);
  });

  it("rejects the comms token, a missing grant and a grant for another pane or teacher", async () => {
    const body = { text: "hi" };
    expect((await post(body, SCOPE, TOKEN)).status).toBe(401);
    expect((await post(body, SCOPE, "")).status).toBe(401);
    expect((await post(body, { ...SCOPE, pane: "other-pane" })).status).toBe(401);
    expect((await post(body, { ...SCOPE, teacher: "worker" })).status).toBe(401);
    expect((await post({ text: 7 })).status).toBe(400);
    expect((await post({ text: "\x1b[0m" })).status).toBe(400);
  });

  it("tells a stale grant from a bad one", async () => {
    const stale = mailboxGrant("b".repeat(48), PANE, "worker", "teacher");
    const response = await post({ text: "hi" }, SCOPE, stale);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: MAILBOX_STALE_GRANT });
    expect(await (await post({ text: "hi" }, SCOPE, "nope")).json()).toEqual({ error: "unauthorized" });
    if (process.platform !== "win32") return;
    const bin = (await installOrbitMsg(join(home, "bin")))!;
    const paneEnv = terminalPaneEnv({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, {
      pane: PANE, bot: "worker", teacher: "teacher", mailbox: { url: base, token: "b".repeat(48), binDir: bin },
    });
    const sent = await orbitMsgFile(paneEnv, bin, ["hi"]);
    expect(sent.status).toBe(1);
    expect(sent.stderr).toContain(MAILBOX_STALE_GRANT);
  }, 30_000);

  it("404s an unknown teacher", async () => {
    const scope = { ...SCOPE, teacher: "ghost" };
    expect((await post({ text: "hi" }, scope, mailboxGrant(TOKEN, PANE, "worker", "ghost"))).status).toBe(404);
  });

  it("rejects a bad or missing grant before reading any body byte", async () => {
    for (const headers of [scopeHeaders(SCOPE, "nope"), {}]) {
      const socket = headOnly(base, headers);
      const reply = await new Promise<string>((resolve, reject) => socket.once("data", (chunk) => resolve(String(chunk))).once("error", reject));
      socket.destroy();
      expect(reply).toMatch(/^HTTP\/1\.1 401/);
    }
  });

  it("rejects an oversized body", async () => {
    expect((await post({ text: "x".repeat(20_000) })).status).toBe(413);
  });

  it("drops a stalled body at the deadline", async () => {
    const results: unknown[] = [];
    const server = createServer(async (req, res) => {
      results.push(await readMailboxBody(req, 16 * 1024, 200));
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    const started = Date.now();
    const socket = headOnly(`http://127.0.0.1:${address.port}`, {}, '{"text":');
    await new Promise((resolve) => socket.once("close", resolve).once("error", resolve).resume());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(results).toEqual([{ ok: false, status: 408, error: "body timeout" }]);
    await new Promise((resolve) => server.close(resolve));
  });

  it.runIf(process.platform === "win32")("orbit-msg posts from pane env and fails clearly outside a pane", async () => {
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "orbit-msg.cmd"), "@echo stale");
    const bin = (await installOrbitMsg(join(home, "bin")))!;
    expect(existsSync(join(bin, "orbit-msg.cmd"))).toBe(false);
    const paneEnv = terminalPaneEnv({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, {
      pane: PANE, bot: "worker", teacher: "teacher", mailbox: { url: base, token: TOKEN, binDir: bin },
    });
    const sent = await paneShell(paneEnv, "orbit-msg from 'the pane'; 'piped' | orbit-msg");
    expect(sent.stderr).toBe("");
    expect(sent.status).toBe(0);
    const hook = await orbitMsgFile(paneEnv, bin, ["--hook", "last_assistant_message"], JSON.stringify({ last_assistant_message: "hook report 완료" }));
    expect(hook.status).toBe(0);
    const codex = await orbitMsgFile(paneEnv, bin, ["--notify", "last-assistant-message",
      JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "codex \"done\" & more" })]);
    expect(codex.stderr).toBe("");
    expect(codex.status).toBe(0);
    expect((await transcript("teacher-thread")).slice(-4).map((message) => message.text)).toEqual([
      "[pane 0f3c9a1e] from the pane",
      "[pane 0f3c9a1e] piped",
      "[pane 0f3c9a1e] hook report 완료",
      "[pane 0f3c9a1e] codex \"done\" & more",
    ]);
    const bare = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH };
    const outside = await orbitMsgFile(bare, bin, ["hi"]);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain("not inside an Orbit terminal pane");
    expect((await orbitMsgFile(bare, bin, ["--hook", "message"], "{}")).status).toBe(0);
  }, 30_000);

  it.runIf(process.platform === "win32")("orbit-msg posts shell metacharacters and quotes literally", async () => {
    const bin = (await installOrbitMsg(join(home, "bin")))!;
    const paneEnv = terminalPaneEnv({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, {
      pane: PANE, bot: "worker", teacher: "teacher", mailbox: { url: base, token: TOKEN, binDir: bin },
    });
    const texts = [
      'A " & echo PWNED & rem "',
      'A " & exit /b 2 & rem "',
      "%ORBIT_MSG_TOKEN%",
      "$env:ORBIT_MSG_TOKEN",
      `she said "hi" and it's fine`,
    ];
    const launches = [
      ...texts.map((text) => () => paneShell(paneEnv, `orbit-msg '${text.replaceAll("'", "''")}'`)),
      ...texts.map((text) => () => orbitMsgFile(paneEnv, bin, ["--hook", "last_assistant_message"], JSON.stringify({ last_assistant_message: text }))),
      ...texts.map((text) => () => orbitMsgFile(paneEnv, bin, ["--notify", "last-assistant-message", JSON.stringify({ "last-assistant-message": text })])),
    ];
    for (const launch of launches) {
      const run = await launch();
      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain("PWNED");
      expect(run.stderr).toBe("");
    }
    const posted = (await transcript("teacher-thread")).slice(-launches.length).map((message) => message.text);
    expect(posted).toEqual([...texts, ...texts, ...texts].map((text) => `[pane 0f3c9a1e] ${text}`));
    expect(posted.join("\n")).not.toContain(paneEnv.ORBIT_MSG_TOKEN);
  }, 60_000);
});
