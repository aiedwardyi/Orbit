import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { mailboxGrant as serverGrant, resolveMailboxTeacher } from "../server/mailbox.ts";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { createTerminalHost } from "./terminal-host.mjs";
import { installOrbitMsg, mailboxGrant, terminalPaneEnv } from "./terminal-mailbox.mjs";

function fixture(mailbox, resolveCwd = async () => os.tmpdir()) {
  const spawned = [];
  const owner = { id: 1, isDestroyed: () => false, send: () => {} };
  const host = createTerminalHost({
    authorize: () => {},
    resolveCwd,
    mailbox,
    platform: "linux",
    env: { SHELL: "/bin/sh", PATH: "/usr/bin", ORBIT_PANE: "inherited", OMB_COMMS_TOKEN: "leak" },
    loadPty: () => ({ spawn: (_shell, _args, options) => {
      spawned.push(options.env);
      return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
    } }),
  });
  return { host, spawned, event: { sender: owner }, input: { botId: "bot-1", cols: 80, rows: 24 } };
}

describe("terminal pane env", () => {
  it("tags every pane and scopes the grant to it", async () => {
    const f = fixture(async () => ({ url: "http://127.0.0.1:8799", token: "secret", binDir: "/orbit/bin" }));
    const session = await f.host.open(f.event, f.input);
    const env = f.spawned[0];
    expect(env).toMatchObject({ ORBIT_PANE: session.id, ORBIT_BOT: "bot-1", ORBIT_TEACHER: "bot-1", ORBIT_URL: "http://127.0.0.1:8799" });
    expect(env.ORBIT_MSG_TOKEN).toBe(serverGrant("secret", session.id, "bot-1", "bot-1"));
    expect(env.ORBIT_MSG_TOKEN).not.toContain("secret");
    expect(env.OMB_COMMS_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(`/orbit/bin${path.delimiter}/usr/bin`);
  });

  it("still opens the pane when the mailbox is unavailable", async () => {
    const f = fixture(async () => { throw new Error("no server"); });
    const session = await f.host.open(f.event, f.input);
    expect(f.spawned[0]).toMatchObject({ ORBIT_PANE: session.id, ORBIT_BOT: "bot-1", ORBIT_TEACHER: "bot-1" });
    expect(f.spawned[0].ORBIT_URL).toBeUndefined();
    expect(f.spawned[0].ORBIT_MSG_TOKEN).toBeUndefined();
  });

  it("prepends to a Windows-cased Path key", () => {
    const env = terminalPaneEnv({ Path: "system" }, { pane: "p", bot: "b", mailbox: { url: "u", token: "t", binDir: "orbit-bin" } });
    expect(env.Path).toBe(`orbit-bin${path.delimiter}system`);
    expect(env.PATH).toBeUndefined();
  });

  it("binds ORBIT_TEACHER and the grant to the resolved chief", async () => {
    const f = fixture(async () => ({ url: "http://127.0.0.1:8799", token: "secret", binDir: "/orbit/bin" }),
      async () => ({ cwd: os.tmpdir(), source: "workspace", teacherId: "chief-1" }));
    const session = await f.host.open(f.event, f.input);
    const env = f.spawned[0];
    expect(env.ORBIT_TEACHER).toBe("chief-1");
    expect(env.ORBIT_MSG_TOKEN).toBe(serverGrant("secret", session.id, "bot-1", "chief-1"));
  });

  it("falls back to the bot when the resolved teacher is invalid", async () => {
    const f = fixture(async () => ({ url: "http://127.0.0.1:8799", token: "secret", binDir: "/orbit/bin" }),
      async () => ({ cwd: os.tmpdir(), source: "workspace", teacherId: "chief:1" }));
    const session = await f.host.open(f.event, f.input);
    const env = f.spawned[0];
    expect(env.ORBIT_TEACHER).toBe("bot-1");
    expect(env.ORBIT_MSG_TOKEN).toBe(serverGrant("secret", session.id, "bot-1", "bot-1"));
  });
});

describe("mailbox teacher routing", () => {
  const roster = [
    { id: "chief", section: "Team", chiefOfStaff: true },
    { id: "worker", section: "Team" },
    { id: "lone" },
    { id: "hidden-chief", section: "Ops", chiefOfStaff: true, hidden: true },
    { id: "ops-worker", section: "Ops" },
  ];

  it("routes a pane to its section chief", () => {
    expect(resolveMailboxTeacher(roster, "worker")).toBe("chief");
  });

  it("keeps a chief, a hidden-chief section and an unknown bot on itself", () => {
    expect(resolveMailboxTeacher(roster, "chief")).toBe("chief");
    expect(resolveMailboxTeacher(roster, "lone")).toBe("lone");
    expect(resolveMailboxTeacher(roster, "ops-worker")).toBe("ops-worker");
    expect(resolveMailboxTeacher(roster, "ghost")).toBe("ghost");
  });
});

// cmd splits argv on "=", so the -c pairs are matched on the raw line.
const FAKE_GIT_CMD = [
  "@echo off",
  'set "ARGS=%*"',
  'if defined ORBIT_FAKE_GIT_LOG >>"%ORBIT_FAKE_GIT_LOG%" echo %ARGS%',
  'if defined ORBIT_FAKE_GIT_LOG for %%v in (ORBIT_PANE ORBIT_BOT ORBIT_TEACHER ORBIT_URL ORBIT_MSG_TOKEN) do if defined %%v >>"%ORBIT_FAKE_GIT_LOG%" echo leaked %%v',
  'if "%ORBIT_FAKE_GIT%"=="norepo" exit /b 128',
  'if not "%ARGS:--abbrev-ref=%"=="%ARGS%" echo feat/widget& exit /b 0',
  'if not "%ARGS:--short=%"=="%ARGS%" echo abc1234& exit /b 0',
  'if not "%ARGS: status =%"=="%ARGS%" if "%ORBIT_FAKE_GIT%"=="dirty" echo M dirty.txt',
  "exit /b 0",
  "",
].join("\r\n");

function runOrbitMsg(env, bin, args, input = "") {
  return new Promise((resolve) => {
    const child = execFile("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(bin, "orbit-msg.ps1"), ...args], { env, encoding: "utf8", windowsHide: true },
      (_error, stdout, stderr) => resolve({ status: child.exitCode, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function withMailboxStub(handler) {
  const posts = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => { posts.push(JSON.parse(body)); res.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the stub listens on TCP, never a socket path.
  if (!address || typeof address === "string") throw new Error("no test port");
  try {
    await handler(`http://127.0.0.1:${address.port}`, posts);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function reportFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orbit-report-"));
  const fakebin = path.join(dir, "fakebin");
  mkdirSync(fakebin);
  writeFileSync(path.join(fakebin, "git.cmd"), FAKE_GIT_CMD);
  const bin = await installOrbitMsg(path.join(dir, "orbit-bin"), "win32");
  return { dir, fakebin, bin };
}

function reportEnv(url, fakebin, mode) {
  const env = terminalPaneEnv({ SystemRoot: process.env.SystemRoot, PATH: `${fakebin}${path.delimiter}${process.env.PATH}`, PATHEXT: process.env.PATHEXT, COMSPEC: process.env.COMSPEC }, {
    pane: "pane-1", bot: "worker-1", teacher: "chief-1", mailbox: { url, token: "test-token", binDir: null },
  });
  if (mode) env.ORBIT_FAKE_GIT = mode;
  return env;
}

describe.runIf(process.platform === "win32")("orbit-msg --report", () => {
  it("posts the header plus arg text with mocked git state", async () => {
    const f = await reportFixture();
    try {
      await withMailboxStub(async (url, posts) => {
        const run = await runOrbitMsg(reportEnv(url, f.fakebin, "dirty"), f.bin, ["--report", "DONE", "WIDGET", "shipped", "it"]);
        expect(run.status).toBe(0);
        expect(run.stderr).toBe("");
        expect(posts).toHaveLength(1);
        expect(posts[0].text).toBe("DONE WIDGET branch=feat/widget sha=abc1234 dirty=yes\nshipped it");
      });
    } finally {
      await removeTempDir(f.dir);
    }
  }, 30_000);

  it("reports a clean tree and reads the body from stdin", async () => {
    const f = await reportFixture();
    try {
      await withMailboxStub(async (url, posts) => {
        const run = await runOrbitMsg(reportEnv(url, f.fakebin), f.bin, ["--report", "FAIL", "WIDGET"], "piped body");
        expect(run.status).toBe(0);
        expect(posts).toHaveLength(1);
        expect(posts[0].text).toBe("FAIL WIDGET branch=feat/widget sha=abc1234 dirty=no\npiped body");
      });
    } finally {
      await removeTempDir(f.dir);
    }
  }, 30_000);

  it("falls back to none/unknown outside a repo without failing", async () => {
    const f = await reportFixture();
    try {
      await withMailboxStub(async (url, posts) => {
        const run = await runOrbitMsg(reportEnv(url, f.fakebin, "norepo"), f.bin, ["--report", "BLOCKED", "WIDGET"]);
        expect(run.status).toBe(0);
        expect(posts).toHaveLength(1);
        expect(posts[0].text).toBe("BLOCKED WIDGET branch=none sha=none dirty=unknown");
      });
    } finally {
      await removeTempDir(f.dir);
    }
  }, 30_000);

  it("hides the pane grant from git and disables its hooks and fsmonitor", async () => {
    const f = await reportFixture();
    try {
      await withMailboxStub(async (url, posts) => {
        const env = { ...reportEnv(url, f.fakebin, "dirty"), ORBIT_FAKE_GIT_LOG: path.join(f.dir, "git.log") };
        const run = await runOrbitMsg(env, f.bin, ["--report", "DONE", "WIDGET"]);
        expect(run.status).toBe(0);
        expect(posts[0].text).toBe("DONE WIDGET branch=feat/widget sha=abc1234 dirty=yes");
        const calls = readFileSync(env.ORBIT_FAKE_GIT_LOG, "utf8").trim().split(/\r?\n/);
        expect(calls).toHaveLength(3);
        for (const call of calls) expect(call).toMatch(/^-c core\.fsmonitor=false -c core\.hooksPath=NUL (rev-parse|status) /);
      });
    } finally {
      await removeTempDir(f.dir);
    }
  }, 30_000);

  it("rejects a bad status or missing nick", async () => {
    const f = await reportFixture();
    try {
      await withMailboxStub(async (url, posts) => {
        const env = reportEnv(url, f.fakebin);
        const badStatus = await runOrbitMsg(env, f.bin, ["--report", "MAYBE", "WIDGET"]);
        expect(badStatus.status).toBe(1);
        expect(badStatus.stderr).toContain("usage: orbit-msg --report");
        expect(await runOrbitMsg(env, f.bin, ["--report", "DONE"])).toMatchObject({ status: 1 });
        expect(posts).toHaveLength(0);
      });
    } finally {
      await removeTempDir(f.dir);
    }
  }, 30_000);
});

describe("installOrbitMsg", () => {
  it("removes its temp file when the rename fails", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orbit-install-"));
    try {
      mkdirSync(path.join(dir, "orbit-msg.ps1", "blocker"), { recursive: true });
      await expect(installOrbitMsg(dir, "win32")).rejects.toThrow();
      expect(readdirSync(dir)).toEqual(["orbit-msg.ps1"]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("writes the ps1 plus cmd and sh wrappers", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orbit-install-"));
    try {
      const bin = await installOrbitMsg(path.join(dir, "orbit-bin"), "win32");
      expect(readdirSync(bin).sort()).toEqual(["orbit-msg", "orbit-msg.cmd", "orbit-msg.ps1"]);
      const cmd = readFileSync(path.join(bin, "orbit-msg.cmd"), "utf8");
      expect(cmd).toContain("orbit-msg.ps1");
      expect(cmd).toMatch(/\r\n/);
      expect(cmd).not.toMatch(/[^\r]\n/);
      const sh = readFileSync(path.join(bin, "orbit-msg"), "utf8");
      expect(sh).toMatch(/^#!\/bin\/sh\n/);
      expect(sh).toContain("orbit-msg.ps1");
      expect(sh).not.toContain("\r");
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("mailbox grant", () => {
  it("refuses ids that could forge another triple", () => {
    expect(() => mailboxGrant("t", "a:b", "c", "d")).toThrow(/grant/);
  });
});
