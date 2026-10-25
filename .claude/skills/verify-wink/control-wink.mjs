import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("./hidden.cjs");

const SELF = fileURLToPath(import.meta.url);
const SKILL = dirname(SELF);
const HIDDEN = join(SKILL, "hidden.cjs");
const STUB = join(SKILL, "stub-engine.cjs");
const ROOT = resolve(process.env.WINK_VERIFY_ROOT ?? join(tmpdir(), "wink-verify"));
const STATE = join(ROOT, "state.json");
const SCRATCH = ["state.json", "browser-chromium.json", "browser-webkit.json", "ui", "data", "home", "tmp", "work", "cache", "stop"];
const ENGINES = { claude: "claudeAgent", codex: "codex", grok: "grokAgent", antigravity: "antigravityAgent", muse: "museAgent" };
const BOTS = { Atlas: "claude", Juno: "codex", Orion: "grok", Vega: "antigravity", Lyra: "muse" };
const PHRASES = ["check the build log", "summarize the last run", "what changed in the sidebar", "draft a reply to the review", "list the open questions", "plan the next step", "compare desktop and phone", "note the flaky test"];
const NAV = 'aside[aria-label="Bots and navigation"]';
const BUSY = "[data-orbit-composer-stop], [data-turn-mascot]";
const SYSTEM_VARS = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "NUMBER_OF_PROCESSORS", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "ALLUSERSPROFILE", "PUBLIC", "COMPUTERNAME", "USERNAME", "USERDOMAIN"];
const SWITCHES = new Set(["fill", "full", "help"]);

