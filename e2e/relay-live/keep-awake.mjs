import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { _electron as electron } from "playwright";

const CODE = (process.env.RELAY_E2E_CODE ?? "").trim();
const EXE = process.env.WINK_EXE;
const OUT = process.env.OUT_DIR;
const WORK = process.env.WORK_DIR;
const PROFILE = process.env.USERPROFILE;
const MODE = process.env.ACME_MODE || "staging";
const STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";
const COPY = "This PC stays awake while plugged in, so your phone can always reach it.";
const SENSITIVE = '[aria-label="Setup code"], [aria-label="Invite"], [aria-label="Phone pairing QR code"], [data-pairing-code], [role="alert"], [data-phone-access-error]';
const SHOTS = join(OUT, "screens");
const POWER = join(OUT, "powercfg");
const secrets = new Set();
const hide = (value) => {
  if (typeof value === "string" && value.length >= 6) secrets.add(value);
  return value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = {};
const facts = { bits: process.env.BITS ?? null, mode: MODE };
const shots = [];
const captures = [];
let app = null;
let page = null;
let helper = null;
let fatal = null;
let phase = "control";
let sequence = 0;
let appOutput = "";
let helperOutput = "";

hide(CODE);
hide(CODE.split(":").slice(2).join(":"));
for (const path of [OUT, WORK, SHOTS, POWER, join(OUT, "logs")]) mkdirSync(path, { recursive: true });

function redact(text) {
  let out = String(text);
  for (const value of secrets) out = out.split(value).join("[redacted]");
  return out
    .replace(/\bwk[a-z0-9]{1,3}[._:][A-Za-z0-9._:-]*/g, "[redacted]")
    .replace(/(__Host-wink_phone=)[^;\s"']*/g, "$1[redacted]")
    .replace(/#k=[^\s"')]*/g, "#k=[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:cookie|set-cookie|authorization|(?:app|api|access|refresh)[_-]?token|ticket|invite)\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]");
}

function write(path, value) {
  writeFileSync(path, `${redact(typeof value === "string" ? value : JSON.stringify(value, null, 2))}\n`);
}

function check(id, name, pass, detail = {}) {
  results[id] = { name, pass: Boolean(pass), ...detail };
  console.log(redact(`${id}: ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`));
  return Boolean(pass);
}

async function shot(name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), mask: [page.locator(SENSITIVE)] });
  shots.push(`${name}.png`);
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(RELAY_E2E_CODE|GH_TOKEN|GITHUB_TOKEN|ELECTRON_|OMB_|OGB_|ORBIT_)/.test(key)) delete env[key];
  return env;
}

async function command(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: childEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseRequests(text) {
  const sections = [];
  const entries = [];
  let section = null;
  let entry = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^([A-Z][A-Z ]*):\s*$/.exec(line.trim());
    if (header) {
      section = header[1];
      sections.push(section);
      entry = null;
      continue;
    }
    const request = /^\[(PROCESS|DRIVER|SERVICE)\]\s+(.+)$/.exec(line.trim());
    if (request && section) {
      entry = { section, type: request[1], source: request[2], lines: [line.trim()] };
      entries.push(entry);
    } else if (entry && line.trim()) entry.lines.push(line.trim());
  }
  return { sections, entries };
}

async function requests(name) {
  const file = `${String(++sequence).padStart(3, "0")}-${name}.txt`;
  const answer = await command("powercfg.exe", ["/requests"]);
  write(join(POWER, file), `${answer.stdout}${answer.stderr}`);
  captures.push(`powercfg/${file}`);
  if (answer.code !== 0) throw new Error(`powercfg /requests exited ${answer.code}; see ${file}`);
  const parsed = parseRequests(answer.stdout);
  if (!["SYSTEM", "EXECUTION"].every((section) => parsed.sections.includes(section))) throw new Error(`powercfg sections not recognized; see ${file}`);
  return { at: new Date().toISOString(), file: `powercfg/${file}`, ...parsed };
}

