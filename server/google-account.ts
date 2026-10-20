// The Google sign-in Drive sync will use. The desktop shell runs the browser
// sign-in and keeps the refresh token in credentials.bin; this side only holds
// it in memory and trades it for short-lived access tokens. Signing out
// forgets the token and never calls Google's revoke endpoint: one grant is
// shared by every PC on the account, so a revoke would sign them all out.
// The newest ID token stays in memory only, for the phone relay's account.

import { z } from "zod";

import { sniffImageMime } from "./attachments.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PICTURE_MAX_BYTES = 1024 * 1024;
const PICTURE_HOST = /(^|\.)googleusercontent\.com$/;
const EXPIRY_MARGIN_MS = 60_000;
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000];

export const GOOGLE_CLIENT_ID_ENV = "WINK_GOOGLE_CLIENT_ID";
export const GOOGLE_CLIENT_SECRET_ENV = "WINK_GOOGLE_CLIENT_SECRET";
export const GOOGLE_ACCOUNT_ENV = "OMB_GOOGLE_ACCOUNT_TOKEN";
export const GOOGLE_WEB_CLIENT_ID_ENV = "WINK_GOOGLE_WEB_CLIENT_ID";
export const TEAM_RELAY_ENV = "WINK_TEAM_RELAY";
export const TEAM_OWNER_ENV = "WINK_TEAM_OWNER";
const idTokenSchema = z.string().min(1).max(8192);
/** The ID token a fresh desktop sign-in pushes beside the session. */
const pushedIdTokenSchema = z.object({ idToken: idTokenSchema });
const profileClaimsSchema = z.object({
  sub: z.string(),
  name: z.string().optional().catch(undefined),
  picture: z.string().optional().catch(undefined),
});

export type GoogleAccountState = "unavailable" | "pending" | "signed-out" | "signed-in" | "needs-sign-in" | "blocked" | "offline";
export type GoogleAccountStatus = { state: GoogleAccountState; email?: string };
export type GoogleClient = { id: string; secret: string };
export type GoogleSession = { refreshToken: string; sub: string; email: string };

export class GoogleAccountError extends Error {
  readonly state: GoogleAccountState;
  constructor(state: GoogleAccountState) {
    super(`Google account is ${state}`);
    this.state = state;
  }
}

export function parseGoogleSession(value: unknown): GoogleSession | null {
  if (!value || typeof value !== "object") return null;
  const { refreshToken, sub, email } = value as Record<string, unknown>;
  if (typeof refreshToken !== "string" || !refreshToken || typeof sub !== "string" || !sub || typeof email !== "string") return null;
  return { refreshToken, sub, email };
}

export function applyGoogleAccountMessage(message: unknown, account: GoogleAccount): boolean {
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "orbit:google-account") return false;
  const value = "session" in message ? message.session : undefined;
  const session = parseGoogleSession(value);
  const pushed = pushedIdTokenSchema.safeParse(value);
  if (value === null || session) account.setSession(session, pushed.success ? pushed.data.idToken : null);
  else console.warn("[google] rejected malformed desktop session");
  return true;
}

export async function googleAccountRoute(method: "PUT" | "DELETE", hasParentPort: boolean, readBody: () => Promise<unknown>, account: GoogleAccount) {
  // Bots share the comms bearer; packaged account changes require the private parent port.
  if (hasParentPort) return { status: 404, body: { error: "not found" } };
  const body = method === "PUT" ? await readBody() : null;
  const session = parseGoogleSession(body);
  if (method === "PUT" && !session) return { status: 400, body: { error: "invalid Google account" } };
  const pushed = pushedIdTokenSchema.safeParse(body);
  account.setSession(session, pushed.success ? pushed.data.idToken : null);
  return { status: 200, body: account.status() };
}

/** Name and picture from the signed-in account's ID token; a token from before the profile scope has neither. */
export function googleProfileClaims(idToken: string, sub: string): { name?: string; picture?: string } {
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
  const parsed = profileClaimsSchema.safeParse(claims);
  if (!parsed.success || parsed.data.sub !== sub) return {};
  const name = parsed.data.name?.trim();
  return { ...(name ? { name } : {}), ...(parsed.data.picture ? { picture: parsed.data.picture } : {}) };
}

