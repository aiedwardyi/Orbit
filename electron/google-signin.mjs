// Google sign-in for Drive sync: system browser, a one-shot loopback listener
// on 127.0.0.1 and PKCE. The refresh token goes straight to credentials.bin
// through saveSession; the renderer only ever sees a status code and email.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive.file"];
const DRIVE_FILE = GOOGLE_SCOPES[2];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const ERROR_CODES = new Map([["access_denied", "access-denied"], ["admin_policy_enforced", "blocked"]]);
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export class GoogleSignInError extends Error {
  constructor(code) {
    super(`Google sign-in failed: ${code}`);
    this.code = code;
  }
}

/** Env first (local dev), then the file release.yml bakes into the package. */
export function googleClient(env, readBaked) {
  const id = env.WINK_GOOGLE_CLIENT_ID?.trim();
  const secret = env.WINK_GOOGLE_CLIENT_SECRET?.trim();
  if (id && secret) return { id, secret };
  try {
    const baked = readBaked();
    if (typeof baked?.id === "string" && baked.id && typeof baked?.secret === "string" && baked.secret) {
      return { id: baked.id, secret: baked.secret };
    }
  } catch {
    // No baked client: a self-built copy keeps sign-in hidden.
  }
  return null;
}

/** Env for the packaged server child; it removes these from its own env at boot. */
export function googleServerEnv(client, credentials) {
  if (!client) return {};
  const env = { WINK_GOOGLE_CLIENT_ID: client.id, WINK_GOOGLE_CLIENT_SECRET: client.secret };
  if (credentials?.googleAccount) env.OMB_GOOGLE_ACCOUNT_TOKEN = JSON.stringify(credentials.googleAccount);
  return env;
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function googleAuthUrl({ clientId, redirectUri, challenge, state }) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent select_account",
  }).toString();
  return url.toString();
}

function page(res, status, text) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><title>Wink</title><p style="font:16px sans-serif">${text}</p>`);
}

/** One sign-in. `onListening` sees the bound address (tests); `signal` cancels. */
export async function runGoogleSignIn({ client, openExternal, fetch = globalThis.fetch, signal, timeoutMs = SIGN_IN_TIMEOUT_MS, onListening }) {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("base64url");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}`;
  onListening?.(address);
  let code;
  try {
    code = await new Promise((settle, fail) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      const resolve = (value) => (done(), settle(value));
      const reject = (error) => (done(), fail(error));
      const cancel = () => reject(new GoogleSignInError("cancelled"));
      const timer = setTimeout(() => reject(new GoogleSignInError("timeout")), timeoutMs);
      if (signal?.aborted) cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      server.on("request", (req, res) => {
        let query;
        try {
          query = new URL(req.url ?? "/", redirectUri).searchParams;
        } catch {
          return page(res, 400, "Bad request.");
        }
        if (!query.has("code") && !query.has("error")) return page(res, 404, "Not found.");
        if (query.get("state") !== state) {
          page(res, 400, "Sign-in failed. Go back to Wink and try again.");
          return reject(new GoogleSignInError("state-mismatch"));
        }
        if (query.has("error")) {
          page(res, 200, "Sign-in was not completed. You can close this tab.");
          return reject(new GoogleSignInError(ERROR_CODES.get(query.get("error")) ?? "google-error"));
        }
        page(res, 200, "You can close this tab.");
        resolve(query.get("code"));
      });
      Promise.resolve(openExternal(googleAuthUrl({ clientId: client.id, redirectUri, challenge, state }))).catch(() =>
        reject(new GoogleSignInError("browser-failed")),
      );
    });
  } finally {
    server.close();
  }
  return exchangeCode({ client, code, verifier, redirectUri, fetch, signal });
}

async function exchangeCode({ client, code, verifier, redirectUri, fetch, signal }) {
  let body;
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        client_id: client.id,
        client_secret: client.secret,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    body = await response.json().catch(() => ({}));
    if (!response.ok) throw new GoogleSignInError(body?.error === "admin_policy_enforced" ? "blocked" : "exchange-failed");
  } catch (error) {
    if (signal?.aborted) throw new GoogleSignInError("cancelled");
    throw error instanceof GoogleSignInError ? error : new GoogleSignInError("offline");
  }
  if (signal?.aborted) throw new GoogleSignInError("cancelled");
  if (!String(body.scope ?? "").split(" ").includes(DRIVE_FILE)) throw new GoogleSignInError("drive-permission-missing");
  if (typeof body.refresh_token !== "string" || !body.refresh_token) throw new GoogleSignInError("exchange-failed");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(String(body.id_token).split(".")[1], "base64url").toString("utf8"));
  } catch {
    throw new GoogleSignInError("exchange-failed");
  }
  if (!ISSUERS.includes(claims?.iss) || claims.aud !== client.id || typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string") {
    throw new GoogleSignInError("exchange-failed");
  }
  return { refreshToken: body.refresh_token, sub: claims.sub, email: claims.email };
}

/** The main-process side of the preload actions. Secrets stay in here and in saveSession. */
export function createGoogleAccountController({ client, openExternal, saveSession, clearSession, fetch, log = () => {} }) {
  let active = null;
  return {
    async signIn() {
      if (!client) return { ok: false, error: "unavailable" };
      active?.abort();
      const controller = new AbortController();
      active = controller;
      try {
        const session = await runGoogleSignIn({ client, openExternal, fetch, signal: controller.signal });
        if (controller.signal.aborted) return { ok: false, error: "cancelled" };
        await saveSession(session);
        return { ok: true, email: session.email };
      } catch (error) {
        const code = error instanceof GoogleSignInError ? error.code : "store-failed";
        log(`google sign-in failed: ${code}`);
        return { ok: false, error: code };
      } finally {
        if (active === controller) active = null;
      }
    },
    cancel() {
      active?.abort();
    },
    async signOut() {
      active?.abort();
      await clearSession();
      return { ok: true };
    },
  };
}