const winkEntries = (capture) => capture.entries.filter((entry) => entry.type === "PROCESS" && basename(entry.source.replaceAll("\\", "/")).toLowerCase() === "wink.exe");
const blockingEntries = (capture) => winkEntries(capture).filter((entry) => ["EXECUTION", "SYSTEM"].includes(entry.section));

async function pollRequests(name, ms, matches) {
  const started = Date.now();
  let first = null;
  let last = null;
  do {
    last = await requests(name);
    first ??= last.file;
    if (matches(last) && Date.now() - started <= ms) return { pass: true, elapsedMs: Date.now() - started, first, last: last.file, entries: winkEntries(last) };
    if (Date.now() - started >= ms) break;
    await sleep(Math.min(1_000, ms - (Date.now() - started)));
  } while (Date.now() - started <= ms);
  return { pass: false, elapsedMs: Date.now() - started, first, last: last.file, entries: winkEntries(last) };
}

const controlScript = String.raw`param([string]$Ready, [string]$Stop)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class WinkPowerControl {
  [StructLayout(LayoutKind.Sequential)] public struct DetailedReason {
    public IntPtr Module; public uint Id; public uint Count; public IntPtr Strings;
  }
  [StructLayout(LayoutKind.Explicit)] public struct ReasonUnion {
    [FieldOffset(0)] public IntPtr Simple;
    [FieldOffset(0)] public DetailedReason Detailed;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ReasonContext {
    public uint Version; public uint Flags; public ReasonUnion Reason;
  }
  [StructLayout(LayoutKind.Sequential)] public struct SystemPowerStatus {
    public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag;
    public uint BatteryLifeTime; public uint BatteryFullLifeTime;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr PowerCreateRequest(ref ReasonContext context);
  [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool PowerSetRequest(IntPtr handle, int type);
  [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool PowerClearRequest(IntPtr handle, int type);
  [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetSystemPowerStatus(out SystemPowerStatus status);
  public static IntPtr Start(string reason) {
    IntPtr text = Marshal.StringToHGlobalUni(reason);
    try {
      var context = new ReasonContext { Version = 0, Flags = 1, Reason = new ReasonUnion { Simple = text } };
      IntPtr handle = PowerCreateRequest(ref context);
      if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!PowerSetRequest(handle, 3)) {
        int error = Marshal.GetLastWin32Error(); CloseHandle(handle); throw new Win32Exception(error);
      }
      return handle;
    } finally { Marshal.FreeHGlobal(text); }
  }
  public static void Stop(IntPtr handle) {
    bool cleared = PowerClearRequest(handle, 3);
    int error = Marshal.GetLastWin32Error(); CloseHandle(handle);
    if (!cleared) throw new Win32Exception(error);
  }
  public static SystemPowerStatus Status() {
    SystemPowerStatus status;
    if (!GetSystemPowerStatus(out status)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return status;
  }
}
'@
$reason = "Wink keep-awake E2E control PID $PID"
$request = [WinkPowerControl]::Start($reason)
try {
  $status = [WinkPowerControl]::Status()
  $facts = @{
    pid = $PID; reason = $reason; acLineStatus = [int]$status.ACLineStatus
    batteryFlag = [int]$status.BatteryFlag; batteryPercent = [int]$status.BatteryLifePercent
    batteryPresent = if ($status.BatteryFlag -eq 255) { $null } else { ($status.BatteryFlag -band 128) -eq 0 }
  }
  [IO.File]::WriteAllText($Ready, ($facts | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  while (-not (Test-Path -LiteralPath $Stop)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Control stop signal timed out' }
    Start-Sleep -Milliseconds 200
  }
} finally { [WinkPowerControl]::Stop($request) }
`;

async function stopControl() {
  if (!helper) return;
  writeFileSync(join(WORK, "control-stop"), "stop\n");
  const code = helper.exitCode !== null ? helper.exitCode : await Promise.race([
    new Promise((resolve) => helper.once("exit", resolve)),
    sleep(10_000).then(() => { throw new Error("Power control did not exit cleanly"); }),
  ]);
  if (code !== 0) throw new Error(`Power control exited ${code}: ${redact(helperOutput)}`);
  helper = null;
}