const HELP = `node control-wink.mjs <command> [args] [--page <name>] [--timeout <ms>]   scratch: ${ROOT}
  launch [--checkout <path>]                     build a checkout's UI + server into scratch, start it on 8970-8979
  doctor                                         read-only: our PIDs, port owner, build sha, data dir, stubs, spawns
  seed [--long <n>]                              5 bots on 5 engines + an n-message chat on Atlas (default 320), via the API
  open desktop|phone [--engine webkit] [--name <page>]   desktop 1440x900; phone 390x844 touch DPR 3
  pages                                          list open pages
  click <selector>                               click (tap on phone pages)
  type <selector> <text> [--fill]                type like a user (--fill for long text)
  press <key> [--selector <selector>]            key or chord: Enter, Escape, Alt+KeyM
  scroll up|down|top|bottom [--px <n>] [--selector <selector>]   wheel (touch on phone) the transcript
  attach <file> [--button <selector>]            Attach button + file chooser
  wait-settle [--text <s>]                       wait until a reply finished streaming
  expect <proof> visible|hidden|in-view|text|count <selector> [value]   PASS/FAIL line, logged to proofs.log
  snapshot [--selector <selector>] [--lines <n>] trimmed accessibility tree
  shot <name> [--selector <selector>] [--full]   PNG into the evidence dir
  eval <expression>                              read the DOM; DOM writes and synthetic input are refused
  reload                                         reload the page
  sheet [shot ...] [--name <sheet>]              contact sheet, desktop and phone side by side
  cleanup                                        stop only our PIDs, remove scratch, keep evidence`;

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) args.push(rest[i]);
  else if (SWITCHES.has(rest[i].slice(2)) || rest[i + 1] === undefined) flags[rest[i].slice(2)] = true;
  else flags[rest[i].slice(2)] = rest[++i];
}
const TIMEOUT = Number(flags.timeout ?? 10_000);
let RUN = null;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const secs = (since) => ((Date.now() - since) / 1000).toFixed(1);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const isInside = (child, parent) => !relative(parent, child).startsWith("..") && !isAbsolute(relative(parent, child));
const git = (cwd, ...gitArgs) =>
  execFileSync("git", ["-C", cwd, ...gitArgs], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();

function say(line) {
  console.log(line);
  if (RUN) appendFileSync(join(RUN, "steps.log"), `${new Date().toISOString()} ${line}\n`);
}

function loadState() {
  if (!existsSync(STATE)) throw new Error(`nothing launched under ${ROOT}: run launch`);
  const state = readJson(STATE);
  RUN = state.run;
  return state;
}

const saveState = (state) => writeJson(STATE, state);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function playwrightDir() {
  try {
    return dirname(require.resolve("playwright"));
  } catch {
    if (process.env.PLAYWRIGHT) return resolve(process.env.PLAYWRIGHT);
    throw new Error("Playwright not found: install it outside the repo and set PLAYWRIGHT to its package dir (see SKILL.md)");
  }
}

const playwright = () => require(playwrightDir());
const browsersPath = () => process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");

function scratchEnv(extra) {
  const home = join(ROOT, "home");
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  return {
    ...Object.fromEntries(SYSTEM_VARS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    PATH: [join(windows, "System32"), windows, join(windows, "System32", "Wbem"), join(windows, "System32", "WindowsPowerShell", "v1.0")].join(";"),
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: join(ROOT, "tmp"),
    TMP: join(ROOT, "tmp"),
    ...extra,
  };
}

function detached(scriptArgs, env, log) {
  const out = openSync(log, "a");
  const child = spawn(process.execPath, ["--require", HIDDEN, ...scriptArgs], { cwd: join(ROOT, "work"), env, detached: true, windowsHide: true, stdio: ["ignore", out, out] });
  child.unref();
  return child.pid;
}

const tail = (file, count = 3) => lines(file).slice(-count).join(" | ");

function freePort(port) {
  return new Promise((done) => {
    const probe = createServer().once("error", () => done(false));
    probe.once("listening", () => probe.close(() => done(true))).listen(port, "127.0.0.1");
  });
}

async function api(state, method, path, body) {
  const response = await fetch(`${state.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${state.token}`, ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}

function build(checkout, outDir, run) {
  const options = { root: checkout, configFile: join(checkout, "vite.config.ts"), configLoader: "runner", cacheDir: join(ROOT, "cache", "vite"), logLevel: "warn", build: { outDir, emptyOutDir: true } };
  // Run from the checkout so "vite" resolves to its own install; the runner loader keeps the config temp file out of it.
  const result = spawnSync(process.execPath, ["--require", HIDDEN, "--input-type=module", "-e", 'await (await import("vite")).build(JSON.parse(process.env.WINK_VITE))'], {
    cwd: checkout,
    env: scratchEnv({ WINK_VITE: JSON.stringify(options), WINK_SPAWN_LOG: join(run, "spawns.jsonl") }),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1 << 26,
  });
  writeFileSync(join(run, "build.log"), `${result.stdout}${result.stderr}`);
  if (result.status !== 0) throw new Error(`build failed: ${tail(join(run, "build.log"))}`);
}

async function launch() {
  if (existsSync(STATE)) throw new Error(`already launched under ${ROOT}: run cleanup first`);
  const started = Date.now();
  const checkout = resolve(flags.checkout ?? join(SKILL, "..", "..", ".."));
  const sha = git(checkout, "rev-parse", "HEAD");
  const status = git(checkout, "status", "--short");
  const run = join(ROOT, "evidence", `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${sha.slice(0, 7)}`);
  for (const dir of [join(run, "shots"), join(ROOT, "data"), join(ROOT, "home", ".grok"), join(ROOT, "home", "Downloads"), join(ROOT, "tmp"), join(ROOT, "work"), join(ROOT, "stop")]) {
    mkdirSync(dir, { recursive: true });
  }
  RUN = run;
  say(`checkout ${checkout} ${sha.slice(0, 7)}, ${status ? `${status.split("\n").length} local changes left as they are` : "clean"}`);

  const ui = join(ROOT, "ui");
  build(checkout, ui, run);
  writeJson(join(ui, "wink-build.json"), { sha, checkout });
  say(`build ${secs(started)}s -> ${ui}`);

  let port = 8970;
  while (!((await freePort(port)) && (await freePort(port + 1)))) {
    if (++port > 8978) throw new Error("no free port pair in 8970-8979");
  }
  const token = randomBytes(24).toString("hex");
  writeJson(join(ROOT, "data", "config.json"), {
    instances: Object.fromEntries(Object.entries(ENGINES).map(([id, driver]) => [id, {
      driver,
      config: { cli: `"${process.execPath}" "${STUB}" ${id}` },
      // Without a key, Muse's Windows sign-in probe starts WSL.
      ...(id === "muse" && { environment: { META_API_KEY: "stub" } }),
    }])),
  });
  writeJson(join(ROOT, "home", ".grok", "auth.json"), { stub: { key: "stub" } });

  const booted = Date.now();
  const state = { checkout, sha, status, run, port, url: `http://127.0.0.1:${port}`, token, started, booted, server: {}, browsers: {}, pages: {} };
  state.server.pid = detached([join(checkout, "server", "index.ts")], scratchEnv({
    OMB_DATA_DIR: join(ROOT, "data"),
    OMB_DOWNLOADS_DIR: join(ROOT, "home", "Downloads"),
    OMB_STATIC_DIR: ui,
    OMB_SKILLS_DIR: join(checkout, "skills"),
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_COMMS_TOKEN: token,
    OMB_THREAD_SYNC_V2: "0",
    ORBIT_REMOTE_AUTO: "0",
    ORBIT_RELAY: "0",
    ORBIT_NO_WSL: "1",
    ORBIT_DEVICE_NAME: "wink-verify",
    WINK_SPAWN_LOG: join(run, "spawns.jsonl"),
    WINK_STUB_LOG: join(run, "stubs.jsonl"),
    ...(process.env.WINK_STUB_DELAY_MS && { WINK_STUB_DELAY_MS: process.env.WINK_STUB_DELAY_MS }),
    WINK_STOP_FILE: join(ROOT, "stop", "server"),
  }), join(run, "server.log"));
  saveState(state);
  await until(async () => {
    if (!alive(state.server.pid)) throw new Error(`server exited: ${tail(join(run, "server.log"))}`);
    const health = await fetch(`${state.url}/api/health`, { signal: AbortSignal.timeout(500) }).then((r) => r.json()).catch(() => null);
    if (health && health.pid !== state.server.pid) throw new Error(`port ${port} answers for pid ${health.pid}, not ours`);
    return Boolean(health);
  }, 90_000, "server health");
  say(`server pid ${state.server.pid} healthy on :${port} in ${secs(booted)}s`);

  await ensureBrowser(state, "chromium");
  const browser = await connect("chromium");
  let bots;
  try {
    const context = await newContext(browser, "probe", "desktop", token);
    bots = await gotoApp(await context.newPage(), state);
    await context.close();
  } finally {
    await browser.close();
  }
  if (git(checkout, "status", "--short") !== status) throw new Error("checkout status changed during launch");
  state.ready = Number(secs(started));
  saveState(state);
  say(`launch ready ${state.ready}s (boot ${secs(booted)}s): ${state.url}, bot list rendered (${bots} bots), checkout status unchanged`);
}

async function ensureBrowser(state, engine) {
  const file = join(ROOT, `browser-${engine}.json`);
  if (state.browsers[engine] && alive(state.browsers[engine].pid) && existsSync(file)) return;
  rmSync(file, { force: true });
  const env = scratchEnv({ WINK_VERIFY_ROOT: ROOT, PLAYWRIGHT: playwrightDir(), PLAYWRIGHT_BROWSERS_PATH: browsersPath(), WINK_SPAWN_LOG: join(state.run, "spawns.jsonl") });
  const pid = detached([SELF, "browser-host", engine], env, join(state.run, `browser-${engine}.log`));
  state.browsers[engine] = { pid };
  saveState(state);
  await until(() => {
    if (!alive(pid)) throw new Error(`browser ${engine} exited: ${tail(join(state.run, `browser-${engine}.log`))}`);
    return existsSync(file);
  }, 60_000, `browser ${engine}`);
  say(`browser ${engine} pid ${pid}`);
}

async function browserHost() {
  const engine = args[0];
  // Pages send the API bearer on every request; a dead proxy keeps it off any non-loopback host.
  const proxy = { server: "http://127.0.0.1:9", bypass: "127.0.0.1,localhost" };
  // _sharedBrowser keeps contexts across connections; without it each command's disconnect closes its pages.
  const server = await playwright()[engine].launchServer({ headless: true, proxy, _sharedBrowser: true });
  const file = join(ROOT, `browser-${engine}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, ws: server.wsEndpoint() }));
  renameSync(`${file}.tmp`, file);
  const stop = join(ROOT, "stop", `browser-${engine}`);
  const timer = setInterval(() => {
    if (!existsSync(stop)) return;
    clearInterval(timer);
    server.close().finally(() => setTimeout(() => process.kill(process.pid), 2000).unref());
  }, 500);
}

const connect = (engine) => playwright()[engine].connect(readJson(join(ROOT, `browser-${engine}.json`)).ws);

async function newContext(browser, name, kind, token) {
  const phone = kind === "phone";
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(phone && { screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: playwright().devices["iPhone 13"].userAgent }),
    locale: "en-US",
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  // Init scripts die with open's connection; window.name is what survives a reload.
  await context.addInitScript((page) => {
    window.name = page;
    localStorage.setItem("omb-onboarding-done", "true");
    localStorage.setItem("omb-locale", "en");
  }, name);
  return context;
}

async function gotoApp(page, state) {
  const listed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bots" && response.request().method() === "GET", { timeout: 30_000 });
  await page.goto(state.url);
  const response = await listed;
  if (!response.ok()) throw new Error(`the page's bot list request answered ${response.status()}`);
  await page.locator(NAV).waitFor({ state: "attached", timeout: 30_000 });
  await page.locator("[data-sidebar-footer]").waitFor({ state: "attached", timeout: TIMEOUT });
  const { bots } = await api(state, "GET", "/api/bots?messages=0");
  await page.waitForFunction((count) => document.querySelectorAll('[data-sidebar-row-kind="bot"]').length === count, bots.length, { timeout: 15_000 });
  return bots.length;
}

async function withPage(run) {
  const state = loadState();
  const name = flags.page ?? state.lastPage;
  const info = state.pages[name];
  if (!info) throw new Error(name ? `no page "${name}"` : "no page open: run open desktop|phone");
  const browser = await connect(info.engine);
  try {
    let found;
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      if ((await page.evaluate(() => window.name).catch(() => null)) === name) found = page;
    }
    if (!found) throw new Error(`page "${name}" is gone`);
    if (state.lastPage !== name) saveState({ ...state, lastPage: name });
    return await run(found, { ...info, name }, state);
  } finally {
    await browser.close();
  }
}

async function open() {
  const kind = args[0];
  const engine = flags.engine ?? "chromium";
  if ((kind !== "desktop" && kind !== "phone") || (engine !== "chromium" && engine !== "webkit")) throw new Error("open desktop|phone [--engine chromium|webkit]");
  const state = loadState();
  const name = flags.name ?? (engine === "chromium" ? kind : `${kind}-${engine}`);
  if (state.pages[name]) throw new Error(`page "${name}" is already open`);
  await ensureBrowser(state, engine);
  const browser = await connect(engine);
  try {
    const page = await (await newContext(browser, name, kind, state.token)).newPage();
    const bots = await gotoApp(page, state);
    const chat = await page.locator("textarea[data-orbit-composer]").getAttribute("placeholder", { timeout: 2000 }).catch(() => null);
    saveState({ ...state, pages: { ...state.pages, [name]: { engine, kind } }, lastPage: name });
    const { width, height } = page.viewportSize();
    say(`open ${name}: ${kind} ${engine} ${width}x${height}, ${bots} bots listed, ${chat ? `composer "${chat}"` : "no chat open"}`);
  } finally {
    await browser.close();
  }
}

async function pages() {
  const state = loadState();
  const names = Object.keys(state.pages);
  if (!names.length) say("no pages: run open desktop|phone");
  for (const name of names) say(`${name}: ${state.pages[name].kind} ${state.pages[name].engine}${name === state.lastPage ? " (current)" : ""}`);
}

async function click() {
  if (!args[0]) throw new Error("click <selector>");
  await withPage(async (page, info) => {
    const target = page.locator(args[0]);
    await (info.kind === "phone" ? target.tap({ timeout: TIMEOUT }) : target.click({ timeout: TIMEOUT }));
    say(`${info.kind === "phone" ? "tap" : "click"} ${args[0]} [${info.name}]`);
  });
}

async function type() {
  const [selector, text] = args;
  if (!selector || text === undefined) throw new Error("type <selector> <text>");
  await withPage(async (page, info) => {
    const target = page.locator(selector);
    await (flags.fill ? target.fill(text, { timeout: TIMEOUT }) : target.pressSequentially(text, { delay: 12, timeout: TIMEOUT }));
    say(`type ${text.length} chars into ${selector} [${info.name}]`);
  });
}

async function press() {
  if (!args[0]) throw new Error("press <key>");
  await withPage(async (page, info) => {
    await (flags.selector ? page.locator(flags.selector).press(args[0], { timeout: TIMEOUT }) : page.keyboard.press(args[0]));
    say(`press ${args[0]}${flags.selector ? ` in ${flags.selector}` : ""} [${info.name}]`);
  });
}

async function scroll() {
  const where = args[0];
  if (!["up", "down", "top", "bottom"].includes(where)) throw new Error("scroll up|down|top|bottom");
  await withPage(async (page, info) => {
    const box = page.locator(flags.selector ?? "[data-orbit-transcript]").first();
    await box.waitFor({ timeout: TIMEOUT });
    const read = () => box.evaluate((el) => {
      const rows = [...el.querySelectorAll("[data-mid]")];
      const edge = el.getBoundingClientRect().top;
      const range = document.createRange();
      const onTop = rows.find((row) => (range.selectNodeContents(row), range.getBoundingClientRect().bottom > edge));
      return { top: Math.round(el.scrollTop), max: el.scrollHeight - el.clientHeight, first: rows[0]?.getAttribute("data-mid") ?? null, rows: rows.length, onTop: onTop?.getAttribute("data-mid") ?? null };
    });
    const rect = await box.boundingBox();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    let move;
    if (info.kind === "desktop") {
      await page.mouse.move(x, y);
      move = (dy) => page.mouse.wheel(0, dy);
    } else if (info.engine === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      const touch = (type, at) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: at === undefined ? [] : [{ x, y: at }] });
      // The finger stays inside the transcript (a swipe covers at most half of it) and moves down to scroll up.
      move = async (dy) => {
        const reach = Math.min(Math.abs(dy), rect.height / 2);
        const from = rect.y + rect.height * (dy < 0 ? 0.25 : 0.75);
        await touch("touchStart", from);
        for (let step = 1; step <= 10; step++) await touch("touchMove", from + (dy < 0 ? reach : -reach) * (step / 10));
        await page.waitForTimeout(80);
        await touch("touchEnd");
      };
    } else {
      say("note: mobile WebKit has no touch scroll input; scrolling by script");
      move = (dy) => box.evaluate((el, by) => el.scrollBy(0, by), dy);
    }
    const up = where === "up" || where === "top";
    const px = Number(flags.px ?? 600);
    const start = await read();
    let now = start;
    let before = start;
    let steps = 0;
    do {
      before = now;
      await move(up ? -px : px);
      await page.waitForTimeout(150);
      now = await read();
      steps++;
    } while ((where === "top" || where === "bottom") && steps < 60 && now.first === start.first && (up ? now.top > 0 : now.top < now.max - 1));
    say(`scroll ${where} [${info.name}]: ${steps} steps, scrollTop ${now.top}/${now.max}, ${now.rows} rows, first row ${start.first}${now.first === start.first ? "" : ` -> ${now.first}`}, on top before the last step ${before.onTop}`);
  });
}

async function attach() {
  const file = args[0] && resolve(args[0]);
  if (!file || !existsSync(file)) throw new Error("attach <existing file>");
  await withPage(async (page, info) => {
    const button = page.locator(flags.button ?? 'role=button[name="Attach a file"]');
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: TIMEOUT }),
      info.kind === "phone" ? button.tap({ timeout: TIMEOUT }) : button.click({ timeout: TIMEOUT }),
    ]);
    await chooser.setFiles(file);
    say(`attach ${basename(file)} via the file chooser [${info.name}]`);
  });
}

