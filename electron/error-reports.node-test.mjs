import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";

const scratch = path.join(os.tmpdir(), "wink-REPORTS-FIX");
fs.mkdirSync(scratch, { recursive: true });
const privateText = ["민수", "민수".normalize("NFD"), "C:\\사용자\\민수\\비밀.txt", "\\\\nas\\private\\secret.txt", "/home/minsu/private.txt", "비밀 대화를 요약해 줘", "secret-token-123", "../../malicious?secret=123"];

async function fixture(t, options = {}) {
  const { createErrorReports } = await import("./error-reports.mjs");
  const dir = fs.mkdtempSync(path.join(scratch, "reports-"));
  const received = [];
  let status = 200;
  let retryAfter;
  let hold = false;
  const receiver = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (hold) return;
      res.writeHead(status, retryAfter ? { "retry-after": retryAfter } : {});
      res.end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  let time = Date.UTC(2026, 9, 28, 1, 23, 45);
  const config = { userData: dir, dsn: `http://public@127.0.0.1:${receiver.address().port}/1`, build: "1.0.212", platform: "win32", arch: "x64", now: () => time, uptime: () => 100, ...options };
  const reporters = [];
  const open = () => {
    const reporter = createErrorReports(config);
    reporters.push(reporter);
    return reporter;
  };
  const reporter = open();
  t.after(async () => {
    reporters.forEach((item) => item.stop());
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, reporter, received, open, config, advance: (ms) => { time += ms; }, status: (code, retry) => { status = code; retryAfter = retry; }, hold: () => { hold = true; }, queue: () => JSON.parse(fs.readFileSync(path.join(dir, "error-report-queue.json"), "utf8")) };
}

const failure = { process: "renderer", code: "UNKNOWN_ERROR", site: 1 };

const source = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

test("only the bus's canonical log failure is reported from runtime.error", () => {
  const bus = source("../server/harness/bus.ts");
  const message = bus.match(/INCOMPLETE_LOG_MESSAGE\s*=\s*\n?\s*"([^"]+)"/)[1];
  const branch = source("../server/index.ts").split('case "runtime.error":')[1].split('case "thread.token-usage.updated":')[0].replace(/break;\s*$/, "");
  const calls = [];
  const run = new Function("event", "reportServerFailure", "terminalBridgeAccess", "INCOMPLETE_LOG_MESSAGE", "unreadTurns", "store", "pushMessage", "bot", branch);
  for (const event of [
    { message: "usage limit", usageLimit: { resetsAt: null } }, { message: "sign in", signIn: true },
    { message: "setup", setup: true }, { message: "CLI not found" }, { message: "Permission request timed out" },
    { message: "provider offline" }, { message },
  ]) run(event, () => calls.push(event), null, message, { start() {} }, { messagesFor: () => [] }, () => {}, null);
  assert.deepEqual(calls, [{ message }]);
});

test("session-end invokes marker cleanup as well as the close guard", () => {
  const main = source("./main.mjs");
  const wiring = main.split("\n").filter((line) => line.includes('win.on("session-end"')).join("\n");
  const win = new EventEmitter();
  const calls = [];
  runInNewContext(wiring, { win, closeGuard: { leave: () => calls.push("leave") }, errorReports: { stop: () => calls.push("stop") } });
  win.emit("session-end");
  assert.deepEqual(calls, ["leave", "stop"]);
});

test("captures coalesce in memory and a flush writes each state file at most once", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  const rename = fs.renameSync;
  const writes = [];
  fs.renameSync = (from, to) => { writes.push(path.basename(to)); return rename(from, to); };
  try {
    for (let i = 0; i < 1000; i++) f.reporter.capture(failure);
    assert.deepEqual(writes, []);
    await f.reporter.flush();
    assert.equal(JSON.parse(f.received[0].body).extra.count, 1000);
    assert.deepEqual(writes.sort(), ["error-report-budget.json", "error-report-queue.json"]);
  } finally { fs.renameSync = rename; }
});

