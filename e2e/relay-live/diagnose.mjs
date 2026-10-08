// Loads the relay client in the shipped server under Node and under Orbit.exe's
// own runtime, with a placeholder setup code for example.invalid: no secret,
// no relay traffic, no certificate. Also finds the CommonJS requires esbuild
// left in the bundle.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

const RES = process.env.WINK_RESOURCES;
const OUT = join(process.env.OUT_DIR, "diagnose");
const WORK = join(process.env.WORK_DIR, "diagnose");
const PLACEHOLDER = "wks1:example.invalid:wki1.AAAA.BBBB";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { bundle: null, runtimes: [] };

function scanBundle() {
  const file = join(RES, "server", "index.js");
  const lines = readFileSync(file, "utf8").split("\n");
  let module = null;
  const requires = [];
  let shim = null;
  lines.forEach((line, index) => {
    const header = /^\/\/ (node_modules\/\S+|server\/\S+|shared\/\S+)$/.exec(line.trim());
    if (header) module = header[1];
    if (shim === null && line.includes("Dynamic require of")) shim = index + 1;
    for (const [, name] of line.matchAll(/__require\("([^"]+)"\)/g)) requires.push({ line: index + 1, name, module });
  });
  const byPackage = {};
  for (const entry of requires) {
    const pkg = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(entry.module ?? "")?.[1] ?? entry.module ?? "?";
    (byPackage[pkg] ??= []).push(`${entry.name}@${entry.line}`);
  }
  return { file: "resources/server/index.js", lines: lines.length, shimLine: shim, requireCount: requires.length, crypto: requires.filter((r) => r.name === "crypto"), byPackage };
}

async function start(name, runtime, home, port) {
  mkdirSync(home, { recursive: true });
  const token = randomBytes(24).toString("hex");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(RELAY_E2E_CODE|ACME_MODE|OMB_|OGB_|ORBIT_|ELECTRON_)/.test(key)) delete env[key];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
    OMB_STATIC_DIR: join(RES, "ui"),
    OMB_RESOURCES_PATH: RES,
    OMB_SKILLS_DIR: join(RES, "skills"),
    OMB_USER_DATA: `${home}-userdata`,
    OMB_PACKAGED: "1",
    OMB_COMMS_TOKEN: token,
    ORBIT_REMOTE_AUTO: "0",
    ...runtime.env,
  });
  const logPath = join(WORK, `${name}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn(runtime.exe, [join(RES, "server", "packaged-boot.js")], { env, stdio: ["ignore", fd, fd], windowsHide: true });
  closeSync(fd);
  let spawnError = null;
  child.once("error", (error) => (spawnError = error));
  const server = { name, child, token, port, logPath, origin: `http://127.0.0.1:${port}` };
  const deadline = Date.now() + 180_000;
  while ((await call(server, "/api/phone-relay/status").catch(() => null))?.status !== 200) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`${name} exited (${child.exitCode})`);
    if (Date.now() > deadline) throw new Error(`${name} never answered`);
    await sleep(500);
  }
  return server;
}

async function call(server, path, init = {}) {
  const res = await fetch(`${server.origin}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill();
  await new Promise((resolve) => server.child.once("exit", resolve));
  await sleep(1_500);
}

const pick = (status) => status && { configured: status.configured, enabled: status.enabled, state: status.state, lastError: status.lastError };

async function screenshot(server, name) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, serviceWorkers: "block" });
    await context.addInitScript(() => localStorage.setItem("omb-onboarding-done", "true"));
    await context.route(
      (url) => url.origin === server.origin && url.pathname.startsWith("/api/"),
      (route) => route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${server.token}` } }),
    );
    const page = await context.newPage();
    await page.goto(`${server.origin}/`);
    await page.getByRole("button", { name: "App settings" }).first().click({ timeout: 60_000 });
    await page.getByRole("dialog").getByRole("button", { name: "Connections", exact: true }).click();
    const title = page.getByText("Phone access from anywhere", { exact: true });
    await title.waitFor({ timeout: 30_000 });
    await title.scrollIntoViewIfNeeded();
    await page.waitForTimeout(3_500);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
  } finally {
    await browser.close();
  }
}

mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });
report.bundle = scanBundle();
console.log(JSON.stringify(report.bundle, null, 2));

const runtimes = [
  { name: "node", exe: process.execPath, env: {} },
  { name: "electron", exe: join(RES, "..", "Orbit.exe"), env: { ELECTRON_RUN_AS_NODE: "1" } },
];
let port = 22101;
for (const runtime of runtimes) {
  const home = join(WORK, runtime.name, "home");
  const entry = { runtime: runtime.name };
  report.runtimes.push(entry);
  try {
    const first = await start(`${runtime.name}-boot1`, runtime, home, port);
    entry.version = (await call(first, "/api/health")).body;
    entry.before = pick((await call(first, "/api/phone-relay/status")).body);
    const setup = await call(first, "/api/phone-relay/setup", { method: "POST", body: JSON.stringify({ code: PLACEHOLDER }) });
    entry.setup = { status: setup.status, error: setup.body?.error ?? null };
    entry.afterSetup = pick((await call(first, "/api/phone-relay/status")).body);
    await stop(first);
    const second = await start(`${runtime.name}-boot2`, runtime, home, port + 1);
    entry.afterRestart = pick((await call(second, "/api/phone-relay/status")).body);
    entry.bootLog = readFileSync(second.logPath, "utf8").split("\n").filter((line) => line.includes("[phone-relay]"));
    if (runtime.name === "node") await screenshot(second, "settings-after-failed-setup-and-restart").catch((error) => (entry.screenshotError = error.message));
    await stop(second);
  } catch (error) {
    entry.error = error.message;
  }
  console.log(JSON.stringify(entry, null, 2));
  port += 10;
}

for (const name of ["node-boot1", "node-boot2", "electron-boot1", "electron-boot2"]) {
  const path = join(WORK, `${name}.log`);
  if (existsSync(path)) writeFileSync(join(OUT, `${name}.log`), readFileSync(path, "utf8").replace(/[a-f0-9]{48}/g, "[redacted]"));
}
writeFileSync(join(OUT, "diagnose.json"), `${JSON.stringify(report, null, 2)}\n`);