async function waitSettle() {
  const limit = Number(flags.timeout ?? 30_000);
  await withPage(async (page, info) => {
    const started = Date.now();
    let last = "";
    let since = started;
    let seen;
    while (Date.now() - started < limit) {
      seen = await page.evaluate((busy) => {
        const all = document.querySelectorAll("[data-orbit-message]");
        const tail = all[all.length - 1];
        return { busy: Boolean(document.querySelector(busy)), kind: tail?.getAttribute("data-orbit-message") ?? "none", text: (tail?.innerText ?? "").replace(/\s+/g, " ").trim() };
      }, BUSY);
      const key = JSON.stringify(seen);
      if (key !== last) {
        last = key;
        since = Date.now();
      } else if (!seen.busy && seen.kind !== "user" && (!flags.text || seen.text.includes(flags.text)) && Date.now() - since >= 600) {
        return say(`settled [${info.name}] ${Date.now() - started}ms: ${seen.kind} "${seen.text.slice(0, 100)}"`);
      }
      await page.waitForTimeout(100);
    }
    process.exitCode = 1;
    say(`FAIL wait-settle [${info.name}]: not settled in ${limit}ms (busy ${seen?.busy}, last ${seen?.kind} "${seen?.text.slice(0, 60)}")`);
  });
}