test("idle and capped ticks write nothing, including a day rollover without records", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  const rename = fs.renameSync;
  const writes = [];
  fs.renameSync = (from, to) => { writes.push(to); return rename(from, to); };
  try {
    await f.reporter.flush();
    f.advance(24 * 3600000);
    await f.reporter.flush();
    assert.deepEqual(writes, []);
    fs.writeFileSync(path.join(f.dir, "error-report-budget.json"), JSON.stringify({ day: Math.floor(Date.UTC(2026, 9, 29, 1, 23, 45) / 86400000), uploads: 5, nextUpload: 0 }));
    const capped = f.open();
    capped.capture(failure);
    await capped.flush();
    writes.length = 0;
    await capped.flush();
    assert.deepEqual(writes, []);
  } finally { fs.renameSync = rename; }
});

test("marker and purge failures return the consent actually persisted on disk", async (t) => {
  const f = await fixture(t);
  f.reporter.start();
  fs.mkdirSync(path.join(f.dir, "error-report-active"));
  assert.equal(f.reporter.setConsent(true), true);
  assert.equal(f.reporter.consent(), true);
  fs.mkdirSync(path.join(f.dir, "error-report-queue.json"));
  assert.equal(f.reporter.setConsent(false), false);
  assert.equal(f.reporter.consent(), false);
  f.reporter.capture(failure);
  await f.reporter.flush();
  assert.equal(f.received.length, 0);
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => { if (String(file).includes("error-report-consent.json")) throw new Error("locked consent"); return write(file, ...args); };
  try {
    assert.throws(() => f.reporter.setConsent(true), /locked consent/);
    assert.equal(f.reporter.consent(), false);
  } finally { fs.writeFileSync = write; }
});

test("renderer disappearance is limited to a failed main-window webContents", async () => {
  const { installErrorReportCapture } = await import("./error-report-capture.mjs");
  const app = new EventEmitter();
  const captures = [];
  let owner = {};
  installErrorReportCapture(app, { capture: (value) => captures.push(value) }, () => owner);
  app.emit("render-process-gone", {}, {}, { reason: "crashed", exitCode: 9 });
  app.emit("render-process-gone", {}, owner, { reason: "clean-exit", exitCode: 0 });
  assert.deepEqual(captures, []);
  app.emit("render-process-gone", {}, owner, { reason: "crashed", exitCode: 9 });
  assert.deepEqual(captures, [{ process: "renderer", code: "RENDERER_GONE", site: 3, exitCode: 9 }]);
  owner = null;
  app.emit("render-process-gone", {}, {}, { reason: "crashed" });
  assert.equal(captures.length, 1);
  assert.match(source("./main.mjs"), /installErrorReportCapture\(app, errorReports, \(\) => mainWindow\?\.webContents\)/);
});

test("CI's electron node-test group includes the reporting suite", () => {
  const pkg = JSON.parse(source("../package.json"));
  const ci = source("../.github/workflows/ci.yml");
  assert.ok(Object.entries(pkg.scripts).some(([name, command]) => command.includes("electron/error-reports.node-test.mjs") && ci.includes(`pnpm ${name}`)));
});

test("no endpoint makes error-reports:get unavailable", async (t) => {
  const { registerErrorReportIpc } = await import("./error-report-capture.mjs");
  const f = await fixture(t, { dsn: "" });
  const frame = { url: "http://127.0.0.1:9311/" };
  const owner = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  const handlers = new Map();
  registerErrorReportIpc({ handle: (name, callback) => handlers.set(name, callback), on() {} }, f.reporter, () => owner, () => "http://127.0.0.1:9311");
  assert.equal(handlers.get("error-reports:get")({ sender: owner, senderFrame: frame }), null);
});

