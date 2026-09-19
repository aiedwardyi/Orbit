import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installOrbitMsg, terminalPaneEnv } from "../electron/terminal-mailbox.mjs";
import { mailboxGrant, mailboxNoteText, MAILBOX_NOTE_MAX_CHARS } from "./mailbox.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "a".repeat(48);
const PANE = "0f3c9a1e-7b2d-4c55-9e10-3a4b5c6d7e8f";
let child: ChildProcess;
let base: string;
let home: string;

function post(body: unknown, grant = mailboxGrant(TOKEN, PANE, "worker", "teacher")) {
  return fetch(`${base}/api/mailbox`, {
    method: "POST",
    headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
    const long = mailboxNoteText(PANE, "x".repeat(MAILBOX_NOTE_MAX_CHARS + 50))!;
    expect(long.endsWith("x\n[truncated]")).toBe(true);
    expect(long.length).toBe("[pane 0f3c9a1e] ".length + MAILBOX_NOTE_MAX_CHARS + "\n[truncated]".length);
  });
});

describe("POST /api/mailbox", () => {
  it("adds a plain note to the teacher chat without starting a turn", async () => {
    const response = await post({ pane: PANE, bot: "worker", teacher: "teacher", text: "report: <b>tests</b> pass" });
    expect(response.status).toBe(200);
    expect(await transcript("teacher-thread")).toMatchObject([
      { role: "bot", kind: "note", text: "[pane 0f3c9a1e] report: <b>tests</b> pass" },
    ]);
    const { bots } = await (await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { bots: Array<{ id: string; busy?: boolean }> };
    expect(bots.find((bot) => bot.id === "teacher")?.busy).toBe(false);
    expect(await transcript("worker-thread")).toEqual([]);
  });

  it("rejects the comms token, a missing grant and a grant for another pane or teacher", async () => {
    const body = { pane: PANE, bot: "worker", teacher: "teacher", text: "hi" };
    expect((await post(body, TOKEN)).status).toBe(401);
    expect((await post(body, "")).status).toBe(401);
    expect((await post({ ...body, pane: "other-pane" })).status).toBe(401);
    expect((await post({ ...body, teacher: "worker" })).status).toBe(401);
    expect((await post({ ...body, text: 7 })).status).toBe(400);
    expect((await post({ ...body, text: "\x1b[0m" })).status).toBe(400);
  });

  it("404s an unknown teacher", async () => {
    const grant = mailboxGrant(TOKEN, PANE, "worker", "ghost");
    expect((await post({ pane: PANE, bot: "worker", teacher: "ghost", text: "hi" }, grant)).status).toBe(404);
  });

  it.runIf(process.platform === "win32")("orbit-msg posts from pane env and fails clearly outside a pane", async () => {
    const bin = await installOrbitMsg(join(home, "bin"));
    const paneEnv = terminalPaneEnv({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, {
      pane: PANE, bot: "worker", teacher: "teacher", mailbox: { url: base, token: TOKEN, binDir: bin },
    });
    const sent = spawnSync("cmd.exe", ["/d", "/c", "orbit-msg", "from", "the pane"], { env: paneEnv, encoding: "utf8", windowsHide: true });
    expect(sent.stderr).toBe("");
    expect(sent.status).toBe(0);
    const hook = spawnSync("cmd.exe", ["/d", "/c", "orbit-msg", "--hook", "last_assistant_message"], {
      env: paneEnv, input: JSON.stringify({ last_assistant_message: "hook report 완료" }), encoding: "utf8", windowsHide: true,
    });
    expect(hook.status).toBe(0);
    const codex = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(bin!, "orbit-mailbox.ps1"), "--hook", "last-assistant-message",
      JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "codex \"done\" & more" })], { env: paneEnv, encoding: "utf8", windowsHide: true });
    expect(codex.stderr).toBe("");
    expect(codex.status).toBe(0);
    expect((await transcript("teacher-thread")).slice(-3).map((message) => message.text)).toEqual([
      "[pane 0f3c9a1e] from the pane",
      "[pane 0f3c9a1e] hook report 완료",
      "[pane 0f3c9a1e] codex \"done\" & more",
    ]);
    const bare = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH };
    const outside = spawnSync("cmd.exe", ["/d", "/c", join(bin!, "orbit-msg.cmd"), "hi"], { env: bare, encoding: "utf8", windowsHide: true });
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain("not inside an Orbit terminal pane");
    const quietHook = spawnSync("cmd.exe", ["/d", "/c", join(bin!, "orbit-msg.cmd"), "--hook", "message"], { env: bare, input: "{}", encoding: "utf8", windowsHide: true });
    expect(quietHook.status).toBe(0);
  }, 30_000);
});