async function positiveControl() {
  const script = join(WORK, "power-control.ps1");
  const ready = join(WORK, "control-ready.json");
  writeFileSync(script, controlScript);
  helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Ready", ready, "-Stop", join(WORK, "control-stop")], {
    env: childEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  helper.stdout.on("data", (chunk) => { helperOutput += chunk; });
  helper.stderr.on("data", (chunk) => { helperOutput += chunk; });
  helper.on("error", (error) => { helperOutput += error.message; });
  const deadline = Date.now() + 30_000;
  while (!existsSync(ready)) {
    if (helper.exitCode !== null || Date.now() >= deadline) throw new Error(`Power control never became ready: ${redact(helperOutput)}`);
    await sleep(200);
  }
  facts.power = JSON.parse(readFileSync(ready, "utf8"));
  let matched = null;
  const capture = await pollRequests("control-on", 10_000, (value) => {
    matched = value.entries.find((entry) => entry.type === "PROCESS" && /powershell\.exe$/i.test(entry.source) && ["SYSTEM", "EXECUTION"].includes(entry.section) && entry.lines.includes(facts.power.reason));
    return Boolean(matched);
  });
  const pass = check("control", "Windows parser sees the helper's execution request", capture.pass, { ...capture, pid: facts.power.pid, entry: matched });
  await stopControl();
  const off = await requests("control-off");
  if (off.entries.some((entry) => entry.lines.includes(facts.power.reason))) throw new Error("Power control request remained after clean exit");
  facts.controlOff = off.file;
  if (!pass) throw new Error("Positive control failed; Wink's absence would be inconclusive");
  const available = await command("powercfg.exe", ["/a"]);
  write(join(POWER, "available-sleep-states.txt"), `${available.stdout}${available.stderr}`);
  facts.sleepStates = { file: "powercfg/available-sleep-states.txt", exitCode: available.code };
  if (facts.power.acLineStatus !== 1) throw new Error("Runner is not confirmed on AC; keep-awake result would be inconclusive");
}

async function openPhoneAccess() {
  await page.getByRole("button", { name: "App settings" }).first().click({ timeout: 90_000 });
  await page.getByRole("dialog").getByRole("button", { name: "Connections", exact: true }).click();
  const title = page.getByText("Phone access from anywhere", { exact: true });
  await title.waitFor({ timeout: 30_000 });
  await title.scrollIntoViewIfNeeded();
  return title.locator("..");
}

async function connected(section, ms) {
  const started = Date.now();
  const states = [];
  while (Date.now() - started < ms) {
    const alert = section.locator('[role="alert"]');
    if (await alert.count()) throw new Error(`Phone access alert: ${redact((await alert.first().textContent())?.trim())}`);
    const state = await section.locator("[data-phone-access-state]").getAttribute("data-phone-access-state", { timeout: 1_000 }).catch(() => null);
    if (state && !states.includes(state)) states.push(state);
    if (state === "connected") return { elapsedMs: Date.now() - started, states, at: new Date().toISOString() };
    await sleep(250);
  }
  throw new Error(`Phone access never connected in ${ms / 1_000}s; states: ${states.join(", ")}`);
}

