import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the status Bash resolver prefers the override and installed Git and rejects WSL", { skip: !WIN32, timeout: 30_000 }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = readFileSync(path.join(bin, "orbit-status.ps1"), "utf8");
  const resolver = script.match(/function Get-StatusBash \{[\s\S]*?\r?\n\}/)?.[0];
  assert.ok(resolver, "status wrapper must define its Bash resolver");
  const git = "C:\\Program Files\\Git\\cmd\\git.exe";
  const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const wsl = "C:\\Windows\\System32\\bash.exe";
  const fallback = "D:\\tools\\bash.exe";
  const cases = [
    { override: fallback, git, paths: [wsl], files: [bash], expected: fallback },
    { override: "", git, paths: [wsl], files: [bash], expected: bash },
    { override: "", git: "", paths: [wsl, fallback], files: [], expected: fallback },
    { override: "", git: "", paths: [wsl], files: [], expected: "" },
    { override: wsl, git, paths: [wsl], files: [bash], expected: bash },
  ];
  const data = Buffer.from(JSON.stringify(cases)).toString("base64");
  const probe = path.join(dir, "resolver.ps1");
  writeFileSync(probe, `${resolver}
function Get-Command {
  [CmdletBinding()] param($Name, [switch]$All)
  if ($Name -eq 'git.exe' -and $case.git) { [pscustomobject]@{ Source = $case.git } }
  if ($Name -eq 'bash.exe') { $case.paths | ForEach-Object { [pscustomobject]@{ Source = $_ } } }
}
function Test-Path { param($LiteralPath) $case.files -contains $LiteralPath }
$cases = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
foreach ($case in $cases) {
  $env:CLAUDE_CODE_GIT_BASH_PATH = $case.override
  [Console]::WriteLine([string](Get-StatusBash))
}
`);
  const out = await runPs1Direct({ ps1: probe, env: process.env, args: [] });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, "");
  assert.deepEqual(out.stdout.replace(/\r/g, "").split("\n").slice(0, -1), cases.map((entry) => entry.expected));
});

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
  assert.match(sh, /^#!\/bin\/bash\n/);
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

test("a failed --report leaves its error line in the report signal", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "pane is not open" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const signal = path.join(dir, "report-signal");
  const env = paneEnv(bin, `http://127.0.0.1:${server.address().port}`, { ORBIT_REPORT_SIGNAL: signal });
  const ps1 = path.join(bin, "orbit-msg.ps1");
  const note = await runPs1Direct({ ps1, env, args: ["plain"] });
  assert.equal(note.status, 1);
  assert.equal(existsSync(signal), false);
  const report = await runPs1Direct({ ps1, env, args: ["--report", "DONE", "WIDGET", "text"] });
  assert.equal(report.status, 1);
  assert.equal(readFileSync(signal, "utf8"), "orbit-msg: pane is not open");
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

function runEncoded({ env, command, input = "" }) {
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'; ${command}; exit $LASTEXITCODE`, "utf16le").toString("base64");
  return new Promise((resolve) => {
    const child = execFile(
      "powershell",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { env, encoding: "utf8", windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin?.end(input);
  });
}

function runCmdArgs({ cwd, env, args, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/q", "/c", "orbit-msg.cmd", ...args], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ out, err, code }));
    child.stdin.end(input ?? "");
  });
}

test("piped bare powershell posts the pipeline when stdin is empty", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await withMailboxStub(async (url, posts) => {
    const run = await runEncoded({ env: paneEnv(bin, url), command: "'piped' | orbit-msg" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(posts[0]?.text, "piped");
  });
});

test("a dash inside text stays, and a lone dash still reads stdin", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await withMailboxStub(async (url, posts) => {
    const env = paneEnv(bin, url);
    const dashed = await runCmdArgs({ cwd: dir, env, args: ["a", "-", "b"] });
    assert.equal(dashed.code, 0, dashed.err);
    const lone = await runCmdArgs({ cwd: dir, env, args: ["-"], input: "from-stdin" });
    assert.equal(lone.code, 0, lone.err);
    const report = await runCmdArgs({ cwd: dir, env, args: ["--report", "DONE", "NICK", "-"], input: "report-body" });
    assert.equal(report.code, 0, report.err);
    assert.equal(posts[0]?.text, "a - b");
    assert.equal(posts[1]?.text, "from-stdin");
    assert.equal(posts[2]?.kind, "report");
    assert.match(posts[2]?.text ?? "", /report-body/);
    if (!HAS_BASH) return;
    const sh = path.join(bin, "orbit-msg");
    const viaSh = await runShDirect({ sh, env, args: ["a", "-", "b"] });
    assert.equal(viaSh.status, 0, viaSh.stderr);
    const shLone = await runShDirect({ sh, env, args: ["-"], input: "sh-stdin" });
    assert.equal(shLone.status, 0, shLone.stderr);
    assert.equal(posts[3]?.text, "a - b");
    assert.equal(posts[4]?.text, "sh-stdin");
  });
});

function runCompact(bin, part, input) {
  return new Promise((resolve) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(bin, "orbit-compact.ps1"), part],
      { encoding: "buffer", windowsHide: true, timeout: 60_000 },
      (error, stdout) => resolve({ status: error?.code ?? 0, out: stdout.toString("utf8") }));
    child.stdin.end(input);
  });
}