const CHECKS = {
  visible: async (target) => ((await target.first().isVisible()) ? [true, "visible"] : [false, "not visible"]),
  hidden: async (target) => ((await target.first().isVisible()) ? [false, "visible"] : [true, "hidden"]),
  "in-view": async (target) => {
    const ok = await target.first().evaluate((el) => {
      // Transcript rows are display: contents, with no box of their own: measure what they hold.
      const range = document.createRange();
      range.selectNodeContents(el);
      const box = getComputedStyle(el).display === "contents" ? range.getBoundingClientRect() : el.getBoundingClientRect();
      const frame = el.closest("[data-orbit-transcript]")?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
      return box.height > 0 && box.bottom > Math.max(frame.top, 0) && box.top < Math.min(frame.bottom, innerHeight) && box.right > 0 && box.left < innerWidth;
    }, null, { timeout: 1000 });
    return [ok, ok ? "in view" : "out of view"];
  },
  text: async (target, value) => {
    const raw = await target.first().evaluate((el) => (el.matches("input, textarea, select") ? el.value : el.innerText), null, { timeout: 1000 });
    const text = raw.replace(/\s+/g, " ").trim();
    return [text.includes(value), JSON.stringify(text.slice(0, 120))];
  },
  count: async (target, value) => {
    const [, op = "=", want] = /^(>=|<=|>|<|=)?(\d+)$/.exec(value ?? "") ?? [];
    if (want === undefined) throw new Error("count needs a value like 3, >200 or <=5");
    const count = await target.count();
    return [{ "=": count === +want, ">": count > +want, "<": count < +want, ">=": count >= +want, "<=": count <= +want }[op], `${count}`];
  },
};