async function flow() {
  if (process.platform !== "win32" || MODE !== "staging" || !CODE) throw new Error("Requires Windows, acme=staging and RELAY_E2E_CODE");
  await positiveControl();
  phase = "launch";
  const config = join(PROFILE, ".orbit", "config.json");
  if (existsSync(config)) throw new Error("Runner account already has a Wink config; not a fresh installer check");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, `${JSON.stringify({ phoneRelay: { acmeDirectories: [STAGING] } }, null, 2)}\n`);
  app = await electron.launch({ executablePath: EXE, cwd: dirname(EXE), args: ["--lang=en-US"], env: childEnv(), locale: "en-US", timeout: 180_000 });
  app.process().stdout?.on("data", (chunk) => { appOutput += chunk; });
  app.process().stderr?.on("data", (chunk) => { appOutput += chunk; });
  facts.app = await app.evaluate(({ app, powerMonitor }) => ({
    packaged: app.isPackaged, version: app.getVersion(), home: app.getPath("home"), userData: app.getPath("userData"), logs: app.getPath("logs"), onBattery: powerMonitor.isOnBatteryPower(),
  }));
  if (!facts.app.packaged || facts.app.home.toLowerCase() !== PROFILE.toLowerCase() || facts.app.onBattery) throw new Error("Wink is not packaged, does not use the configured profile, or reports battery power");
  page = await app.firstWindow({ timeout: 180_000 });
  await page.waitForURL((url) => url.protocol === "http:" && url.hostname === "127.0.0.1", { timeout: 180_000 });
  await page.evaluate(() => localStorage.setItem("omb-onboarding-done", "true"));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  const section = await openPhoneAccess();
  await page.getByLabel("Setup code").waitFor({ timeout: 30_000 });
  facts.windowDriven = true;
  phase = "checks";
  const before = await requests("k1-before-setup");
  check("k1", "No Wink power request before setup", winkEntries(before).length === 0, { file: before.file, entries: winkEntries(before) });
  await shot("k1-before-setup");

  await page.getByLabel("Setup code").fill(CODE);
  await shot("k2-code-pasted");
  const answer = page.waitForResponse((response) => response.url().endsWith("/api/phone-relay/setup") && response.request().method() === "POST", { timeout: 180_000 }).catch(() => null);
  await page.locator("form[data-phone-access-setup] button[type=submit]").click();
  const response = await answer;
  if (!response) throw new Error("No setup response within 180s");
  const body = await response.json().catch(() => ({}));
  if (!response.ok()) throw new Error(`Setup HTTP ${response.status()}: ${redact(body.error ?? "unknown error")}`);
  const firstConnected = await connected(section, 8 * 60_000);
  check("k2", "Setup code connects through Settings", true, { status: response.status(), ...firstConnected });

  const on = await pollRequests("k3-connected", 30_000, (value) => blockingEntries(value).length > 0);
  check("k3", "Wink requests EXECUTION or SYSTEM within 30s", on.pass, on);
  await section.scrollIntoViewIfNeeded();
  const copy = section.getByText(COPY, { exact: true });
  const copyVisible = await copy.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
  if (copyVisible) await copy.scrollIntoViewIfNeeded();
  await shot("k4-connected-copy");
  check("k4", "Connected section explains AC keep awake", copyVisible, { expected: COPY, screenshot: "screens/k4-connected-copy.png" });

  const toggle = section.getByRole("switch");
  if (await toggle.getAttribute("aria-checked") !== "true") throw new Error("Phone access switch was not on after setup");
  const offStarted = Date.now();
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-phone-access-state="off"]') && document.querySelector('[role="switch"][aria-checked="false"]'), null, { timeout: 30_000 });
  const off = await pollRequests("k5-off", Math.max(0, 30_000 - (Date.now() - offStarted)), (value) => winkEntries(value).length === 0);
  check("k5", "Turning phone access off removes Wink's request within 30s", off.pass, { ...off, elapsedMs: Date.now() - offStarted });
  await shot("k5-phone-access-off");

  await toggle.click();
  const again = await connected(section, 8 * 60_000);
  const back = await pollRequests("k6-connected-again", 60_000, (value) => blockingEntries(value).length > 0);
  check("k6", "Turning phone access back on restores Wink's request within 60s", back.pass, { ...back, connected: again });
  await shot("k6-phone-access-on-again");
}

function collectLogs(root, label, depth = 0) {
  if (!root || !existsSync(root) || depth > 8) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const name = `${label}-${entry.name}`;
    if (entry.isDirectory()) collectLogs(path, name, depth + 1);
    else if (entry.isFile() && /\.log(?:\.\d+)?$/i.test(entry.name)) write(join(OUT, "logs", redact(name)), readFileSync(path, "utf8"));
  }
}