test("release and dev builds bake the repo DSN variable, including empty and unset values", (t) => {
  for (const file of ["release.yml", "dev-build.yml"]) {
    const workflow = source(`../.github/workflows/${file}`);
    assert.match(workflow, /ERROR_REPORT_DSN: \$\{\{ vars\.ERROR_REPORT_DSN \}\}/);
    assert.ok(workflow.indexOf("node scripts/write-error-report-config.mjs") < workflow.indexOf("- run: pnpm package:win"));
  }
  const dir = fs.mkdtempSync(path.join(scratch, "config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "config.json");
  for (const value of [undefined, "", " https://public@reports.example/1 "]) {
    const env = { ...process.env };
    if (value === undefined) delete env.ERROR_REPORT_DSN;
    else env.ERROR_REPORT_DSN = value;
    const result = spawnSync(process.execPath, ["scripts/write-error-report-config.mjs", target], { env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { dsn: value?.trim() ?? "" });
  }
});

test("Start Fresh removes consent and the next reporter is off", async (t) => {
  const { applyStartFresh, requestStartFresh } = await import("./start-fresh.mjs");
  const f = await fixture(t);
  const dataDir = path.join(f.dir, "data");
  fs.mkdirSync(dataDir);
  f.reporter.setConsent(true);
  requestStartFresh({ dataDir });
  const result = await applyStartFresh({ dataDir, userData: f.dir, clearUiState: async () => {} });
  assert.equal(result.status, "reset");
  assert.equal(f.open().consent(), false);
  assert.equal(fs.existsSync(path.join(f.dir, "error-report-consent.json")), false);
});

test("own startup kills skip SERVER_GONE but child crashes still report", async () => {
  const main = source("./main.mjs");
  const body = main.slice(main.indexOf("async function startServerOn("), main.indexOf("async function startServerPackaged("));
  for (const outcome of ["timeout", "foreign-owner", "exited", "ready"]) {
    const captures = [];
    const proc = new EventEmitter();
    proc.kill = () => proc.emit("exit", 1);
    proc.pid = 123;
    const serverToken = "token";
    const context = { path, process: { resourcesPath: "test", env: {} }, managedComposioChildEnvironment: () => ({}), composioBrokerUrl: () => "", childEnvCredentials: {}, app: { getPath: () => "test" }, workspaceCredentialEnv: () => ({}), googleServerEnv: () => ({}), GOOGLE_CLIENT: null, terminalBridgeAccess: null, credentialStoreUnavailable: false, slog() {}, utilityProcess: { fork: () => proc }, keepAwake: { setPhoneServer() {} }, waitForAppToken: async () => serverToken, SERVER_BOOT_TIMEOUT_MS: 1, errorReports: { capture: (value) => captures.push(value) }, ERROR_SITES: { serverGone: 4, startupTimeout: 5 }, serverProc: null, pollServerIdentity: async () => { if (outcome === "exited") proc.emit("exit", 1); return { outcome }; } };
    const start = runInNewContext(`${body}\nstartServerOn`, context);
    await start(9311);
    if (outcome === "ready") proc.emit("exit", 1);
    assert.deepEqual(captures.map((value) => value.code), outcome === "timeout" ? ["STARTUP_TIMEOUT"] : outcome === "foreign-owner" ? [] : ["SERVER_GONE"], outcome);
  }
});

test("automatic updater failures stay local while manual checks and installs report", async () => {
  const { createUpdaterCoordinator } = await import("./updater-coordinator.mjs");
  const updater = new EventEmitter();
  updater.checkForUpdates = () => Promise.reject(new Error("offline"));
  const calls = [];
  const coordinator = createUpdaterCoordinator(updater, () => {}, { onFailure: (...args) => calls.push(args) });
  await coordinator.check();
  updater.emit("error", new Error("offline after wake"));
  assert.deepEqual(calls, []);
  await coordinator.check(true);
  assert.deepEqual(calls, [[]]);
  updater.quitAndInstall = () => { throw new Error("install failed"); };
  await coordinator.install();
  assert.deepEqual(calls, [[], []]);
});

test("missing, malformed and non-object baked config cannot stop startup", async () => {
  const reports = await import("./error-reports.mjs");
  for (const read of [() => { throw new Error("ENOENT"); }, () => JSON.parse("{"), () => null, () => ({}), () => ({ dsn: 4 })]) assert.equal(reports.errorReportDsn(read), "");
  assert.equal(reports.errorReportDsn(() => ({ dsn: "https://public@reports.example/1" })), "https://public@reports.example/1");
  assert.match(source("./main.mjs"), /dsn: errorReportDsn\(\(\) => require\("\.\/error-report-config.json"\)\)/);
});

test("README inventories opt-in destination, cap, IP visibility and all local files", () => {
  const readme = source("../README.md");
  const sends = readme.split("**Sends once you set something up**")[1].split("**Sends only when you act**")[0];
  assert.match(sends, /GlitchTip.*ERROR_REPORT_DSN/);
  assert.match(sends, /5.*(?:day|daily)/);
  assert.match(sends, /(?:PC|computer).*IP/);
  const stores = readme.split("**Stores**")[1].split("**Approvals**")[0];
  for (const file of ["error-report-consent.json", "error-report-queue.json", "error-report-budget.json", "error-report-active"]) assert.ok(stores.includes(file), file);
});

test("untrusted capture IPC returns silently", async () => {
  const { registerErrorReportIpc } = await import("./error-report-capture.mjs");
  const handlers = new Map();
  const calls = [];
  registerErrorReportIpc({ handle() {}, on: (name, callback) => handlers.set(name, callback) }, { capture: (value) => calls.push(value) }, () => null, () => "http://127.0.0.1:9311");
  assert.doesNotThrow(() => handlers.get("error-reports:capture")({ sender: {} }, 1));
  assert.deepEqual(calls, []);
});

test("queue stores records only and the unused errorCode export is absent", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  f.reporter.capture(failure);
  f.status(503);
  await f.reporter.flush();
  assert.deepEqual(Object.keys(f.queue()), ["records"]);
  const schema = await import("../shared/error-report.mjs");
  assert.equal("errorCode" in schema, false);
});

test("no requests or queue before consent, after opt-out, or without a DSN", async (t) => {
  for (const dsn of [undefined, ""]) {
    const f = await fixture(t, dsn === "" ? { dsn } : {});
    assert.equal(f.reporter.consent(), false);
    f.reporter.capture(failure);
    await f.reporter.flush();
    assert.equal(f.received.length, 0);
    assert.equal(fs.existsSync(path.join(f.dir, "error-report-queue.json")), false);
    f.reporter.setConsent(true);
    f.reporter.capture(failure);
    f.reporter.setConsent(false);
    await f.reporter.flush();
    assert.equal(f.received.length, 0);
    assert.equal(fs.existsSync(path.join(f.dir, "error-report-queue.json")), false);
    f.reporter.setConsent(true);
    f.reporter.capture(failure);
    await f.reporter.flush();
    assert.equal(f.received.length, dsn === "" ? 0 : 1);
    if (dsn === "") assert.equal(fs.existsSync(path.join(f.dir, "error-report-queue.json")), false);
  }
});

test("exact Sentry store bytes contain only permitted facts; all privacy fixtures stay local", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  for (const text of privateText) f.reporter.capture({ ...failure, code: text, message: text, stack: text, path: text, url: text, build: text, reportId: text, extra: { secret: text } });
  await f.reporter.flush();
  const report = f.queue().records[0].report;
  assert.equal(f.received.length, 1);
  const request = f.received[0];
  assert.equal(request.url, "/api/1/store/?sentry_version=7&sentry_key=public");
  assert.deepEqual(request.headers, { "content-type": "application/json", "content-length": String(Buffer.byteLength(request.body)), host: `127.0.0.1:${f.config.dsn.match(/:(\d+)\//)[1]}`, connection: "close" });
  assert.equal(request.body, JSON.stringify({ event_id: report.reportId, timestamp: Date.UTC(2026, 9, 28, 1) / 1000, message: "UNKNOWN_ERROR", release: "1.0.212", tags: { platform: "win32", arch: "x64", process: "renderer", site: "1" }, extra: { schema: 1, exitCode: 0, count: privateText.length, uptimeBucket: 1 } }));
  const bytes = JSON.stringify(request);
  for (const text of privateText) assert.equal(bytes.includes(text), false, text);
  assert.match(report.reportId, /^[a-f0-9]{32}$/);
});

test("coalesces, bounds values and caps records and bytes with atomic persistence", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  f.status(503);
  for (let i = 0; i < 120; i++) f.reporter.capture({ process: "main", code: ["UNKNOWN_ERROR", "RENDERER_GONE", "SERVER_GONE", "STARTUP_TIMEOUT", "UPDATE_FAILED", "UPDATE_UNAVAILABLE", "UNCLEAN_EXIT", "SERVER_RUNTIME_FAILURE"][i % 8], site: Math.floor(i / 8) % 10 + 1, exitCode: Infinity });
  await f.reporter.flush();
  const q = f.queue();
  assert.ok(q.records.length <= 100);
  assert.ok(fs.statSync(path.join(f.dir, "error-report-queue.json")).size <= 200 * 1024);
  assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith(".tmp")), false);
  assert.ok(q.records.every(({ report }) => report.exitCode === 0));
  f.reporter.capture(failure);
  f.reporter.capture(failure);
  await f.reporter.flush();
  assert.ok(f.queue().records.some(({ report }) => report.site === 1 && report.code === "UNKNOWN_ERROR" && report.count >= 2));
  const seeded = f.queue();
  const record = seeded.records[0];
  seeded.records = Array.from({ length: 101 }, (_, i) => ({ ...record, report: { ...record.report, build: `1.0.${i}`, reportId: i.toString(16).padStart(32, "0") } }));
  fs.writeFileSync(path.join(f.dir, "error-report-queue.json"), JSON.stringify(seeded));
  const restarted = f.open();
  restarted.capture(failure);
  await restarted.flush();
  assert.equal(f.queue().records.length, 100);
  assert.ok(fs.statSync(path.join(f.dir, "error-report-queue.json")).size <= 200 * 1024);
});