async function expect() {
  const [proof, kind, selector, value] = args;
  if (!proof || !CHECKS[kind] || !selector) throw new Error(`expect <proof> ${Object.keys(CHECKS).join("|")} <selector> [value]`);
  const limit = Number(flags.timeout ?? 5000);
  await withPage(async (page, info, state) => {
    const deadline = Date.now() + limit;
    let ok;
    let detail;
    do {
      [ok, detail] = await CHECKS[kind](page.locator(selector), value).catch((error) => [false, error.message.split("\n")[0]]);
      if (!ok) await page.waitForTimeout(150);
    } while (!ok && Date.now() < deadline);
    const line = `${ok ? "PASS" : "FAIL"} ${proof} [${info.name}]: ${kind} ${selector}${value === undefined ? "" : ` ${value}`} -> ${detail}`;
    appendFileSync(join(state.run, "proofs.log"), `${new Date().toISOString()} ${line}\n`);
    say(line);
    if (!ok) process.exitCode = 1;
  });
}

async function snapshot() {
  await withPage(async (page) => {
    const tree = (await page.locator(flags.selector ?? "body").ariaSnapshot({ timeout: TIMEOUT })).split("\n");
    const max = Number(flags.lines ?? 80);
    console.log(tree.slice(0, max).map((line) => (line.length > 160 ? `${line.slice(0, 157)}...` : line)).join("\n"));
    if (tree.length > max) console.log(`... ${tree.length - max} more lines (narrow with --selector or raise --lines)`);
  });
}