async function compactFixture(t, { card = "# TASK\nDo the thing.\n", progress, lines }) {
  const { dir, bin } = await installBin();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cards = path.join(dir, "my cards");
  mkdirSync(cards);
  const cardPath = path.join(cards, "TASK.md");
  writeFileSync(cardPath, card);
  const progressPath = path.join(cards, "TASK.progress.md");
  if (progress !== undefined) writeFileSync(progressPath, progress);
  const transcript = path.join(dir, "session.jsonl");
  const rows = lines ?? [userLine(`Read ${cardPath} and do it.`)];
  writeFileSync(transcript, `${rows.join("\n")}\n`);
  const hook = JSON.stringify({ session_id: "s", transcript_path: transcript, cwd: dir, hook_event_name: "SessionStart", source: "compact" });
  return { dir, bin, cards, cardPath, progressPath, transcript, hook };
}

const userLine = (content) => JSON.stringify({ type: "user", message: { role: "user", content } });
const queuedLine = (prompt) => JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt } });

test("compact hook prints the card, then the progress file", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const f = await compactFixture(t, { progress: "## Done\n- step one\n" });
  const card = await runCompact(f.bin, "card", f.hook);
  assert.equal(card.status, 0);
  assert.equal(card.out, `Context was just compacted. Your card follows word for word; its follow-ups and progress file come in a second note.\n\nCard: ${f.cardPath}\n# TASK\nDo the thing.\n`);
  const progress = await runCompact(f.bin, "progress", f.hook);
  assert.equal(progress.status, 0);
  assert.equal(progress.out, `Context was just compacted. The follow-ups and progress file for ${f.cardPath} follow word for word.\n\nProgress: ${f.progressPath}\n## Done\n- step one\n`);
});

test("compact hook lists follow-ups in order and skips quoted prompts", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const f = await compactFixture(t, { progress: "p" });
  const b = path.join(f.cards, "TASK-B.md");
  const c = path.join(f.cards, "TASK-C.md");
  writeFileSync(b, `${"b".repeat(1500)}\n`);
  writeFileSync(c, "c follow-up\n");
  writeFileSync(path.join(f.cards, "QUOTED.md"), "never");
  writeFileSync(f.transcript, `${[
    userLine(`Read ${f.cardPath} and do it.`),
    userLine([{ type: "tool_result", content: `Read ${path.join(f.cards, "QUOTED.md")} and do it.` }]),
    userLine(`This session is being continued. Read ${path.join(f.cards, "QUOTED.md")} and do it.`),
    queuedLine(`Read ${b} and do it as part of this card.`),
    userLine([{ type: "text", text: `Read ${c} and do it.` }]),
    userLine(`Read ${b} and do it.`),
  ].join("\n")}\n`);
  const { out } = await runCompact(f.bin, "progress", f.hook);
  assert.equal(out, [
    `Context was just compacted. The follow-ups and progress file for ${f.cardPath} follow word for word.`,
    "",
    `Follow-up: ${b}\n${"b".repeat(1000)}\n[cut] Read ${b} for the rest.`,
    "",
    `Follow-up: ${c}\nc follow-up\n`,
    "",
    `Progress: ${f.progressPath}\np`,
  ].join("\n"));
  assert.doesNotMatch(out, /QUOTED/);
  assert.match((await runCompact(f.bin, "card", f.hook)).out, /\nCard: .*TASK\.md\n# TASK\n/);
});