test("TTL and invalid disk records are dropped on restart", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  f.reporter.capture(failure);
  f.reporter.stop();
  const q = f.queue();
  q.records.push({ ...q.records[0], report: { ...q.records[0].report, code: privateText[7] } });
  fs.writeFileSync(path.join(f.dir, "error-report-queue.json"), JSON.stringify(q));
  const next = f.open();
  next.capture({ ...failure, site: 2 });
  await next.flush();
  assert.equal(f.received.length, 1);
  next.capture(failure);
  f.advance(7 * 24 * 3600_000 + 1);
  await f.open().flush();
  assert.equal(f.received.length, 1);
});

test("timeouts retain the record and concurrent flushes open only one socket", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  f.reporter.capture(failure);
  f.hold();
  await Promise.all([f.reporter.flush(), f.reporter.flush()]);
  assert.equal(f.received.length, 1);
  assert.equal(f.queue().records.length, 1);
  assert.equal(f.queue().records[0].attempts, 1);
});

test("HTTP-date Retry-After is global and backoff is bounded from 30 seconds to six hours", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  f.reporter.capture(failure);
  f.status(429, new Date(Date.UTC(2026, 9, 28, 1, 26, 45)).toUTCString());
  await f.reporter.flush();
  f.reporter.capture({ ...failure, site: 2 });
  f.advance(120000);
  await f.reporter.flush();
  assert.equal(f.received.length, 1);
  f.advance(60000);
  f.status(503);
  await f.reporter.flush();
  assert.equal(f.received.length, 2);
  const q = f.queue();
  const time = Date.UTC(2026, 9, 28, 1, 26, 45);
  const budget = JSON.parse(fs.readFileSync(path.join(f.dir, "error-report-budget.json"), "utf8"));
  assert.ok(budget.nextUpload - time >= 30000 && budget.nextUpload - time <= 6 * 3600000);
  budget.nextUpload = 0;
  q.records[0].attempts = 30;
  q.records[0].next = 0;
  fs.writeFileSync(path.join(f.dir, "error-report-queue.json"), JSON.stringify(q));
  fs.writeFileSync(path.join(f.dir, "error-report-budget.json"), JSON.stringify(budget));
  await f.open().flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "error-report-budget.json"), "utf8")).nextUpload - time, 6 * 3600000);
});

