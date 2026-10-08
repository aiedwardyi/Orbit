// Phone access end to end: the released packaged server on this machine, the
// live relay, a desktop browser for Settings and a phone-sized one for the phone.
// Setup codes, invites, pairing tokens, cookies and the app token never reach
// stdout or the artifacts; every line goes through redact().
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";

import jsQR from "jsqr";
import { chromium, devices } from "playwright";
import { PNG } from "pngjs";

const CODE = (process.env.RELAY_E2E_CODE ?? "").trim();
const RES = process.env.WINK_RESOURCES;
const OUT = process.env.OUT_DIR;
const WORK = process.env.WORK_DIR;
const MODE = (process.env.ACME_MODE || readFileSync(new URL("./acme.txt", import.meta.url), "utf8")).trim();
const STOP_AFTER_B = process.env.STOP_AFTER_B === "true";
const STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";
const PC1_PORT = 21987;
const PC2_PORT = 21991;
const FAKE_PORT = 21995;
const FAKE_REPLY = "pong from the fake engine";
const BOT_NAME = "Relay Bot";
const SHOTS = join(OUT, "screens");
const PHONE = devices["Pixel 7"];
const PROD = MODE === "production";
const FAKE_ENGINE_ENV = {
  OPENAI_COMPAT_URL: `http://127.0.0.1:${FAKE_PORT}/v1`,
  OPENAI_COMPAT_API_KEY: "e2e-fake-key",
  OPENAI_COMPAT_MODEL: "fake-model",
};

const secrets = new Set();
const hide = (value) => {
  if (typeof value === "string" && value.length >= 6) secrets.add(value);
  return value;
};

/** `strict` also drops long opaque strings, for server logs. */
function redact(text, strict = false) {
  let out = String(text);
  for (const value of secrets) out = out.split(value).join("[redacted]");
  out = out
    .replace(/\bwk[a-z0-9]{1,3}[._:][A-Za-z0-9._:-]*/g, "[redacted]")
    .replace(/(__Host-wink_phone=)[^;\s"']*/g, "$1[redacted]")
    .replace(/#k=[^\s"')]*/g, "#k=[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
  return strict ? out.replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]") : out;
}

const t0 = Date.now();
const timeline = [];
const results = {};
const timings = {};
const facts = { mode: MODE, bits: process.env.BITS ?? null, serverPatched: process.env.SERVER_PATCHED === "yes", host: null };
const shots = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const since = (start) => +((Date.now() - start) / 1000).toFixed(2);
const log = (line) => console.log(redact(line));

function mark(step, detail) {
  const entry = { t: since(t0), at: new Date().toISOString(), step, ...(detail === undefined ? {} : { detail }) };
  timeline.push(entry);
  log(`[${entry.t.toFixed(1)}s] ${step}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}

function check(letter, name, pass, detail) {
  const entry = (results[letter] ??= { checks: [] });
  entry.checks.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
  mark(`${letter}: ${pass ? "PASS" : "FAIL"} ${name}`, detail);
  return Boolean(pass);
}

function note(letter, text) {
  (results[letter] ??= { checks: [] }).note = text;
  mark(`${letter}: ${text}`);
}

/** Boxes that can hold a setup code, an invite, the QR or the pairing code; masked in every screenshot. */
const SENSITIVE = '[aria-label="Setup code"], [aria-label="Invite"], [aria-label="Phone pairing QR code"], [data-pairing-code]';

async function shot(page, name, options = {}) {
  try {
    await page.screenshot({ path: join(SHOTS, `${name}.png`), ...options, mask: [...(options.mask ?? []), page.locator(SENSITIVE)] });
    shots.push(`${name}.png`);
  } catch (error) {
    log(`screenshot ${name} failed: ${error.message}`);
  }
}

async function until(probe, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms / 1000} s: ${what}`);
    await sleep(250);
  }
}

// ── packaged server ─────────────────────────────────────────────────────

function serverEnv(home, port, extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(RELAY_E2E_CODE|ACME_MODE|OMB_|OGB_|ORBIT_|OPENAI_COMPAT_)/.test(key)) delete env[key];
  // What Electron's startServerOn passes, minus the desktop-only credential plumbing.
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
    OMB_STATIC_DIR: join(RES, "ui"),
    OMB_RESOURCES_PATH: RES,
    OMB_SKILLS_DIR: join(RES, "skills"),
    OMB_USER_DATA: `${home}-userdata`,
    OMB_PACKAGED: "1",
    ORBIT_REMOTE_AUTO: "0",
    ...extra,
  };
}

