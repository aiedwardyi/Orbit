import { createHash } from "node:crypto";
import { request } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createGoogleAccountController, googleClient, googleServerEnv, pkcePair, runGoogleSignIn } from "./google-signin.mjs";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

function idToken(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function tokenEndpoint({ status = 200, scope = `openid email ${DRIVE_FILE}`, error } = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(String(init.body))) });
    const body = error
      ? { error }
      : { access_token: "access-SECRET", refresh_token: "refresh-SECRET", scope, id_token: idToken({ aud: CLIENT.id, sub: "sub-1", email: "me@example.com" }) };
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

    expect(session).toEqual({ refreshToken: "refresh-SECRET", sub: "sub-1", email: "me@example.com" });
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

  it("closes on cancel", async () => {
    const controller = new AbortController();
    let address;
    const run = runGoogleSignIn({ client: CLIENT, openExternal: async () => controller.abort(), fetch: vi.fn(), signal: controller.signal, onListening: (value) => (address = value) });
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
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

  it("saves the session and returns only the email", async () => {
    const endpoint = tokenEndpoint();
    const saveSession = vi.fn();
    const google = createGoogleAccountController({ client: CLIENT, openExternal: browser().openExternal, fetch: endpoint.fetch, saveSession, clearSession: vi.fn() });
    expect(await google.signIn()).toEqual({ ok: true, email: "me@example.com" });
    expect(saveSession).toHaveBeenCalledExactlyOnceWith({ refreshToken: "refresh-SECRET", sub: "sub-1", email: "me@example.com" });
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

  it("hands the server the client and stored session, or nothing without a client", () => {
    const googleAccount = { refreshToken: "r", sub: "s", email: "e@x.com" };
    expect(googleServerEnv(CLIENT, { googleAccount })).toEqual({
      WINK_GOOGLE_CLIENT_ID: CLIENT.id,
      WINK_GOOGLE_CLIENT_SECRET: CLIENT.secret,
      OMB_GOOGLE_ACCOUNT: JSON.stringify(googleAccount),
    });
    expect(googleServerEnv(CLIENT, {})).toEqual({ WINK_GOOGLE_CLIENT_ID: CLIENT.id, WINK_GOOGLE_CLIENT_SECRET: CLIENT.secret });
    expect(googleServerEnv(null, { googleAccount })).toEqual({});
  });
});