test("invalid consent, oversize disk files, invalid records and redirect responses fail closed", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dir, "error-report-consent.json"), '{"schema":0,"enabled":true}');
  f.reporter.capture(failure);
  await f.reporter.flush();
  assert.equal(f.received.length, 0);
  f.reporter.setConsent(true);
  fs.writeFileSync(path.join(f.dir, "error-report-queue.json"), " ".repeat(200 * 1024 + 1));
  const next = f.open();
  await next.flush();
  assert.equal(f.received.length, 0);
  next.capture(failure);
  f.status(302);
  await next.flush();
  assert.equal(f.received.length, 1);
  await next.flush();
  assert.equal(f.queue().records.length, 0);
  f.reporter.setConsent(false);
  fs.writeFileSync(path.join(f.dir, "error-report-queue.json"), '{"records":[]}');
  f.open();
  assert.equal(fs.existsSync(path.join(f.dir, "error-report-queue.json")), false);
});

test("typed server failures use a separate authenticated loopback grant and reject extra fields", async (t) => {
  const { createTerminalBridge, updateGrant } = await import("./terminal-bridge.mjs");
  const { reportServerFailure } = await import("../server/error-reports.ts");
  const { createHmac } = await import("node:crypto");
  const f = await fixture(t);
  f.reporter.setConsent(true);
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {} }, errorReports: f.reporter });
  const access = await bridge.start();
  t.after(() => bridge.close());
  await reportServerFailure(access);
  const grant = createHmac("sha256", access.token).update("orbit-error-report-v1").digest("base64url");
  for (const authorization of ["", `Bearer ${access.token}`, `Bearer ${updateGrant(access.token)}`]) {
    const response = await fetch(`${access.url}/v1/error-reports`, { method: "POST", headers: { authorization }, body: JSON.stringify({ code: "SERVER_RUNTIME_FAILURE", site: 9 }) });
    assert.equal(response.status, 401);
    await response.body?.cancel();
  }
  for (const body of [{ code: privateText[7], site: 9 }, { code: "UNKNOWN_ERROR", site: 9 }, { code: "SERVER_RUNTIME_FAILURE", site: 9, secret: privateText[6] }, { code: "SERVER_RUNTIME_FAILURE", site: 1 }]) {
    const response = await fetch(`${access.url}/v1/error-reports`, { method: "POST", headers: { authorization: `Bearer ${grant}` }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    await response.body?.cancel();
  }
  await f.reporter.flush();
  assert.equal(f.received.length, 1);
  assert.equal(f.queue().records[0].report.code, "SERVER_RUNTIME_FAILURE");
  const bytes = JSON.stringify(f.received);
  for (const text of privateText) assert.equal(bytes.includes(text), false);
});