async function fetchPicture(url: string, fetch: typeof globalThis.fetch): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !PICTURE_HOST.test(parsed.hostname)) return null;
    // A redirect could leave the allowed host, so refuse it.
    const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > PICTURE_MAX_BYTES) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      size += read.value.byteLength;
      if (size > PICTURE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(read.value);
    }
    const bytes = Buffer.concat(chunks);
    const mime = sniffImageMime(bytes);
    return mime ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

type ProfileFields = { name?: string; avatarUrl?: string };

/** Profile fields to fill from a sign-in: only an empty name or an unset avatar. Null when there is nothing to fill. */
export async function googleProfileFill(
  idToken: string,
  sub: string,
  current: () => ProfileFields | undefined,
  saveImage: (bytes: Buffer, mime: string) => string | null,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProfileFields | null> {
  const claims = googleProfileClaims(idToken, sub);
  const fill: ProfileFields = {};
  if (claims.picture && !current()?.avatarUrl) {
    const picture = await fetchPicture(claims.picture, fetch);
    try {
      // Re-read after the fetch: the user may have set one meanwhile.
      const avatarUrl = picture && !current()?.avatarUrl ? saveImage(picture.bytes, picture.mime) : null;
      if (avatarUrl) fill.avatarUrl = avatarUrl;
    } catch {
      // A picture that cannot be stored leaves the default.
    }
  }
  if (claims.name && !current()?.name?.trim()) fill.name = claims.name;
  return fill.name || fill.avatarUrl ? fill : null;
}

/** Reads the clients and boot session, then deletes them so engine CLIs never inherit them. */
export function takeGoogleEnv(env: NodeJS.ProcessEnv): { client: GoogleClient | null; webClientId: string | null; teamRelay: string | null; teamOwner: string | null; session: GoogleSession | null } {
  const id = env[GOOGLE_CLIENT_ID_ENV]?.trim();
  const secret = env[GOOGLE_CLIENT_SECRET_ENV]?.trim();
  const webClientId = env[GOOGLE_WEB_CLIENT_ID_ENV]?.trim() || null;
  const teamRelay = env[TEAM_RELAY_ENV]?.trim() || null;
  const teamOwner = env[TEAM_OWNER_ENV]?.trim() || null;
  let session: GoogleSession | null = null;
  try {
    session = parseGoogleSession(JSON.parse(env[GOOGLE_ACCOUNT_ENV] ?? "null"));
  } catch {
    session = null;
  }
  delete env[GOOGLE_CLIENT_ID_ENV];
  delete env[GOOGLE_CLIENT_SECRET_ENV];
  delete env[GOOGLE_ACCOUNT_ENV];
  delete env[GOOGLE_WEB_CLIENT_ID_ENV];
  delete env[TEAM_RELAY_ENV];
  delete env[TEAM_OWNER_ENV];
  return { client: id && secret ? { id, secret } : null, webClientId, teamRelay, teamOwner, session };
}

type Options = { fetch?: typeof fetch; now?: () => number; log?: (line: string) => void; awaitSession?: boolean };

export class GoogleAccount {
  private readonly client: GoogleClient | null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private session: GoogleSession | null;
  private latestIdToken: string | null = null;
  private sessionKnown: boolean;
  private access: { token: string; expiresAt: number } | null = null;
  private problem: "needs-sign-in" | "blocked" | "offline" | null = null;
  private failures = 0;
  private retryAt = 0;
  private inflight: Promise<string> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly idTokenListeners = new Set<() => void>();

  constructor(client: GoogleClient | null, session: GoogleSession | null, options: Options = {}) {
    this.client = client;
    this.session = session;
    this.sessionKnown = options.awaitSession !== true;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  status(): GoogleAccountStatus {
    if (!this.client) return { state: "unavailable" };
    if (!this.sessionKnown) return { state: "pending" };
    if (!this.session) return { state: "signed-out" };
    return { state: this.problem ?? "signed-in", email: this.session.email };
  }

  /** The signed-in account, never its token. */
  owner(): { sub: string; email: string } | null {
    return this.session ? { sub: this.session.sub, email: this.session.email } : null;
  }

  onSession(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The newest ID token from sign-in or a refresh, or null. */
  idToken(): string | null {
    return this.latestIdToken;
  }

  /** Refreshes now for a new ID token. Null when none came or none can before a sign-in; rejects while offline. */
  async freshIdToken(): Promise<string | null> {
    const before = this.latestIdToken;
    if (!this.inflight) this.access = null;
    try {
      await this.getAccessToken();
    } catch (error) {
      if (error instanceof GoogleAccountError && error.state === "offline") throw error;
      return null;
    }
    return this.latestIdToken !== before ? this.latestIdToken : null;
  }

  /** A refresh brought a new ID token. Sign-in and sign-out arrive through onSession. */
  onIdToken(listener: () => void): () => void {
    this.idTokenListeners.add(listener);
    return () => this.idTokenListeners.delete(listener);
  }

  setSession(session: GoogleSession | null, idToken: string | null = null) {
    this.sessionKnown = true;
    this.session = session;
    this.latestIdToken = session ? idToken : null;
    this.access = null;
    this.problem = null;
    this.failures = 0;
    this.retryAt = 0;
    this.inflight = null;
    for (const listener of this.listeners) listener();
  }

  getAccessToken(): Promise<string> {
    if (!this.client) return Promise.reject(new GoogleAccountError("unavailable"));
    if (!this.sessionKnown) return Promise.reject(new GoogleAccountError("pending"));
    if (!this.session) return Promise.reject(new GoogleAccountError("signed-out"));
    if (this.problem === "needs-sign-in" || this.problem === "blocked") return Promise.reject(new GoogleAccountError(this.problem));
    if (this.access && this.now() < this.access.expiresAt - EXPIRY_MARGIN_MS) return Promise.resolve(this.access.token);
    if (this.inflight) return this.inflight;
    if (this.problem === "offline" && this.now() < this.retryAt) return Promise.reject(new GoogleAccountError("offline"));
    const run = this.refresh(this.client, this.session).finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async refresh(client: GoogleClient, session: GoogleSession): Promise<string> {
    let response: Response;
    let body: Record<string, unknown>;
    try {
      response = await this.fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
          client_id: client.id,
          client_secret: client.secret,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      body = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    } catch {
      return this.fail(session, "offline", "network error");
    }
    if (this.session !== session) throw new GoogleAccountError(this.status().state);
    if (response.ok && typeof body.access_token === "string" && body.access_token) {
      const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
      this.access = { token: body.access_token, expiresAt: this.now() + seconds * 1000 };
      const idToken = idTokenSchema.safeParse(body.id_token);
      if (idToken.success) {
        this.latestIdToken = idToken.data;
        for (const listener of this.idTokenListeners) listener();
      }
      if (this.problem) this.log("[google] token refresh recovered");
      this.problem = null;
      this.failures = 0;
      return body.access_token;
    }
    const code = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    if (code === "admin_policy_enforced" || code === "invalid_client" || code === "unauthorized_client" || body.error_subtype === "admin_policy_enforced") return this.fail(session, "blocked", code);
    if (code === "invalid_grant") return this.fail(session, "needs-sign-in", code);
    return this.fail(session, "offline", code);
  }

  private fail(session: GoogleSession, state: "needs-sign-in" | "blocked" | "offline", reason: string): never {
    if (this.session !== session) throw new GoogleAccountError(this.status().state);
    this.access = null;
    if (state === "offline") {
      this.retryAt = this.now() + BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
      this.failures++;
    }
    if (this.problem !== state) this.log(`[google] token refresh failed (${reason}): ${state}`);
    this.problem = state;
    throw new GoogleAccountError(state);
  }
}
