import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { createGoogleAccountController, createGoogleSessionPush, googleClient, googleServerEnv, pkcePair, runGoogleSignIn, watchDevServer } from "./google-signin.mjs";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function idToken(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function tokenEndpoint({ status = 200, scope = `openid email ${DRIVE_FILE}`, error, iss = "https://accounts.google.com" } = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(String(init.body))) });
    const body = error
      ? { error }
      : { access_token: "access-SECRET", refresh_token: "refresh-SECRET", scope, id_token: idToken({ iss, aud: CLIENT.id, sub: "sub-1", email: "me@example.com" }) };
    return new Response(JSON.stringify(body), { status: error ? 400 : status });
  });
  return { fetch, calls };
}

function hit(url) {
  return new Promise((resolve, reject) => {
    request(url, { agent: false }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    })
      .on("error", reject)
      .end();
  });
}

/** A browser that follows Google's redirect back with `edit` applied to the callback query. */
function browser(edit = (query) => query.set("code", "auth-code")) {
  const seen = { pages: [] };
  const openExternal = vi.fn(async (authUrl) => {
    const auth = new URL(authUrl);
    seen.auth = auth;
    const callback = new URL(auth.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", auth.searchParams.get("state"));
    edit(callback.searchParams);
    seen.pages.push(await hit(`${callback.origin}/favicon.ico`));
    seen.pages.push(await hit(callback.toString()));
  });
  return { openExternal, seen };
}

/** A token POST that stays pending until released; `honorSignal` makes it reject on abort like real fetch. */
function pendingExchange({ honorSignal }) {
  let release;
  let started;
  const begun = new Promise((resolve) => (started = resolve));
  const reply = new Promise((resolve) => (release = () => resolve(tokenEndpoint().fetch(TOKEN_URL, { body: "" }))));
  const fetch = vi.fn((_url, init) => {
    started();
    if (!honorSignal) return reply;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      reply.then(resolve);
    });
  });
  return { fetch, begun, release };
}