async function api(server, path, init = {}) {
  const res = await fetch(`${server.origin}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}`, ...init.headers },
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}

/** Boots resources/server/packaged-boot.js and takes its app token the way Electron's waitForAppToken does. */
async function startServer(name, home, port, extra = {}) {
  mkdirSync(home, { recursive: true });
  const logPath = join(WORK, `${name}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, [join(RES, "server", "packaged-boot.js")], {
    env: serverEnv(home, port, extra),
    stdio: ["ignore", fd, fd, "ipc"],
    windowsHide: true,
  });
  closeSync(fd);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: no app token within 90 s`)), 90_000);
    child.on("message", (message) => {
      if (message?.type !== "orbit:api-token" || !/^[a-f0-9]{48}$/.test(message.token ?? "")) return;
      clearTimeout(timer);
      resolve(message.token);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name}: server exited (${code}) before its app token`));
    });
  });
  hide(token);
  const server = { name, home, port, token, child, exited, logPath, origin: `http://127.0.0.1:${port}` };
  const started = Date.now();
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`${name}: server exited (${child.exitCode}) during boot`);
    return (await api(server, "/api/phone-relay/status")).status === 200;
  }, 180_000, `${name} phone access routes`);
  mark(`${name}: server up`, { port, bootS: since(started) });
  return server;
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill();
  await Promise.race([server.exited, sleep(15_000)]);
  await until(async () => !(await fetch(`${server.origin}/api/health`, { signal: AbortSignal.timeout(1_000) }).then(() => true, () => false)), 30_000, `${server.name} port free`);
}

const relayStatus = async (server) => (await api(server, "/api/phone-relay/status")).body;

/** Logs every relay state change on the server side until the returned stop is called. */
function watchRelay(server) {
  let last = null;
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const status = await relayStatus(server).catch(() => null);
      const key = status && `${status.state}|${status.lastError ?? ""}|${status.problem ?? ""}`;
      if (status && key !== last) {
        last = key;
        mark(`${server.name}: relay ${status.state}`, { lastError: status.lastError, problem: status.problem, rttMs: status.relayRttMs });
      }
      await sleep(500);
    }
  })();
  return () => {
    stopped = true;
  };
}

function peerCert(host) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port: 443, servername: host, ALPNProtocols: ["http/1.1"], rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      resolve({
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        subjectCN: cert.subject?.CN ?? null,
        issuerO: cert.issuer?.O ?? null,
        issuerCN: cert.issuer?.CN ?? null,
        san: cert.subjectaltname ?? null,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        fingerprint256: cert.fingerprint256,
      });
      socket.end();
    });
    socket.setTimeout(30_000, () => socket.destroy(new Error("TLS timeout")));
    socket.on("error", reject);
  });
}

function fileHash(path) {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16) : null;
}

function startFakeEngine() {
  const stats = { requests: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      stats.requests += 1;
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      }
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "not found" } }));
      }
      let stream = false;
      try {
        stream = JSON.parse(body).stream === true;
      } catch {}
      const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: FAKE_REPLY }, finish_reason: "stop" }], usage }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const piece of FAKE_REPLY.split(/(?= )/)) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(FAKE_PORT, "127.0.0.1", () => resolve({ server, stats })));
}

// ── browsers ────────────────────────────────────────────────────────────

let browser;