async function shot() {
  const name = args[0];
  if (!/^[\w.-]+$/.test(name ?? "")) throw new Error("shot <name> (letters, digits, . _ -)");
  await withPage(async (page, info, state) => {
    const file = join(state.run, "shots", `${name}.png`);
    const options = { path: file, animations: "disabled", timeout: TIMEOUT };
    await (flags.selector ? page.locator(flags.selector).screenshot(options) : page.screenshot({ ...options, fullPage: Boolean(flags.full) }));
    appendFileSync(join(state.run, "shots.jsonl"), `${JSON.stringify({ name, page: info.name, kind: info.kind, engine: info.engine, file: relative(state.run, file) })}\n`);
    say(`shot ${name} [${info.name}]: ${file}`);
  });
}

async function evaluate() {
  const source = args.join(" ");
  if (!source) throw new Error("eval <expression>");
  if (/\.(click|dispatchEvent|submit|focus|blur|setItem|removeItem)\s*\(|\bfetch\s*\(/.test(source)) throw new Error("eval only reads; drive with click, type and press");
  await withPage(async (page) => {
    const value = await page.evaluate((code) => {
      const watch = new MutationObserver(() => {});
      watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      try {
        const result = (0, eval)(code);
        if (watch.takeRecords().length) throw new Error("eval changed the DOM; drive with click, type and press");
        return result;
      } finally {
        watch.disconnect();
      }
    }, source);
    say(JSON.stringify(value)?.slice(0, 2000) ?? "undefined");
  });
}

async function reload() {
  await withPage(async (page, info) => {
    await page.reload();
    await page.locator(NAV).waitFor({ state: "attached", timeout: 30_000 });
    say(`reload [${info.name}]`);
  });
}

async function sheet() {
  const state = loadState();
  const rows = new Map();
  for (const shot of lines(join(state.run, "shots.jsonl")).map((line) => JSON.parse(line))) {
    if (args.length && !args.includes(shot.name)) continue;
    const base = shot.name.replace(/[-_](desktop|phone)(-webkit)?$/, "");
    rows.set(base, { ...rows.get(base), [shot.kind]: shot });
  }
  if (!rows.size) throw new Error("no matching shots: take some with shot <name>");
  const cell = (shot) => (shot
    ? `<figure><img src="data:image/png;base64,${readFileSync(join(state.run, shot.file)).toString("base64")}"><figcaption>${shot.name} (${shot.engine})</figcaption></figure>`
    : "<figure class=none>no shot</figure>");
  const html = `<!doctype html><meta charset=utf-8><style>
    body { margin: 0; padding: 40px; background: #0b0d12; color: #e8ecf4; font: 600 28px system-ui, sans-serif; }
    h1 { margin: 0 0 28px; font-size: 44px; }
    .grid { display: grid; grid-template-columns: auto auto; gap: 20px 40px; justify-content: start; align-items: start; }
    .head { font-size: 34px; color: #9aa6ff; }
    h2 { grid-column: 1 / -1; margin: 24px 0 0; padding-bottom: 8px; border-bottom: 4px solid #5b6cff; font-size: 38px; }
    figure { margin: 0; }
    img { display: block; max-height: 560px; max-width: 900px; border: 2px solid #343b52; border-radius: 10px; }
    figcaption { margin-top: 8px; font-size: 24px; color: #a9b3cc; }
    .none { padding: 40px; border: 2px dashed #343b52; color: #6b7390; }
  </style><h1>${basename(state.checkout)} ${state.sha.slice(0, 7)}</h1><div class=grid><div class=head>Desktop 1440x900</div><div class=head>Phone 390x844</div>${[...rows].map(([base, shots]) => `<h2>${base}</h2>${cell(shots.desktop)}${cell(shots.phone)}`).join("")}</div>`;
  const file = join(state.run, `${flags.name ?? "sheet"}.png`);
  await ensureBrowser(state, "chromium");
  const browser = await connect("chromium");
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    await page.setContent(html);
    await page.screenshot({ path: file, fullPage: true });
    await context.close();
  } finally {
    await browser.close();
  }
  say(`sheet ${file}: ${rows.size} rows`);
}

async function seed() {
  const state = loadState();
  const total = Number(flags.long ?? 320);
  const { instances } = await api(state, "GET", "/api/instances");
  let { bots } = await api(state, "GET", "/api/bots?messages=0");
  for (const [name, instanceId] of Object.entries(BOTS)) {
    if (bots.some((bot) => bot.name === name)) {
      say(`bot ${name}: exists`);
      continue;
    }
    const instance = instances.find((entry) => entry.instanceId === instanceId);
    const model = instance?.models.default || instance?.models.options[0]?.id;
    if (!model) throw new Error(`instance ${instanceId} lists no model`);
    await api(state, "POST", "/api/bots", { name, title: `${instanceId} stub`, job: `Replies through the ${instanceId} stub.`, modelSelection: { mode: "pinned", instanceId, model } });
    say(`bot ${name}: ${instanceId} ${model}`);
  }
  ({ bots } = await api(state, "GET", "/api/bots?messages=0"));
  const bot = bots.find((entry) => entry.name === "Atlas");
  const page = async (before) => api(state, "GET", `/api/threads/${bot.threadId}/messages?limit=200${before ? `&before=${before}` : ""}`);
  let count = 0;
  for (let before = "", more = true; more;) {
    const { messages, hasMore } = await page(before);
    count += messages.length;
    more = hasMore && messages.length > 0;
    before = messages[0]?.id;
  }
  const started = Date.now();
  for (let turn = Math.floor(count / 2) + 1; count < total; turn++) {
    const lastId = (await api(state, "GET", `/api/threads/${bot.threadId}/messages?limit=1`)).messages.at(-1)?.id;
    await api(state, "POST", `/api/bots/${bot.id}/messages`, { text: `seed ${String(turn).padStart(3, "0")}: ${PHRASES[turn % PHRASES.length]}` });
    await until(async () => {
      const last = (await api(state, "GET", `/api/threads/${bot.threadId}/messages?limit=1`)).messages.at(-1);
      return last && last.id !== lastId && last.role === "bot";
    }, 30_000, `reply ${turn}`);
    await until(async () => !(await api(state, "GET", "/api/bots?messages=0")).bots.find((entry) => entry.id === bot.id)?.busy, 30_000, "Atlas idle");
    count += 2;
  }
  say(`chat Atlas: ${count} messages${Date.now() - started > 1000 ? ` (${secs(started)}s)` : ""}`);
}

function processTable() {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; CommandLine = $_.CommandLine; Created = $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) } } | ConvertTo-Json -Compress";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });
  return new Map(JSON.parse(out).map((proc) => [proc.ProcessId, proc]));
}