test("updater reports both silent rejection and event failures without forwarding errors", async () => {
  const { createUpdaterCoordinator } = await import("./updater-coordinator.mjs");
  const updater = new EventEmitter();
  const error = new Error(privateText[6]);
  updater.checkForUpdates = () => Promise.reject(error);
  const calls = [];
  const coordinator = createUpdaterCoordinator(updater, () => {}, { onFailure: (...args) => calls.push(args) });
  await coordinator.check(true);
  updater.checkForUpdates = () => { updater.emit("error", new Error(privateText[0])); };
  await coordinator.check(true);
  assert.deepEqual(calls, [[], []]);
});

test("429/5xx retry survives restart with immutable bytes and Retry-After", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  f.reporter.capture(failure);
  f.status(429, "120");
  await f.reporter.flush();
  f.reporter.stop();
  const next = f.open();
  f.advance(119_000);
  await next.flush();
  assert.equal(f.received.length, 1);
  f.advance(1_000);
  f.status(503);
  await next.flush();
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].body, f.received[1].body);
  f.advance(6 * 3600_000);
  f.status(200);
  await next.flush();
  assert.equal(f.received.length, 3);
  assert.equal(f.received[0].body, f.received[2].body);
  await next.flush();
  assert.equal(f.queue().records.length, 0);
});

test("at most five attempts per UTC day survive restart", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  f.status(503);
  let current = f.reporter;
  for (let i = 0; i < 8; i++) {
    current.capture({ ...failure, site: i % 2 + 1 });
    await current.flush();
    current.stop();
    current = f.open();
    f.advance(2 * 3600_000);
  }
  assert.equal(f.received.length, 5);
  f.advance(24 * 3600_000);
  await f.open().flush();
  assert.equal(f.received.length, 6);
});