/** Desktop window: Electron adds the app token to the window's own /api requests (electron/local-api-auth.mjs); so does this. */
async function desktop(server) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "en-US", serviceWorkers: "block" });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("omb-onboarding-done", "true");
    } catch {}
  });
  await context.route(
    (url) => url.origin === server.origin && url.pathname.startsWith("/api/"),
    (route) => route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${server.token}` } }),
  );
  const page = await context.newPage();
  await page.goto(`${server.origin}/`, { waitUntil: "domcontentloaded" });
  return { context, page };
}

const phoneContext = (extra = {}) => browser.newContext({ ...PHONE, locale: "en-US", ignoreHTTPSErrors: !PROD, ...extra });

/** Settings > Connections > Phone access. Returns the section. */
async function openPhoneAccess(page) {
  await page.getByRole("button", { name: "App settings" }).first().click({ timeout: 90_000 });
  await page.getByRole("dialog").getByRole("button", { name: "Connections", exact: true }).click();
  const title = page.getByText("Phone access from anywhere", { exact: true });
  await title.waitFor({ timeout: 30_000 });
  await title.scrollIntoViewIfNeeded();
  return title.locator("..");
}

function decodeQr(png) {
  const image = PNG.sync.read(png);
  const found = jsQR(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length), image.width, image.height);
  return found?.data ?? null;
}

/** The current document's load marks in ms from navigation start, and how many of its fetches opened a new connection. */
const loadTiming = (page) =>
  page
    .evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      if (!nav) return null;
      const marks = ["domainLookupStart", "connectStart", "secureConnectionStart", "connectEnd", "requestStart", "responseStart", "responseEnd", "domInteractive", "domContentLoadedEventEnd"];
      const resources = performance.getEntriesByType("resource");
      return {
        ...Object.fromEntries(marks.map((mark) => [mark, Math.round(nav[mark])])),
        bytes: nav.encodedBodySize,
        resources: resources.length,
        newConnections: resources.filter((entry) => entry.connectEnd > entry.connectStart).length,
      };
    })
    .catch(() => null);

const isAppData = (host) => (response) => {
  const url = new URL(response.url());
  return url.host === host && url.pathname === "/api/bots" && response.status() === 200;
};

// ── the flow ────────────────────────────────────────────────────────────

let pc1 = null;
let pc2 = null;
let fake = null;
let stopWatch = () => {};
let fatal = null;

/** One part of the flow. A throw fails it and the flow goes on with whatever doesn't need it. */
async function part(letter, name, run, pages = []) {
  try {
    return await run();
  } catch (error) {
    for (const [index, page] of pages.entries()) if (page && !page.isClosed()) await shot(page, `${letter}-failed-${name.replace(/\W+/g, "-").slice(0, 40)}-${index}`);
    check(letter, name, false, { error: redact(error?.message ?? String(error)).split("\n")[0] });
    return null;
  }
}

async function flow() {
  if (!["staging", "production"].includes(MODE)) throw new Error(`unknown ACME mode ${MODE}`);
  hide(CODE);
  hide(CODE.split(":").slice(2).join(":"));
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(WORK, { recursive: true });
  mark("start", { mode: MODE, node: process.version, bits: facts.bits, serverPatched: facts.serverPatched });

  // b. Fresh data dir, own port, remote auto off. Staging keeps production certificates for the final run.
  const home1 = join(WORK, "pc1", "home");
  if (!PROD) {
    mkdirSync(join(home1, ".orbit"), { recursive: true });
    writeFileSync(join(home1, ".orbit", "config.json"), `${JSON.stringify({ phoneRelay: { acmeDirectories: [STAGING] } }, null, 2)}\n`);
  }
  fake = await startFakeEngine();
  pc1 = await startServer("pc1", home1, PC1_PORT, FAKE_ENGINE_ENV);
  const fresh = await relayStatus(pc1);
  check("b", "packaged server starts with phone access available and not set up", fresh.available === true && fresh.configured === false && fresh.state === "off", {
    available: fresh.available,
    configured: fresh.configured,
    state: fresh.state,
  });
  if (STOP_AFTER_B) return note("c", "skipped: stop after b");
  if (!CODE) return note("c", "skipped: no RELAY_E2E_CODE secret");
  const created = await api(pc1, "/api/bots", { method: "POST", body: JSON.stringify({ name: BOT_NAME, modelSelection: { instanceId: "openaiCompat", model: "fake-model", mode: "pinned" } }) });
  mark("h: bot on the fake engine", { status: created.status, error: created.body?.error ?? null });

  // c. Settings > Phone access > paste the code > Set up.
  stopWatch = watchRelay(pc1);
  let desk = await desktop(pc1);
  await shot(desk.page, "c0-desktop-home");
  const section = await openPhoneAccess(desk.page);
  await shot(desk.page, "c1-setup-card");
  const input = desk.page.getByLabel("Setup code");
  await input.fill(CODE);
  await shot(desk.page, "c2-code-pasted", { mask: [input] });
  const setupAnswer = desk.page.waitForResponse((r) => r.url().endsWith("/api/phone-relay/setup"), { timeout: 180_000 });
  const pressed = Date.now();
  await desk.page.locator("form[data-phone-access-setup] button[type=submit]").click();
  mark("c: pressed Set up");
  await shot(desk.page, "c3-submitting", { mask: [input] });
  const setup = await setupAnswer;
  const setupBody = await setup.json().catch(() => ({}));
  mark("c: setup answered", { status: setup.status(), state: setupBody.state ?? null, error: setupBody.error ?? null, afterS: since(pressed) });
  const seen = [];
  let connectedUi = null;
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const alert = section.locator('[role="alert"]');
    if (await alert.count()) {
      const message = (await alert.first().textContent())?.trim();
      await shot(desk.page, "c4-setup-error");
      check("c", "setup code connects this PC", false, { message, states: seen });
      throw new Error(`setup failed: ${message}`);
    }
    const state = await section.locator("[data-phone-access-state]").getAttribute("data-phone-access-state", { timeout: 1_000 }).catch(() => null);
    if (state && !seen.includes(state)) {
      seen.push(state);
      mark(`c: Settings shows ${state}`, { afterS: since(pressed) });
      await section.scrollIntoViewIfNeeded();
      await shot(desk.page, `c4-state-${state}`);
    }
    if (state === "connected") {
      connectedUi = since(pressed);
      break;
    }
    await sleep(250);
  }
  timings.pasteToConnectedS = connectedUi;
  const status1 = await relayStatus(pc1);
  facts.host = status1.host;
  check("c", "setup code connects this PC", connectedUi !== null && status1.state === "connected", { seconds: connectedUi, states: seen, host: status1.host, base: status1.base });
  if (connectedUi === null) throw new Error("Settings never showed connected");
  const host = status1.host;

  // d. Add a phone > QR. If the QR doesn't decode, the phone still gets the link from the API answer.
  const link = await part(
    "d",
    "Add a phone shows a QR for the pairing link",
    async () => {
      const pairingAnswer = desk.page.waitForResponse((r) => r.url().endsWith("/api/phone/pairing") && r.request().method() === "POST");
      await desk.page.getByRole("button", { name: "Add a phone" }).click();
      const pairing = await (await pairingAnswer).json();
      hide(pairing.url);
      hide(pairing.code);
      const minted = Date.now();
      const pairUrl = new URL(pairing.url);
      const token = hide(new URLSearchParams(pairUrl.hash.slice(1)).get("k") ?? "");
      const qr = desk.page.locator('[aria-label="Phone pairing QR code"]');
      await qr.waitFor();
      const decoded = hide(decodeQr(await qr.screenshot()));
      await shot(desk.page, "d1-qr-shown", { mask: [qr, desk.page.locator("[data-pairing-code]")] });
      check("d", "QR decodes to exactly the pairing URL", decoded !== null && decoded === pairing.url, { decoded: decoded !== null });
      check("d", "pairing URL is https://<host>/pair with the token in the fragment", pairUrl.protocol === "https:" && pairUrl.host === host && pairUrl.pathname === "/pair" && token.startsWith("wkp_") && !pairUrl.search, {
        host: pairUrl.host,
        path: pairUrl.pathname,
      });
      return { url: decoded ?? pairing.url, minted, token };
    },
    [desk.page],
  );
  if (!link) return;

  // e. The phone opens the decoded link.
  const phoneCtx = await phoneContext();
  const phone = await phoneCtx.newPage();
  const paired = await part(
    "e",
    "phone pairs and the app loads its data through the relay",
    async () => {
      const appData = phone.waitForResponse(isAppData(host), { timeout: 120_000 });
      appData.catch(() => {});
      const scanned = Date.now();
      await phone.goto(link.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      timings.pairPageLoad = await loadTiming(phone);
      mark("e: pair page loaded", { afterS: since(scanned), timing: timings.pairPageLoad });
      await shot(phone, "e1-phone-pairing");
      await phone.waitForURL((url) => url.pathname === "/", { timeout: 90_000 });
      const pairedAt = Date.now();
      await appData;
      timings.qrToAppOnPhoneS = since(scanned);
      timings.pairedToAppDataS = since(pairedAt);
      timings.appFirstLoad = await loadTiming(phone);
      facts.serviceWorker = await phone
        .evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]))
        .catch(() => null);
      check("e", "phone pairs and the app loads its data through the relay", true, {
        seconds: timings.qrToAppOnPhoneS,
        origin: new URL(phone.url()).origin,
        serviceWorker: facts.serviceWorker,
        appLoad: timings.appFirstLoad,
      });
      await phone.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await shot(phone, "e2-phone-app-first-open");
      const landed = new URL(phone.url());
      check("e", "token is gone from the URL", !phone.url().includes("#k=") && !phone.url().includes(link.token) && landed.pathname === "/" && !landed.hash, { path: landed.pathname, hash: Boolean(landed.hash) });
      const cookie = (await phoneCtx.cookies(`https://${host}`)).find((c) => c.name === "__Host-wink_phone");
      hide(cookie?.value);
      check("e", "phone cookie is host-only, HttpOnly, Secure, SameSite=Lax", Boolean(cookie?.httpOnly && cookie.secure && cookie.sameSite === "Lax" && cookie.path === "/" && cookie.domain === host), {
        present: Boolean(cookie),
        httpOnly: cookie?.httpOnly,
        secure: cookie?.secure,
        sameSite: cookie?.sameSite,
        domain: cookie?.domain,
        days: cookie ? Math.round((cookie.expires * 1000 - Date.now()) / 86_400_000) : null,
      });
      const desktopNoticed = await desk.page.getByText(/is paired\.$/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      await shot(desk.page, "e3-desktop-paired", { mask: [desk.page.locator('[aria-label="Phone pairing QR code"]'), desk.page.locator("[data-pairing-code]")] });
      mark("e: desktop shows the phone as paired", { shown: desktopNoticed });
      return true;
    },
    [phone, desk.page],
  );

  // g2 now, inside the 2 minute window, so the second try fails for being used, not expired.
  if (paired) {
    const second = await phoneContext();
    const p2 = await second.newPage();
    await part(
      "g",
      "used pairing link fails a second time",
      async () => {
        const reuse = p2.waitForResponse((r) => r.url().endsWith("/api/phone/pair"), { timeout: 60_000 });
        reuse.catch(() => {});
        await p2.goto(link.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
        const reused = await reuse;
        const reusedBody = await reused.json().catch(() => ({}));
        await p2.locator("#status.error").waitFor({ timeout: 30_000 }).catch(() => {});
        const reuseText = (await p2.locator("#status").textContent().catch(() => ""))?.trim();
        await shot(p2, "g2-used-link-refused");
        const reuseCookie = (await second.cookies()).some((c) => c.name === "__Host-wink_phone");
        check("g", "used pairing link fails a second time", reused.status() === 409 && reusedBody.error === "no-pairing" && !reuseCookie, {
          status: reused.status(),
          error: reusedBody.error,
          message: reuseText,
          secondsSinceQr: since(link.minted),
          cookie: reuseCookie,
        });
      },
      [p2],
    );
    await second.close();
  }

  // Certificate the phone was served.
  const cert = await part("e", "certificate names exactly the host", async () => {
    const served = await peerCert(host);
    facts.cert = served;
    if (PROD) {
      check("e", "certificate is a trusted Let's Encrypt certificate for exactly the host", served.authorized && served.issuerO === "Let's Encrypt" && served.san === `DNS:${host}`, served);
    } else {
      check("e", "certificate (staging) names exactly the host", served.san === `DNS:${host}` && /STAGING/.test(`${served.issuerO} ${served.issuerCN}`), served);
    }
    return served;
  });

  // Live update: a change on the desktop reaches the phone's event stream.
  if (paired) {
    await part(
      "e",
      "a desktop change reaches the phone's /api/events within 5 s",
      async () => {
        await phone.evaluate(() => {
          window.__e2e = [];
          const source = new EventSource("/api/events?screens=off");
          source.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data);
              window.__e2e.push({ at: Date.now(), kind: data.kind, name: data.profile?.name ?? null });
            } catch {}
          };
        });
        await phone.waitForFunction(() => window.__e2e.some((event) => event.kind === "hello"), null, { timeout: 30_000 });
        const profileName = `Relay check ${Date.now() % 100_000}`;
        const changed = Date.now();
        const patched = await api(pc1, "/api/config", { method: "PATCH", body: JSON.stringify({ profile: { name: profileName } }) });
        const arrivedAt = await phone
          .waitForFunction((name) => window.__e2e.find((event) => event.kind === "config" && event.name === name)?.at ?? false, profileName, { timeout: 20_000 })
          .then((handle) => handle.jsonValue(), () => null);
        timings.liveUpdateMs = arrivedAt ? arrivedAt - changed : null;
        const kinds = await phone.evaluate((after) => window.__e2e.filter((event) => event.at >= after).map((event) => event.kind), changed);
        check("e", "a desktop change reaches the phone's /api/events within 5 s", patched.status === 200 && arrivedAt && arrivedAt - changed < 5_000, {
          ms: timings.liveUpdateMs,
          patch: patched.status,
          kindsSeen: [...new Set(kinds)],
        });
        await phone.evaluate(() => localStorage.setItem("omb-onboarding-done", "true"));
        const reloadData = phone.waitForResponse(isAppData(host), { timeout: 60_000 });
        reloadData.catch(() => {});
        await phone.reload({ waitUntil: "domcontentloaded" });
        await reloadData;
        await phone.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await shot(phone, "e4-phone-app");
      },
      [phone],
    );
  }

  // g3. A phone without the cookie gets no app data.
  const anon = await phoneContext();
  const anonPage = await anon.newPage();
  await part(
    "g",
    "phone without the cookie gets no app data",
    async () => {
      const anonApi = await anon.request.get(`https://${host}/api/bots`, { maxRedirects: 0 });
      const anonApiBody = await anonApi.text();
      const anonShell = await anon.request.get(`https://${host}/`, { maxRedirects: 0 });
      await anonPage.goto(`https://${host}/`, { waitUntil: "domcontentloaded" });
      await shot(anonPage, "g3-no-cookie");
      const anonPath = new URL(anonPage.url()).pathname;
      check("g", "phone without the cookie gets no app data", anonApi.status() === 401 && !anonApiBody.includes(BOT_NAME) && anonShell.status() === 302 && anonPath === "/pair", {
        api: anonApi.status(),
        shell: anonShell.status(),
        location: anonShell.headers().location ?? null,
        landedOn: anonPath,
      });
    },
    [anonPage],
  );
  await anon.close();

  // f1. Reopen the phone from its saved storage state. The first phone stays open for the offline page in f2.
  let reopened = null;
  let rp = null;
  if (paired) {
    reopened = await phoneContext({ storageState: await phoneCtx.storageState() });
    rp = await reopened.newPage();
    await part(
      "f",
      "reopened phone opens the app without pairing",
      async () => {
        const reopenData = rp.waitForResponse(isAppData(host), { timeout: 60_000 });
        reopenData.catch(() => {});
        const reopenedAt = Date.now();
        await rp.goto(`https://${host}/`, { waitUntil: "domcontentloaded" });
        await reopenData;
        timings.reopenToAppDataS = since(reopenedAt);
        await rp.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await shot(rp, "f1-phone-reopened");
        check("f", "reopened phone opens the app without pairing", new URL(rp.url()).pathname === "/", { path: new URL(rp.url()).pathname, seconds: timings.reopenToAppDataS });
      },
      [rp],
    );
  }

  // f2. Restart on the same data dir: no new code, no new certificate.
  let recovery = null;
  let connectedAgainAt = null;
  const restartedOk = await part("f", "restart reconnects with no new code", async () => {
    const certFile = join(home1, ".orbit", "phone-relay", "cert.json");
    const certBefore = fileHash(certFile);
    await desk.context.close();
    stopWatch();
    await stopServer(pc1);
    mark("f: server stopped");
    if (rp) {
      await rp.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await shot(rp, "f2-phone-while-pc-down");
    }
    if (paired) recovery = await offlinePage(phone, host);
    const restarted = Date.now();
    pc1 = await startServer("pc1", home1, PC1_PORT, FAKE_ENGINE_ENV);
    stopWatch = watchRelay(pc1);
    const back = await until(async () => {
      const status = await relayStatus(pc1);
      return status.state === "connected" ? status : null;
    }, 5 * 60_000, "relay connected after restart");
    connectedAgainAt = Date.now();
    timings.restartToConnectedS = since(restarted);
    const certAfterRestart = await peerCert(host);
    check("f", "restart reconnects with no new code", back.host === host, { seconds: timings.restartToConnectedS, host: back.host });
    check("f", "restart keeps the same certificate", certAfterRestart.fingerprint256 === cert?.fingerprint256 && fileHash(certFile) === certBefore, {
      sameServed: certAfterRestart.fingerprint256 === cert?.fingerprint256,
      sameStored: fileHash(certFile) === certBefore,
      stored: certBefore !== null,
    });
    return true;
  });
  if (recovery && restartedOk) {
    const backAt = await recovery.back;
    timings.offlinePageBackInAppS = backAt ? +((backAt - connectedAgainAt) / 1000).toFixed(2) : null;
    await shot(phone, "f3-offline-page-back-in-app");
    check("f", "offline page goes back into the app by itself once the PC is back", backAt !== null, { secondsAfterConnected: timings.offlinePageBackInAppS });
  }
  if (rp && restartedOk) {
    await part(
      "f",
      "phone still works after the restart",
      async () => {
        const afterRestartData = rp.waitForResponse(isAppData(host), { timeout: 60_000 });
        afterRestartData.catch(() => {});
        const reloadedAt = Date.now();
        await rp.goto(`https://${host}/`, { waitUntil: "domcontentloaded" });
        await afterRestartData;
        timings.afterRestartToAppDataS = since(reloadedAt);
        await rp.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await shot(rp, "f3-phone-after-restart");
        check("f", "phone still works after the restart", new URL(rp.url()).pathname === "/", { path: new URL(rp.url()).pathname });
      },
      [rp],
    );
  }

  // h. Message round trip from the phone, on the fake engine.
  if (rp && restartedOk) await messageRoundTrip(rp, created);
  else note("h", "skipped: no paired phone or no server after the restart");

  // g4. Remove the phone in Settings.
  if (rp && restartedOk) {
    desk = await desktop(pc1);
    await part(
      "g",
      "removed phone's next request is refused",
      async () => {
        await openPhoneAccess(desk.page);
        const phones = (await api(pc1, "/api/phone/devices")).body.phones ?? [];
        const remove = desk.page.getByRole("button", { name: `Remove ${phones[0]?.name}` });
        await remove.waitFor({ timeout: 30_000 });
        await remove.scrollIntoViewIfNeeded();
        await shot(desk.page, "g4-before-remove");
        const removal = desk.page.waitForResponse((r) => r.url().includes("/api/phone/devices/") && r.request().method() === "DELETE");
        await remove.click();
        const removed = await removal;
        await desk.page.waitForTimeout(500);
        await shot(desk.page, "g4-after-remove");
        const refusedApi = await reopened.request.get(`https://${host}/api/bots`, { maxRedirects: 0 });
        await rp.goto(`https://${host}/`, { waitUntil: "domcontentloaded" });
        await shot(rp, "g4-removed-phone");
        const removedPath = new URL(rp.url()).pathname;
        check("g", "removed phone's next request is refused", removed.status() === 200 && refusedApi.status() === 401 && removedPath === "/pair", {
          remove: removed.status(),
          api: refusedApi.status(),
          landedOn: removedPath,
          phonesLeft: ((await api(pc1, "/api/phone/devices")).body.phones ?? []).length,
        });
      },
      [desk.page, rp],
    );
    await desk.context.close();
  }
  await reopened?.close();
  await phoneCtx.close();

  // g1. The same code on a second fresh PC. Always staging, so a wrongly accepted code costs no production certificate.
  const home2 = join(WORK, "pc2", "home");
  mkdirSync(join(home2, ".orbit"), { recursive: true });
  writeFileSync(join(home2, ".orbit", "config.json"), `${JSON.stringify({ phoneRelay: { acmeDirectories: [STAGING] } }, null, 2)}\n`);
  pc2 = await startServer("pc2", home2, PC2_PORT);
  const desk2 = await desktop(pc2);
  await part(
    "g",
    "same code on a second fresh PC is refused with a clear message",
    async () => {
      const section2 = await openPhoneAccess(desk2.page);
      const input2 = desk2.page.getByLabel("Setup code");
      await input2.fill(CODE);
      const secondSetup = desk2.page.waitForResponse((r) => r.url().endsWith("/api/phone-relay/setup"), { timeout: 120_000 });
      await desk2.page.locator("form[data-phone-access-setup] button[type=submit]").click();
      const secondAnswer = await secondSetup;
      const secondBody = await secondAnswer.json().catch(() => ({}));
      const refusal = section2.locator('[role="alert"]').first();
      await refusal.waitFor({ timeout: 30_000 }).catch(() => {});
      await desk2.page.waitForTimeout(3_500);
      const refusalText = (await refusal.textContent().catch(() => ""))?.trim();
      await section2.scrollIntoViewIfNeeded().catch(() => {});
      await shot(desk2.page, "g1-second-pc-refused", { mask: [input2] });
      const pc2Status = await relayStatus(pc2);
      check("g", "same code on a second fresh PC is refused with a clear message", secondAnswer.status() === 400 && Boolean(refusalText) && pc2Status.state !== "connected", {
        status: secondAnswer.status(),
        error: secondBody.error ?? null,
        message: refusalText,
        state: pc2Status.state,
      });
    },
    [desk2.page],
  );
  await desk2.context.close();
}