test("compact hook says when there is no progress file yet", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const f = await compactFixture(t, {});
  const { status, out } = await runCompact(f.bin, "progress", f.hook);
  assert.equal(status, 0);
  assert.equal(out, `Context was just compacted. The follow-ups and progress file for ${f.cardPath} follow word for word.\n\nProgress: ${f.progressPath}\nNo progress file yet.`);
});

test("compact hook stays silent without a card or on bad input", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const f = await compactFixture(t, { progress: "p", lines: [userLine("fix the bug"), "{not json and do it \"content\":\"Read x.md and do it", queuedLine("Read notes.txt and do it.")] });
  const missing = await compactFixture(t, { lines: [userLine(`Read ${path.join(os.tmpdir(), "orbit-no-such-card.md")} and do it.`)] });
  for (const part of ["card", "progress"]) {
    for (const hook of [f.hook, "{not json", JSON.stringify({ transcript_path: path.join(f.dir, "gone.jsonl"), cwd: f.dir }), "{}"]) {
      assert.deepEqual(await runCompact(f.bin, part, hook), { status: 0, out: "" });
    }
  }
  for (const part of ["card", "progress"]) assert.deepEqual(await runCompact(missing.bin, part, missing.hook), { status: 0, out: "" });
});

test("compact hook keeps Korean intact", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const f = await compactFixture(t, { card: "# 작업\n버그를 고친다.\n", progress: "## 완료\n- 첫 단계 끝\n" });
  assert.match((await runCompact(f.bin, "card", f.hook)).out, /\n# 작업\n버그를 고친다\.\n$/);
  assert.match((await runCompact(f.bin, "progress", f.hook)).out, /\n## 완료\n- 첫 단계 끝\n$/);
});

test("compact hook reads past huge and malformed lines and cuts each part under 9,900 chars", { skip: !WIN32, timeout: LIVE_TIMEOUT }, async (t) => {
  const f = await compactFixture(t, { card: `${"c".repeat(12_000)}CARD-END`, progress: `PROGRESS-START${"p".repeat(12_000)}\n- last step\n` });
  const huge = "x".repeat(600_000);
  writeFileSync(f.transcript, `${[
    userLine([{ type: "tool_result", content: `${huge} and do it` }]),
    userLine([{ type: "tool_result", content: `Read ${huge}.md and do it` }]),
    `{"type":"user","message":{"content":"Read ${huge} and do it`,
    "",
    userLine(`Read ${f.cardPath} and do it.`),
    userLine([{ type: "tool_result", content: huge }]),
  ].join("\n")}\n`);
  const card = await runCompact(f.bin, "card", f.hook);
  assert.ok(card.out.length <= 9900 && card.out.length > 9800, String(card.out.length));
  assert.ok(card.out.endsWith(`c\n[cut] Read ${f.cardPath} for the rest.`));
  assert.doesNotMatch(card.out, /CARD-END/);
  const progress = await runCompact(f.bin, "progress", f.hook);
  assert.ok(progress.out.length <= 9900 && progress.out.length > 9800, String(progress.out.length));
  assert.doesNotMatch(progress.out, /PROGRESS-START/);
  assert.ok(progress.out.includes(`Progress: ${f.progressPath}\n[cut] Read ${f.progressPath} for the start.\np`));
  assert.ok(progress.out.endsWith("p\n- last step\n"));
});
