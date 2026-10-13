import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installOrbitMsg } from "./terminal-mailbox.mjs";

const WIN32 = process.platform === "win32";
const LIVE_TIMEOUT = 180_000;

async function installBin() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orbit-msg-shim-"));
  const bin = await installOrbitMsg(path.join(dir, "orbit-bin"), "win32");
  return { dir, bin };
}

function readBin(bin) {
  return {
    cmd: readFileSync(path.join(bin, "orbit-msg.cmd"), "utf8"),
    ps1: readFileSync(path.join(bin, "orbit-msg.ps1"), "utf8"),
    sh: readFileSync(path.join(bin, "orbit-msg"), "utf8"),
  };
}

function paneEnv(bin, url, overrides = {}) {
  return {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    ORBIT_PANE: "pane-1",
    ORBIT_BOT: "bot-1",
    ORBIT_TEACHER: "bot-1",
    ORBIT_URL: url,
    ORBIT_MSG_AUTH: "test-token",
    ...overrides,
  };
}

async function withMailboxStub(handler) {
  const posts = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { posts.push(JSON.parse(body)); } catch {}
      res.end("{}");
    });
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

function runCmdLines({ cwd, env, lines }) {
  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/q"], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ out, err, code }));
    for (const line of lines) child.stdin.write(`${line}\r\n`);
    child.stdin.write("exit\r\n");
  });
}

function runPs1Direct({ ps1, env, args, input }) {
  return new Promise((resolve) => {
    const child = execFile("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args],
      { env, encoding: "utf8", windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }));
    child.stdin?.end(input);
  });
}

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

function runShDirect({ sh, env, args, input }) {
  return new Promise((resolve, reject) => {
    const child = execFile(GIT_BASH, ["-c", 'exec "$0" "$@"', sh, ...args], { env, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => (error && error.code === "ENOENT" ? reject(error) : resolve({ status: error?.code ?? 0, stdout, stderr })));
    if (input !== undefined) child.stdin?.end(input);
  });
}

test("cmd wrapper forwards each argument after parse, never percent-star", async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cmd, ps1 } = readBin(bin);
  assert.doesNotMatch(cmd, /%\*/);
  assert.match(cmd, /%~1/);
  const disableAt = cmd.indexOf("setlocal DisableDelayedExpansion");
  const captureAt = cmd.indexOf('set "A%N%=%~1"');
  const enableAt = cmd.indexOf("setlocal EnableDelayedExpansion");
  const useAt = cmd.indexOf("!ORBIT_MSG_FWD!");
  assert.ok(disableAt !== -1 && disableAt < captureAt && captureAt < enableAt && enableAt < useAt);
  const fileLines = cmd.split(/\r?\n/).filter((line) => line.includes("-File"));
  assert.equal(fileLines.length, 2);
  for (const line of fileLines) {
    assert.match(line, /-File "!ORBIT_MSG_PS1!" !ORBIT_MSG_FWD!/);
    assert.doesNotMatch(line, /%\*/);
  }
  assert.doesNotMatch(ps1, /ORBIT_MSG_FWD/);
});

test("generated wrappers keep their line endings", async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { cmd, sh } = readBin(bin);
  assert.match(cmd, /\r\n/);
  assert.doesNotMatch(cmd, /[^\r]\n/);
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(sh, /\r/);
});

test("cmd posts & literally without executing it", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await withMailboxStub(async (url, posts) => {
    const run = await runCmdLines({ cwd: dir, env: paneEnv(bin, url), lines: ["orbit-msg.cmd note ^& echo MARKER"] });
    assert.deepEqual(posts.map((p) => p.text), ["note & echo MARKER"]);
    assert.doesNotMatch(run.out, /MARKER/);
  });
});

test("cmd preserves quotes, percents, bangs, carets, pipes and redirects", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const table = [
    ["hello world", "hello world"],
    ["a ^| b", "a | b"],
    ["a ^> b", "a > b"],
    ["100%", "100%"],
    ["50% off", "50% off"],
    ["%ORBIT_TEST_UNDEFINED_VAR_XYZ%", "%ORBIT_TEST_UNDEFINED_VAR_XYZ%"],
    ["hello!", "hello!"],
    ["a!b!c", "a!b!c"],
    ["a ^^ b", "a ^ b"],
    ["a^^b", "a^b"],
    ['"hello world"', "hello world"],
    ['say "hi" there', "say hi there"],
    ["don't", "don't"],
    ["x ^&^& echo PWN2", "x && echo PWN2"],
    ["x ^|^| echo PWN3", "x || echo PWN3"],
    ["a) echo PWN4 (", "a) echo PWN4 ("],
  ];
  await withMailboxStub(async (url, posts) => {
    const run = await runCmdLines({ cwd: dir, env: paneEnv(bin, url), lines: table.map(([typed]) => `orbit-msg.cmd ${typed}`) });
    assert.deepEqual(posts.map((p) => p.text), table.map(([, want]) => want));
    for (const marker of ["PWN2", "PWN3", "PWN4"]) assert.doesNotMatch(run.out, new RegExp(marker));
  });
});