function auditArtifacts(root = OUT) {
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += auditArtifacts(path);
    else if (entry.isFile()) {
      if (entry.name.endsWith(".png")) {
        if (root !== SHOTS || !shots.includes(entry.name)) throw new Error("Unrecognized screenshot in artifacts");
      } else {
        const text = readFileSync(path, "utf8");
        if ([...secrets].some((value) => text.includes(value)) || /\bwk[a-z0-9]{1,3}[._:][A-Za-z0-9._:-]+/.test(text)) throw new Error("Artifact secret scan failed; upload withheld");
      }
      count++;
    }
  }
  return count;
}

try {
  await flow();
} catch (error) {
  fatal = { phase, message: redact(error?.message ?? String(error)).split("\n").slice(0, 8).join("\n") };
  console.log(redact(`FATAL ${phase}: ${fatal.message}`));
  if (page && !page.isClosed()) await shot("fatal").catch(() => {});
} finally {
  try {
    await stopControl();
    if (app) {
      await Promise.race([app.close(), sleep(30_000).then(() => { throw new Error("Wink did not quit cleanly within 30s"); })]);
      facts.cleanQuit = true;
      const quit = await requests("after-clean-quit");
      facts.afterQuit = { file: quit.file, entries: winkEntries(quit) };
      if (facts.afterQuit.entries.length) throw new Error("Wink power request remained after clean quit");
    }
  } catch (error) {
    facts.cleanQuit = false;
    fatal ??= { phase: "cleanup", message: redact(error.message) };
  }
  for (const id of ["control", "k1", "k2", "k3", "k4", "k5", "k6"]) {
    if (!results[id]) check(id, "Not reached", false, { blocked: true, reason: fatal?.message ?? "earlier check did not complete" });
  }
  collectLogs(join(PROFILE, ".orbit"), "orbit");
  collectLogs(facts.app?.userData ?? join(process.env.APPDATA, "Wink"), "userdata");
  collectLogs(facts.app?.logs ?? join(process.env.APPDATA, "Wink", "logs"), "electron");
  if (!facts.app) {
    collectLogs(join(process.env.APPDATA, "orbit-desktop"), "fallback-userdata");
    collectLogs(join(process.env.APPDATA, "Orbit"), "fallback-orbit");
  }
  write(join(OUT, "logs", "app-output.log"), appOutput);
  write(join(OUT, "logs", "power-control.log"), helperOutput);
  const pass = !fatal && Object.values(results).every((entry) => entry.pass);
  const summary = { pass, verdict: pass ? "PASS" : fatal ? "BLOCKED" : "FAIL", fatal, facts, results, screenshots: shots, powercfg: captures };
  write(join(OUT, "keep-awake-result.json"), summary);
  write(join(OUT, "artifact-audit.json"), { pass: true, files: auditArtifacts(), screenshotMask: SENSITIVE });
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, "KEEP_AWAKE_ARTIFACTS_SAFE=true\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      "", `### Full app keep awake: ${summary.verdict}`, `Bits: ${facts.bits}. ACME: ${MODE}.`, "",
      "| Check | Result | Evidence |", "|---|---|---|",
      ...Object.entries(results).map(([id, entry]) => `| ${id} | ${entry.blocked ? "BLOCKED" : entry.pass ? "PASS" : "FAIL"} | ${entry.name}; ${entry.file ?? entry.last ?? entry.screenshot ?? ""} |`),
      "", `Power facts: ${JSON.stringify(facts.power ?? null)}. Clean quit: ${facts.cleanQuit ?? false}.`,
      ...(fatal ? ["", `Blocked: ${fatal.message.replaceAll("\n", " ")}`] : []), "",
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, redact(lines.join("\n")));
  }
  console.log(`Full app keep awake: ${summary.verdict}`);
  process.exitCode = pass ? 0 : 1;
}