/** The first phone has the pair page's service worker: with the PC down, a page load gets offline.html, which reloads into the app once the PC is back. */
async function offlinePage(page, host) {
  await page.waitForTimeout(3_000);
  await shot(page, "f2-open-app-while-pc-down");
  const back = page.waitForResponse(isAppData(host), { timeout: 120_000 }).then(() => Date.now(), () => null);
  await page.goto(`https://${host}/`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  const message = await page
    .waitForFunction(() => document.getElementById("detail")?.textContent?.trim(), null, { timeout: 20_000 })
    .then((handle) => handle.jsonValue(), () => null);
  await shot(page, "f2-offline-page");
  check("f", "phone shows the offline page while the PC is down", /asleep or Wink is closed/.test(message ?? ""), { message, serviceWorker: facts.serviceWorker });
  // Wrapped: an async function returning the promise itself would wait for the PC to come back.
  return message ? { back } : null;
}

async function messageRoundTrip(page, created) {
  if (created.status !== 200 && created.status !== 201) return note("h", `skipped: the bot on the fake engine was not created (${created.status} ${created.body?.error ?? ""})`);
  try {
    const composer = page.getByPlaceholder(new RegExp(`^Message ${BOT_NAME}`));
    await composer.waitFor({ timeout: 30_000 });
    await composer.fill("ping from the phone");
    const sentAt = Date.now();
    await composer.press("Enter");
    await page.waitForTimeout(500);
    if ((await composer.inputValue()).trim()) await page.getByRole("button", { name: /^Send( message)?$/ }).first().click();
    await page.getByText(FAKE_REPLY).first().waitFor({ timeout: 90_000 });
    timings.messageRoundTripMs = Date.now() - sentAt;
    await shot(page, "h1-phone-message-round-trip");
    check("h", "a message from the phone gets the fake engine's reply through the relay", true, { ms: timings.messageRoundTripMs, engineRequests: fake.stats.requests });
  } catch (error) {
    await shot(page, "h1-phone-message-failed");
    check("h", "a message from the phone gets the fake engine's reply through the relay", false, { error: error.message.split("\n")[0], engineRequests: fake.stats.requests });
  }
}

process.on("unhandledRejection", (error) => log(`unhandled: ${error?.stack ?? error}`));

try {
  // A trusted certificate lets a real phone register the pair page's service worker; staging needs the flag for that.
  browser = await chromium.launch(PROD ? {} : { args: ["--ignore-certificate-errors"] });
  await flow();
} catch (error) {
  fatal = { message: redact(error?.message ?? String(error)).split("\n").slice(0, 6).join("\n") };
  mark("FATAL", fatal);
} finally {
  stopWatch();
  for (const server of [pc1, pc2]) {
    if (!server) continue;
    const final = await relayStatus(server).catch(() => null);
    if (final) mark(`${server.name}: final relay status`, { state: final.state, lastError: final.lastError, problem: final.problem, rttMs: final.relayRttMs });
  }
  await browser?.close().catch(() => {});
  await stopServer(pc1).catch(() => {});
  await stopServer(pc2).catch(() => {});
  fake?.server.close();
  mkdirSync(join(OUT, "logs"), { recursive: true });
  for (const name of ["pc1", "pc2"]) {
    const path = join(WORK, `${name}.log`);
    if (existsSync(path)) writeFileSync(join(OUT, "logs", `${name}-server.log`), redact(readFileSync(path, "utf8"), true));
  }
  const failed = Object.values(results).flatMap((entry) => entry.checks).filter((entry) => !entry.pass);
  const summary = {
    pass: !fatal && failed.length === 0,
    fatal,
    mode: MODE,
    facts,
    timings,
    results,
    screenshots: shots,
  };
  writeFileSync(join(OUT, "summary.json"), `${redact(JSON.stringify(summary, null, 2))}\n`);
  writeFileSync(join(OUT, "timeline.json"), `${redact(JSON.stringify(timeline, null, 2))}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.keys(results)
      .sort()
      .flatMap((letter) => [...results[letter].checks.map((entry) => `| ${letter} | ${entry.pass ? "PASS" : "FAIL"} | ${entry.name} |`), ...(results[letter].note ? [`| ${letter} | - | ${results[letter].note} |`] : [])]);
    const lines = [
      "",
      `### Phone access flow: ${summary.pass ? "PASS" : "FAIL"}`,
      `${facts.serverPatched ? "**Patched server, not the released bits.** " : ""}Bits: ${facts.bits ?? "?"}. ACME: ${MODE}.`,
      "",
      "| Step | Result | Check |",
      "|---|---|---|",
      ...rows,
      "",
      `Timings: ${JSON.stringify(timings)}`,
      ...(fatal ? ["", `Fatal: ${fatal.message.split("\n")[0]}`] : []),
      "",
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, redact(lines.join("\n")));
  }
  log(`\n${summary.pass ? "PASS" : "FAIL"}: ${failed.length} failed checks${fatal ? `, fatal: ${fatal.message}` : ""}`);
  process.exit(summary.pass ? 0 : 1);
}