test("opting out and restarting cannot reset the daily upload budget", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  for (let i = 0; i < 5; i++) {
    f.reporter.capture(failure);
    await f.reporter.flush();
  }
  f.reporter.setConsent(false);
  f.reporter.stop();
  const next = f.open();
  next.setConsent(true);
  next.capture(failure);
  await next.flush();
  assert.equal(f.received.length, 5);
});

test("opt-out aborts an in-flight request and purges queue, including changed consent on disk", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  f.reporter.capture(failure);
  f.hold();
  const pending = f.reporter.flush();
  while (!f.received.length) await new Promise((resolve) => setTimeout(resolve, 5));
  f.reporter.setConsent(false);
  await pending;
  assert.equal(fs.existsSync(path.join(f.dir, "error-report-queue.json")), false);
  f.reporter.setConsent(true);
  f.reporter.capture(failure);
  fs.writeFileSync(path.join(f.dir, "error-report-consent.json"), '{"schema":1,"enabled":false}');
  await f.reporter.flush();
  assert.equal(f.received.length, 1);
  assert.equal(fs.existsSync(path.join(f.dir, "error-report-queue.json")), false);
});

test("unclean marker is consent-gated and graceful shutdown clears it", async (t) => {
  const f = await fixture(t);
  f.reporter.start();
  assert.equal(fs.existsSync(path.join(f.dir, "error-report-active")), false);
  f.reporter.setConsent(true);
  f.reporter.stop();
  fs.writeFileSync(path.join(f.dir, "error-report-active"), "1");
  const next = f.open();
  next.start();
  await next.flush();
  assert.equal(f.queue().records[0].report.code, "UNCLEAN_EXIT");
  next.stop();
  assert.equal(fs.existsSync(path.join(f.dir, "error-report-active")), false);
});

test("graceful shutdown preserves a pending report for retry after restart", async (t) => {
  const f = await fixture(t);
  f.reporter.setConsent(true);
  f.reporter.capture(failure);
  f.hold();
  const pending = f.reporter.flush();
  while (!f.received.length) await new Promise((resolve) => setTimeout(resolve, 5));
  f.reporter.stop();
  await pending;
  assert.equal(f.queue().records.length, 1);
  const original = f.received[0].body;
  f.advance(6 * 3600000);
  const next = f.open();
  const retried = next.flush();
  while (f.received.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  next.stop();
  await retried;
  assert.equal(f.received[1].body, original);
  assert.equal(f.queue().records.length, 1);
});

test("spoofed IPC senders, subframes, origins and renderer sites are rejected", async () => {
  const { registerErrorReportIpc, installErrorReportCapture } = await import("./error-report-capture.mjs");
  const handlers = new Map();
  const ipc = { handle: (name, callback) => handlers.set(name, callback), on: (name, callback) => handlers.set(name, callback) };
  const frame = { url: "http://127.0.0.1:9311/" };
  const owner = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  const captures = [];
  let consent = false;
  const reports = { capture: (value) => captures.push(value), available: () => true, consent: () => consent, setConsent: (value) => { consent = value; return consent; } };
  registerErrorReportIpc(ipc, reports, () => owner, () => "http://127.0.0.1:9311");
  const trusted = { sender: owner, senderFrame: frame };
  for (const event of [{ ...trusted, sender: {} }, { ...trusted, senderFrame: { ...frame } }, { ...trusted, senderFrame: { url: "https://evil.test" } }]) {
    assert.throws(() => handlers.get("error-reports:set")(event, true));
    assert.doesNotThrow(() => handlers.get("error-reports:capture")(event, 1));
  }
  handlers.get("error-reports:capture")(trusted, privateText[7]);
  assert.equal(captures.length, 0);
  handlers.get("error-reports:capture")(trusted, 2);
  assert.deepEqual(captures, [{ process: "renderer", code: "UNKNOWN_ERROR", site: 2 }]);
  assert.equal(handlers.get("error-reports:set")(trusted, true), true);
  const app = new EventEmitter();
  installErrorReportCapture(app, reports, () => owner);
  app.emit("render-process-gone", {}, owner, { exitCode: 9, reason: privateText[6] });
  assert.deepEqual(captures.at(-1), { process: "renderer", code: "RENDERER_GONE", site: 3, exitCode: 9 });
});