function portOwner(port) {
  const script = `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  return out ? Number(out) : null;
}

const roots = (state) => [
  ["server", state.server.pid, join(state.checkout, "server", "index.ts")],
  ...Object.entries(state.browsers).map(([engine, host]) => [`browser ${engine}`, host.pid, `browser-host ${engine}`]),
];

const ownsCommand = (proc, script) => [HIDDEN, script].every((part) => (proc?.CommandLine ?? "").toLowerCase().includes(part.toLowerCase()));

function ourProcesses(table, rootList) {
  const markers = [ROOT, SKILL].map((marker) => marker.toLowerCase());
  const found = new Map(rootList.filter(([, pid, script]) => ownsCommand(table.get(pid), script)).map(([, pid]) => [pid, table.get(pid)]));
  for (let grew = true; grew;) {
    grew = false;
    for (const proc of table.values()) {
      const parent = found.get(proc.ParentProcessId);
      if (found.has(proc.ProcessId) || !parent || proc.Created < parent.Created) continue;
      if (!markers.some((marker) => (proc.CommandLine ?? "").toLowerCase().includes(marker))) continue;
      found.set(proc.ProcessId, proc);
      grew = true;
    }
  }
  return [...found.values()];
}

async function doctor() {
  const state = loadState();
  let bad = 0;
  const check = (ok, line) => {
    if (!ok) bad++;
    say(`${ok ? "ok " : "BAD"} ${line}`);
  };
  const table = processTable();
  for (const [label, pid, script] of roots(state)) {
    check(ownsCommand(table.get(pid), script), `${label} pid ${pid}: ${table.has(pid) ? "alive" : "gone"}, command line ${ownsCommand(table.get(pid), script) ? "ours" : "not ours"}`);
  }
  const owner = portOwner(state.port);
  check(owner === state.server.pid, `port ${state.port} listener pid ${owner ?? "none"}`);
  const head = git(state.checkout, "rev-parse", "HEAD");
  const served = await fetch(`${state.url}/wink-build.json`).then((r) => r.json()).catch(() => ({}));
  check(served.sha === head, `served build ${String(served.sha).slice(0, 7)} = checkout HEAD ${head.slice(0, 7)}`);
  check(git(state.checkout, "status", "--short") === state.status, `checkout status unchanged since launch (${state.status ? "local changes predate launch" : "clean"})`);
  const data = join(ROOT, "data");
  const orbit = join(homedir(), ".orbit");
  const written = readdirSync(data).filter((entry) => statSync(join(data, entry)).birthtimeMs >= state.booted);
  check(written.length > 0 && !isInside(data, orbit), `data dir ${data}: server created ${written.length} entries, not under ${orbit}`);
  const config = readJson(join(data, "config.json"));
  const described = (await api(state, "GET", "/api/instances")).instances;
  for (const id of Object.keys(ENGINES)) {
    const version = spawnSync(process.execPath, [STUB, id, "--version"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    const listed = described.find((entry) => entry.instanceId === id);
    check(Boolean(config.instances?.[id]?.config?.cli?.includes(STUB) && version && listed), `${id}: cli is the stub (${version || "no answer"}), ${listed ? `listed ${listed.snapshot?.state}` : "not listed"} by the server`);
  }
  const spawns = lines(join(state.run, "spawns.jsonl")).map((line) => JSON.parse(line)).filter((entry) => entry.file);
  const counts = {};
  for (const entry of spawns) counts[basename(entry.file)] = (counts[basename(entry.file)] ?? 0) + 1;
  const denied = [...new Set(spawns.filter((entry) => entry.denied).map((entry) => basename(entry.file)))];
  say(`spawns ${spawns.length}, all forced hidden: ${Object.entries(counts).map(([file, n]) => `${file} ${n}`).join(", ") || "none"}; denied: ${denied.join(", ") || "none"}`);
  say(bad ? `FAIL doctor: ${bad} checks` : "PASS doctor");
  if (bad) process.exitCode = 1;
}

async function cleanup() {
  const state = existsSync(STATE) ? loadState() : null;
  if (state) {
    const before = processTable();
    const ours = ourProcesses(before, roots(state));
    mkdirSync(join(ROOT, "stop"), { recursive: true });
    for (const name of ["server", "browser-chromium", "browser-webkit"]) writeFileSync(join(ROOT, "stop", name), "");
    const rootPids = roots(state).map(([, pid]) => pid).filter((pid) => ours.some((proc) => proc.ProcessId === pid));
    await until(() => rootPids.every((pid) => !alive(pid)), 10_000, "our processes to exit").catch(() => {});
    const after = processTable();
    const killed = [];
    for (const proc of ours) {
      const now = after.get(proc.ProcessId);
      if (!now || now.CommandLine !== proc.CommandLine || now.Created !== proc.Created) continue;
      try {
        process.kill(proc.ProcessId);
        killed.push(proc.ProcessId);
      } catch {}
    }
    say(`stopped ${ours.length} processes we started (${rootPids.join(", ") || "none alive"} and children); force-killed ${killed.join(", ") || "none"}`);
    if (killed.length) await sleep(1000);
  }
  const removed = SCRATCH.filter((name) => existsSync(join(ROOT, name)));
  for (const name of removed) rmSync(join(ROOT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  say(`removed from ${ROOT}: ${removed.join(", ") || "nothing"}`);
  const evidence = join(ROOT, "evidence");
  const runs = existsSync(evidence) ? readdirSync(evidence) : [];
  say(`kept: ${runs.map((run) => `evidence/${run} (${readdirSync(join(evidence, run), { recursive: true }).length} files)`).join(", ") || "no evidence"}`);
}

const COMMANDS = { launch, doctor, seed, open, pages, click, type, press, scroll, attach, "wait-settle": waitSettle, expect, snapshot, shot, eval: evaluate, reload, sheet, cleanup, "browser-host": browserHost };

if (!COMMANDS[command] || flags.help) console.log(HELP);
else {
  try {
    await COMMANDS[command]();
  } catch (error) {
    say(`FAIL ${command}: ${String(error.message).replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0]}`);
    process.exitCode = 1;
  }
}