test("cmd keeps --report flags, stdin and exit codes", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, "stdin.txt");
  writeFileSync(input, "piped body");
  await withMailboxStub(async (url, posts) => {
    const run = await runCmdLines({
      cwd: dir,
      env: paneEnv(bin, url),
      lines: ["orbit-msg.cmd --report DONE WIDGET some text", `orbit-msg.cmd < "${input}"`],
    });
    assert.equal(posts.length, 2);
    assert.match(posts[0].text, /^DONE WIDGET branch=\S+ sha=\S+ dirty=\S+\nsome text$/);
    assert.equal(posts[1].text, "piped body");
    assert.doesNotMatch(run.err, /orbit-msg/);
  });
  await withMailboxStub(async (url, posts) => {
    const env = paneEnv(bin, url);
    delete env.ORBIT_URL;
    const run = await runCmdLines({ cwd: dir, env, lines: ["orbit-msg.cmd note ^& echo MARKER", "echo ERR=%errorlevel%"] });
    assert.deepEqual(posts, []);
    assert.doesNotMatch(run.out, /MARKER/);
    assert.match(run.out, /ERR=1/);
  });
});

test("powershell path posts identical text", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await withMailboxStub(async (url, posts) => {
    const direct = await runPs1Direct({ ps1: path.join(bin, "orbit-msg.ps1"), env: paneEnv(bin, url), args: ["note", "&", "echo", "MARKER"] });
    assert.equal(direct.status, 0);
    const viaCmd = await runCmdLines({ cwd: dir, env: paneEnv(bin, url), lines: ["orbit-msg.cmd note ^& echo MARKER"] });
    assert.doesNotMatch(viaCmd.out, /MARKER/);
    assert.deepEqual(posts.map((p) => p.text), ["note & echo MARKER", "note & echo MARKER"]);
  });
});

test("powershell accepts the legacy pane grant", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await withMailboxStub(async (url, posts) => {
    const env = paneEnv(bin, url, { ORBIT_MSG_AUTH: undefined, ORBIT_MSG_TOKEN: "test-token" });
    const run = await runPs1Direct({ ps1: path.join(bin, "orbit-msg.ps1"), env, args: ["legacy"] });
    assert.equal(run.status, 0);
    assert.deepEqual(posts.map((p) => p.text), ["legacy"]);
  });
});

test("powershell marks report and hook/notify posts, leaves plain notes unmarked", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ps1 = path.join(bin, "orbit-msg.ps1");
  await withMailboxStub(async (url, posts) => {
    const env = paneEnv(bin, url);
    await runPs1Direct({ ps1, env, args: ["plain"] });
    await runPs1Direct({ ps1, env, args: ["--report", "DONE", "WIDGET", "text"] });
    await runPs1Direct({ ps1, env, args: ["--hook", "last_assistant_message"], input: JSON.stringify({ last_assistant_message: "from hook" }) });
    await runPs1Direct({ ps1, env, args: ["--notify", "last-assistant-message", JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "from notify" })] });
    assert.deepEqual(posts.map((p) => p.kind), [undefined, "report", "auto", "auto"]);
    assert.deepEqual(posts.slice(2).map((p) => p.text), ["from hook", "from notify"]);
  });
});

test("powershell notify posts only turn-complete events with text", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ps1 = path.join(bin, "orbit-msg.ps1");
  await withMailboxStub(async (url, posts) => {
    const env = paneEnv(bin, url);
    for (const event of [
      { title: "Implement REPS audit" },
      { type: "thread-title-updated", "last-assistant-message": "not a report" },
      { type: "agent-turn-complete", "last-assistant-message": "  " },
      { type: "agent-turn-complete" },
      { type: "agent-turn-complete", "last-assistant-message": "{\"title\":\"Complete WINK audit\"}" },
      { type: "agent-turn-complete", "last-assistant-message": "real report" },
      { type: "agent-turn-complete", "last-assistant-message": "Renamed to {\"title\":\"x\"} as asked" },
    ]) {
      await runPs1Direct({ ps1, env, args: ["--notify", "last-assistant-message", JSON.stringify(event)] });
    }
    assert.deepEqual(posts.map((p) => p.text), ["real report", "Renamed to {\"title\":\"x\"} as asked"]);
  });
});