function rawGet(port, target) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write([`GET ${target} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close", "", ""].join("\r\n")));
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}

async function closed(address) {
  await expect(hit(`http://127.0.0.1:${address.port}/`)).rejects.toMatchObject({ code: "ECONNREFUSED" });
}

describe("google sign-in", () => {
  it("makes an S256 PKCE pair", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkcePair().verifier).not.toBe(verifier);
  });

  it("signs in through a 127.0.0.1 listener, then closes it", async () => {
    const endpoint = tokenEndpoint();
    const { openExternal, seen } = browser();
    let address;
    const session = await runGoogleSignIn({ client: CLIENT, openExternal, fetch: endpoint.fetch, onListening: (value) => (address = value) });

    expect(session).toEqual({ refreshToken: "refresh-SECRET", sub: "sub-1", email: "me@example.com", idToken: expect.stringMatching(/^ey/) });
    expect(address.address).toBe("127.0.0.1");
    expect(Object.fromEntries(seen.auth.searchParams)).toMatchObject({
      client_id: CLIENT.id,
      redirect_uri: `http://127.0.0.1:${address.port}`,
      response_type: "code",
      scope: `openid email ${DRIVE_FILE}`,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent select_account",
    });
    expect(seen.auth.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await openExternal.mock.results[0].value;
    expect(seen.pages[0].status).toBe(404);
    expect(seen.pages[1]).toMatchObject({ status: 200 });
    expect(seen.pages[1].text).toContain("You can close this tab.");

    const form = endpoint.calls[0].form;
    expect(form).toMatchObject({ code: "auth-code", grant_type: "authorization_code", client_id: CLIENT.id, client_secret: CLIENT.secret, redirect_uri: `http://127.0.0.1:${address.port}` });
    expect(createHash("sha256").update(form.code_verifier).digest("base64url")).toBe(seen.auth.searchParams.get("code_challenge"));
    await closed(address);
  });

  it("rejects a state mismatch and closes", async () => {
    const endpoint = tokenEndpoint();
    const { openExternal, seen } = browser((query) => {
      query.set("state", "forged");
      query.set("code", "auth-code");
    });
    let address;
    await expect(runGoogleSignIn({ client: CLIENT, openExternal, fetch: endpoint.fetch, onListening: (value) => (address = value) })).rejects.toMatchObject({ code: "state-mismatch" });
    await openExternal.mock.results[0].value;
    expect(seen.pages[1].status).toBe(400);
    expect(endpoint.fetch).not.toHaveBeenCalled();
    await closed(address);
  });

  it("closes on a Google error", async () => {
    const endpoint = tokenEndpoint();
    const { openExternal } = browser((query) => query.set("error", "access_denied"));
    let address;
    await expect(runGoogleSignIn({ client: CLIENT, openExternal, fetch: endpoint.fetch, onListening: (value) => (address = value) })).rejects.toMatchObject({ code: "access-denied" });
    expect(endpoint.fetch).not.toHaveBeenCalled();
    await closed(address);
  });

  it.each([
    ["admin_policy_enforced", "blocked"],
    ["constructor", "google-error"],
    ["server_error", "google-error"],
  ])("maps the callback error %s to %s", async (error, code) => {
    const endpoint = tokenEndpoint();
    const { openExternal } = browser((query) => query.set("error", error));
    await expect(runGoogleSignIn({ client: CLIENT, openExternal, fetch: endpoint.fetch })).rejects.toMatchObject({ code });
    expect(endpoint.fetch).not.toHaveBeenCalled();
  });

  it("answers a raw // request with 400 and keeps waiting for the callback", async () => {
    const endpoint = tokenEndpoint();
    const real = browser();
    let raw;
    const openExternal = async (authUrl) => {
      raw = await rawGet(Number(new URL(new URL(authUrl).searchParams.get("redirect_uri")).port), "//");
      await real.openExternal(authUrl);
    };
    const session = await runGoogleSignIn({ client: CLIENT, openExternal, fetch: endpoint.fetch });
    expect(raw).toMatch(/^HTTP\/1\.1 400 /);
    expect(session.email).toBe("me@example.com");
  });

  it("closes on cancel", async () => {
    const controller = new AbortController();
    let address;
    const run = runGoogleSignIn({ client: CLIENT, openExternal: async () => controller.abort(), fetch: vi.fn(), signal: controller.signal, onListening: (value) => (address = value) });
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
    await closed(address);
  });

  it("a cancel before listen never opens the browser", async () => {
    const controller = new AbortController();
    controller.abort();
    const openExternal = vi.fn(async () => {});
    let address;
    const run = runGoogleSignIn({
      client: CLIENT,
      openExternal,
      fetch: vi.fn(),
      signal: controller.signal,
      onListening: (value) => (address = value),
    });
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
    expect(openExternal).not.toHaveBeenCalled();
    await closed(address);
  });

  it("closes on timeout", async () => {
    let address;
    const run = runGoogleSignIn({ client: CLIENT, openExternal: async () => {}, fetch: vi.fn(), timeoutMs: 50, onListening: (value) => (address = value) });
    await expect(run).rejects.toMatchObject({ code: "timeout" });
    await closed(address);
  });

  it("stores nothing when drive.file was unticked", async () => {
    const endpoint = tokenEndpoint({ scope: "openid email" });
    const saveSession = vi.fn();
    const google = createGoogleAccountController({ client: CLIENT, openExternal: browser().openExternal, fetch: endpoint.fetch, saveSession, clearSession: vi.fn() });
    expect(await google.signIn()).toEqual({ ok: false, error: "drive-permission-missing" });
    expect(saveSession).not.toHaveBeenCalled();
  });

  it("maps admin_policy_enforced on the exchange to blocked", async () => {
    const endpoint = tokenEndpoint({ error: "admin_policy_enforced" });
    const saveSession = vi.fn();
    const google = createGoogleAccountController({ client: CLIENT, openExternal: browser().openExternal, fetch: endpoint.fetch, saveSession, clearSession: vi.fn() });
    expect(await google.signIn()).toEqual({ ok: false, error: "blocked" });
    expect(saveSession).not.toHaveBeenCalled();
  });

  it.each(["cancel", "signOut"])("%s during the token exchange saves nothing", async (action) => {
    for (const honorSignal of [true, false]) {
      const exchange = pendingExchange({ honorSignal });
      const saveSession = vi.fn();
      const google = createGoogleAccountController({ client: CLIENT, openExternal: browser().openExternal, fetch: exchange.fetch, saveSession, clearSession: vi.fn() });
      const run = google.signIn();
      await exchange.begun;
      await google[action]();
      exchange.release();
      expect(await run).toEqual({ ok: false, error: "cancelled" });
      expect(saveSession).not.toHaveBeenCalled();
    }
  });

  it("a newer sign-in wins over a pending exchange", async () => {
    const first = pendingExchange({ honorSignal: false });
    const second = tokenEndpoint();
    const fetch = vi.fn().mockImplementationOnce(first.fetch).mockImplementationOnce(second.fetch);
    const saveSession = vi.fn();
    const google = createGoogleAccountController({ client: CLIENT, openExternal: browser().openExternal, fetch, saveSession, clearSession: vi.fn() });
    const older = google.signIn();
    await first.begun;
    const newer = google.signIn();
    expect(await newer).toEqual({ ok: true, email: "me@example.com" });
    first.release();
    expect(await older).toEqual({ ok: false, error: "cancelled" });
    expect(saveSession).toHaveBeenCalledOnce();
  });

  it.each([null, "https://evil.example.com", "accounts.google.com.evil.example"])("rejects an id token issued by %s", async (iss) => {
    const endpoint = tokenEndpoint({ iss });
    const saveSession = vi.fn();
    const google = createGoogleAccountController({ client: CLIENT, openExternal: browser().openExternal, fetch: endpoint.fetch, saveSession, clearSession: vi.fn() });
    expect(await google.signIn()).toEqual({ ok: false, error: "exchange-failed" });
    expect(saveSession).not.toHaveBeenCalled();
  });

  it.each(["https://accounts.google.com", "accounts.google.com"])("accepts the issuer %s", async (iss) => {
    const google = createGoogleAccountController({ client: CLIENT, openExternal: browser().openExternal, fetch: tokenEndpoint({ iss }).fetch, saveSession: vi.fn(), clearSession: vi.fn() });
    expect(await google.signIn()).toEqual({ ok: true, email: "me@example.com" });
  });

  it("saves the session and returns only the email", async () => {
    const endpoint = tokenEndpoint();
    const saveSession = vi.fn();
    const google = createGoogleAccountController({ client: CLIENT, openExternal: browser().openExternal, fetch: endpoint.fetch, saveSession, clearSession: vi.fn() });
    expect(await google.signIn()).toEqual({ ok: true, email: "me@example.com" });
    // The ID token goes beside the stored session, never inside it.
    expect(saveSession).toHaveBeenCalledExactlyOnceWith({ refreshToken: "refresh-SECRET", sub: "sub-1", email: "me@example.com" }, expect.stringMatching(/^ey/));
  });

  it("keeps tokens out of logs and results", async () => {
    const log = vi.fn();
    const google = createGoogleAccountController({
      client: CLIENT,
      openExternal: browser().openExternal,
      fetch: tokenEndpoint().fetch,
      saveSession: async () => {
        throw new Error("store failed for refresh-SECRET");
      },
      clearSession: vi.fn(),
      log,
    });
    const result = await google.signIn();
    expect(result).toEqual({ ok: false, error: "store-failed" });
    const written = JSON.stringify([result, log.mock.calls]);
    for (const secret of ["refresh-SECRET", "access-SECRET", CLIENT.secret]) expect(written).not.toContain(secret);
  });

  it("signs out with no network call", async () => {
    const fetch = vi.fn();
    const clearSession = vi.fn();
    const openExternal = vi.fn();
    const google = createGoogleAccountController({ client: CLIENT, openExternal, fetch, saveSession: vi.fn(), clearSession });
    expect(await google.signOut()).toEqual({ ok: true });
    expect(clearSession).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("does nothing without a client", async () => {
    const openExternal = vi.fn();
    const fetch = vi.fn();
    const google = createGoogleAccountController({ client: null, openExternal, fetch, saveSession: vi.fn(), clearSession: vi.fn() });
    expect(await google.signIn()).toEqual({ ok: false, error: "unavailable" });
    expect(openExternal).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the client from env, then the baked file, else none", () => {
    const baked = () => ({ id: "baked-id", secret: "baked-secret" });
    const missing = () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    expect(googleClient({ WINK_GOOGLE_CLIENT_ID: "env-id", WINK_GOOGLE_CLIENT_SECRET: "env-secret" }, baked)).toEqual({ id: "env-id", secret: "env-secret" });
    expect(googleClient({ WINK_GOOGLE_CLIENT_ID: "env-id" }, baked)).toEqual({ id: "baked-id", secret: "baked-secret" });
    expect(googleClient({}, missing)).toBeNull();
    expect(googleClient({}, () => ({ id: "only-id" }))).toBeNull();
  });

  it("reads the phone sign-in web client beside the desktop one", () => {
    const env = { WINK_GOOGLE_CLIENT_ID: "env-id", WINK_GOOGLE_CLIENT_SECRET: "env-secret", WINK_GOOGLE_WEB_CLIENT_ID: "env-web" };
    expect(googleClient(env, () => null)).toEqual({ id: "env-id", secret: "env-secret", webId: "env-web" });
    expect(googleClient({}, () => ({ id: "baked-id", secret: "baked-secret", webId: "baked-web" }))).toEqual({ id: "baked-id", secret: "baked-secret", webId: "baked-web" });
    expect(googleServerEnv({ id: "i", secret: "s", webId: "w" })).toEqual({ WINK_GOOGLE_CLIENT_ID: "i", WINK_GOOGLE_CLIENT_SECRET: "s", WINK_GOOGLE_WEB_CLIENT_ID: "w" });
    expect(googleClient({ ...env, WINK_TEAM_RELAY: " wink.example " }, () => null)).toEqual({ id: "env-id", secret: "env-secret", webId: "env-web", teamRelay: "wink.example" });
    expect(googleClient({}, () => ({ id: "baked-id", secret: "baked-secret", teamRelay: "wink.example" }))).toEqual({ id: "baked-id", secret: "baked-secret", teamRelay: "wink.example" });
    expect(googleServerEnv({ id: "i", secret: "s", teamRelay: "wink.example" })).toEqual({ WINK_GOOGLE_CLIENT_ID: "i", WINK_GOOGLE_CLIENT_SECRET: "s", WINK_TEAM_RELAY: "wink.example" });
    const owner = "Owner@Example.com";
    const ownerHash = createHash("sha256").update(owner.toLowerCase()).digest("hex");
    const withOwner = googleClient({ ...env, WINK_TEAM_OWNER: ` ${owner} ` }, () => null);
    expect(withOwner.teamOwner).toBe(ownerHash);
    expect(JSON.stringify(withOwner)).not.toContain(owner.toLowerCase());
    expect(googleClient({}, () => ({ id: "baked-id", secret: "baked-secret", teamOwner: ownerHash })).teamOwner).toBe(ownerHash);
    expect(googleServerEnv({ id: "i", secret: "s", teamOwner: ownerHash })).toEqual({ WINK_GOOGLE_CLIENT_ID: "i", WINK_GOOGLE_CLIENT_SECRET: "s", WINK_TEAM_OWNER: ownerHash });
  });

  it("hands the server the client and never the stored session", () => {
    const googleAccount = { refreshToken: "refresh-token-SECRET", sub: "s", email: "e@x.com" };
    for (const credentials of [{ googleAccount }, {}]) {
      const env = googleServerEnv(CLIENT, credentials);
      expect(env).toEqual({ WINK_GOOGLE_CLIENT_ID: CLIENT.id, WINK_GOOGLE_CLIENT_SECRET: CLIENT.secret });
      expect(JSON.stringify(env)).not.toContain("refresh-token-SECRET");
      expect(env).not.toHaveProperty("OMB_GOOGLE_ACCOUNT_TOKEN");
    }
    expect(googleServerEnv(null, { googleAccount })).toEqual({});
  });
});

describe("Google session delivery", () => {
  it.each([null, { refreshToken: "r", sub: "s", email: "e@x.com" }])("pushes %j over the parent port without HTTP", async (session) => {
    let serverProc = { postMessage: vi.fn() };
    const original = serverProc;
    const fetch = vi.fn();
    const push = createGoogleSessionPush({ isPackaged: true, getServerProcess: () => serverProc, getToken: () => null, getPort: () => 1234, fetch });
    serverProc = { postMessage: vi.fn() };
    await push(session);
    expect(serverProc.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "orbit:google-account", session });
    expect(original.postMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("adds a fresh ID token to the pushed session only when given one", async () => {
    const serverProc = { postMessage: vi.fn() };
    const push = createGoogleSessionPush({ isPackaged: true, getServerProcess: () => serverProc, getToken: () => null, getPort: () => 1234 });
    const session = { refreshToken: "r", sub: "s", email: "e@x.com" };
    await push(session, "id-token");
    await push(session);
    await push(null, "id-token");
    expect(serverProc.postMessage.mock.calls.map(([message]) => message.session)).toEqual([{ ...session, idToken: "id-token" }, session, null]);
    expect(session).not.toHaveProperty("idToken");
  });

  it("uses the current token and port for dev PUT and DELETE", async () => {
    let token = null;
    let port = 1234;
    const fetch = vi.fn(async () => ({ ok: true }));
    const getServerProcess = vi.fn();
    const push = createGoogleSessionPush({ isPackaged: false, getServerProcess, getToken: () => token, getPort: () => port, fetch });
    await push(null);
    expect(fetch).not.toHaveBeenCalled();
    token = "first";
    const session = { refreshToken: "r", sub: "s", email: "e@x.com" };
    await push(session);
    expect(fetch).toHaveBeenLastCalledWith("http://127.0.0.1:1234/api/internal/google-account", expect.objectContaining({
      method: "PUT", headers: { Authorization: "Bearer first", "content-type": "application/json" }, redirect: "error", body: JSON.stringify(session),
    }));
    token = "second";
    port = 2345;
    await push(null);
    expect(fetch).toHaveBeenLastCalledWith("http://127.0.0.1:2345/api/internal/google-account", expect.objectContaining({
      method: "DELETE", headers: { Authorization: "Bearer second" }, redirect: "error",
    }));
    expect(fetch.mock.calls.at(-1)[1]).not.toHaveProperty("body");
    expect(getServerProcess).not.toHaveBeenCalled();
  });

  it("logs failed session pushes without rejecting", async () => {
    const log = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockRejectedValueOnce(new Error("offline"));
    const push = createGoogleSessionPush({ isPackaged: false, getServerProcess: vi.fn(), getToken: () => "token", getPort: () => 1234, fetch, log });
    await expect(push(null)).resolves.toBeUndefined();
    await expect(push(null)).resolves.toBeUndefined();
    expect(log.mock.calls).toEqual([["google account sync failed: HTTP 503"], ["google account sync failed: offline"]]);
    const packaged = createGoogleSessionPush({ isPackaged: true, getServerProcess: () => ({ postMessage: () => { throw new Error("closed"); } }), log });
    await expect(packaged(null)).resolves.toBeUndefined();
    expect(log).toHaveBeenLastCalledWith("google account sync failed: closed");
  });

  it("pushes again only when a new dev server process answers", async () => {
    vi.useFakeTimers();
    try {
      const pids = [1, 1, null, 2, 2];
      const fetch = vi.fn(async () => {
        const pid = pids.shift();
        if (pid === null) throw new Error("down");
        return { json: async () => ({ pid }) };
      });
      const push = vi.fn(async () => {});
      const stop = watchDevServer({ getPort: () => 1234, push, fetch, intervalMs: 100 });
      await vi.advanceTimersByTimeAsync(0);
      expect(push).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(push).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(push).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      expect(push).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:1234/api/health", expect.anything());
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the boot session out of the server env and pushes the live account", () => {
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const signin = readFileSync(new URL("./google-signin.mjs", import.meta.url), "utf8");
    expect(signin.includes("OMB_GOOGLE_ACCOUNT_TOKEN")).toBe(false);
    expect(main.includes("OMB_GOOGLE_ACCOUNT_TOKEN")).toBe(false);
    expect(main.includes("googleServerEnv(GOOGLE_CLIENT,")).toBe(false);
    expect(main.includes("pushGoogleSession(secureCredentials.googleAccount ?? null)")).toBe(true);
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

describe("Google session persistence", () => {
  it("clears after a pending save and pushes null last", async () => {
    const begun = deferred();
    const release = deferred();
    let stored = null;
    const pushes = [];
    const clearSession = vi.fn(async () => { stored = null; pushes.push(null); });
    const google = createGoogleAccountController({
      client: CLIENT, openExternal: browser().openExternal, fetch: tokenEndpoint().fetch,
      saveSession: async (session) => {
        begun.resolve();
        await release.promise;
        stored = session;
        pushes.push(session);
      },
      clearSession,
    });
    const older = google.signIn();
    await begun.promise;
    const out = google.signOut();
    await Promise.resolve();
    const clearedEarly = clearSession.mock.calls.length;
    release.resolve();
    await Promise.all([older, out]);
    expect(clearedEarly).toBe(0);
    expect(stored).toBeNull();
    expect(pushes.at(-1)).toBeNull();
  });

  it("saves the newer account after a pending older save", async () => {
    const begun = deferred();
    const release = deferred();
    const exchanged = deferred();
    let stored;
    let calls = 0;
    const endpoint = tokenEndpoint();
    const fetch = vi.fn(async (...args) => {
      const response = await endpoint.fetch(...args);
      const body = await response.json();
      if (++calls === 2) {
        body.id_token = idToken({ iss: "accounts.google.com", aud: CLIENT.id, sub: "sub-2", email: "new@example.com" });
        exchanged.resolve();
      }
      return new Response(JSON.stringify(body));
    });
    const google = createGoogleAccountController({
      client: CLIENT, openExternal: browser().openExternal, fetch, clearSession: vi.fn(),
      saveSession: async (session) => {
        if (session.sub === "sub-1") { begun.resolve(); await release.promise; }
        stored = session;
      },
    });
    const older = google.signIn();
    await begun.promise;
    const newer = google.signIn();
    await exchanged.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    release.resolve();
    await Promise.all([older, newer]);
    expect(stored.email).toBe("new@example.com");
  });

  it("skips an aborted save queued behind a clear", async () => {
    const begun = deferred();
    const release = deferred();
    const exchanged = deferred();
    const endpoint = tokenEndpoint();
    const saveSession = vi.fn();
    const google = createGoogleAccountController({
      client: CLIENT, openExternal: browser().openExternal,
      fetch: async (...args) => { const response = await endpoint.fetch(...args); exchanged.resolve(); return response; },
      saveSession,
      clearSession: async () => { begun.resolve(); await release.promise; },
    });
    const out = google.signOut();
    await begun.promise;
    const run = google.signIn();
    await exchanged.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    google.cancel();
    release.resolve();
    await out;
    expect(await run).toEqual({ ok: false, error: "cancelled" });
    expect(saveSession).not.toHaveBeenCalled();
  });
});