const HAS_BASH = WIN32 && existsSync(GIT_BASH);

test("sh path posts identical text", { skip: !HAS_BASH, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await withMailboxStub(async (url, posts) => {
    const viaSh = await runShDirect({ sh: path.join(bin, "orbit-msg"), env: paneEnv(bin, url), args: ["note & echo MARKER"] });
    assert.equal(viaSh.status, 0);
    assert.deepEqual(posts.map((p) => p.text), ["note & echo MARKER"]);
  });
});

const SPECIAL = "a | b & c < d > e ^ f \" g % h ! i'j\nline2";

function runBarePs({ env, command, input }) {
  return new Promise((resolve) => {
    const child = execFile(
      "powershell",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { env, encoding: "utf8", windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin?.end(input);
  });
}

test("special text arrives intact via bare powershell, --file, stdin and bash", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "body.txt");
  writeFileSync(file, SPECIAL, "utf8");
  await withMailboxStub(async (url, posts) => {
    const env = { ...paneEnv(bin, url), ORBIT_PROBE_TEXT: SPECIAL };
    const bare = await runBarePs({
      env,
      command: [
        "$cmd = Get-Command orbit-msg -ErrorAction Stop",
        "[Console]::Error.WriteLine('WHICH=' + $cmd.Source)",
        "orbit-msg $env:ORBIT_PROBE_TEXT",
        "exit $LASTEXITCODE",
      ].join("\n"),
    });
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stderr, /WHICH=.*orbit-msg\.ps1\s*$/);
    assert.equal(posts[0]?.text, SPECIAL);
    const viaFile = await runPs1Direct({ ps1: path.join(bin, "orbit-msg.ps1"), env: paneEnv(bin, url), args: ["--file", file] });
    assert.equal(viaFile.status, 0, viaFile.stderr);
    assert.equal(posts[1]?.text, SPECIAL);
    const viaDash = await runBarePs({
      env: paneEnv(bin, url),
      command: "orbit-msg -\nexit $LASTEXITCODE\n",
      input: SPECIAL,
    });
    assert.equal(viaDash.status, 0, viaDash.stderr);
    assert.equal(posts[2]?.text, SPECIAL);
  });
  if (!HAS_BASH) return;
  await withMailboxStub(async (url, posts) => {
    const env = paneEnv(bin, url);
    const sh = path.join(bin, "orbit-msg");
    const viaArg = await runShDirect({ sh, env, args: [SPECIAL] });
    assert.equal(viaArg.status, 0, viaArg.stderr);
    const viaFile = await runShDirect({ sh, env, args: ["--file", file] });
    assert.equal(viaFile.status, 0, viaFile.stderr);
    const viaDash = await runShDirect({ sh, env, args: ["-"], input: SPECIAL });
    assert.equal(viaDash.status, 0, viaDash.stderr);
    assert.deepEqual(posts.map((p) => p.text), [SPECIAL, SPECIAL, SPECIAL]);
  });
});

test("cmd posts a quoted metacharacter message intact", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const want = "a | b & c < d > e ^ f \" g % h ! i'j";
  await withMailboxStub(async (url, posts) => {
    const run = await runCmdLines({
      cwd: dir,
      env: paneEnv(bin, url),
      lines: ["orbit-msg.cmd \"a | b & c < d > e ^ f \"\" g % h ! i'j\""],
    });
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(posts.map((p) => p.text), [want]);
  });
});

test("--file and a lone dash are the message, and a bad file fails loudly", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ps1 = path.join(bin, "orbit-msg.ps1");
  const file = path.join(dir, "body.txt");
  writeFileSync(file, SPECIAL, "utf8");
  await withMailboxStub(async (url, posts) => {
    const env = paneEnv(bin, url);
    const missing = await runPs1Direct({ ps1, env, args: ["--file", path.join(dir, "missing.txt")] });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^orbit-msg: cannot read file .+\r?\n$/);
    const bareFile = await runPs1Direct({ ps1, env, args: ["--file"] });
    assert.equal(bareFile.status, 1);
    assert.match(bareFile.stderr, /^orbit-msg: --file needs one path and no other message text\r?\n$/);
    const mixed = await runPs1Direct({ ps1, env, args: ["--file", file, "extra"] });
    assert.equal(mixed.status, 1);
    assert.equal(posts.length, 0);
    const viaCmd = await runCmdLines({ cwd: dir, env, lines: [`orbit-msg.cmd --file "${file}"`] });
    assert.equal(viaCmd.code, 0, viaCmd.err);
    assert.deepEqual(posts.map((p) => p.text), [SPECIAL]);
  });
});
