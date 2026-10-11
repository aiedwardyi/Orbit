// The Google sign-in Drive sync will use. The desktop shell runs the browser
// sign-in and keeps the refresh token in credentials.bin; this side only holds
// it in memory and trades it for short-lived access tokens. Signing out
// forgets the token and never calls Google's revoke endpoint: one grant is
// shared by every PC on the account, so a revoke would sign them all out.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_MARGIN_MS = 60_000;
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000];

export const GOOGLE_CLIENT_ID_ENV = "WINK_GOOGLE_CLIENT_ID";
export const GOOGLE_CLIENT_SECRET_ENV = "WINK_GOOGLE_CLIENT_SECRET";
export const GOOGLE_ACCOUNT_ENV = "OMB_GOOGLE_ACCOUNT_TOKEN";

export type GoogleAccountState = "unavailable" | "signed-out" | "signed-in" | "needs-sign-in" | "blocked" | "offline";
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
  if (value === null || session) account.setSession(session);
  else console.warn("[google] rejected malformed desktop session");
  return true;
}

export async function googleAccountRoute(method: "PUT" | "DELETE", hasParentPort: boolean, readBody: () => Promise<unknown>, account: GoogleAccount) {
  // Bots share the comms bearer; packaged account changes require the private parent port.
  if (hasParentPort) return { status: 404, body: { error: "not found" } };
  const session = method === "PUT" ? parseGoogleSession(await readBody()) : null;
  if (method === "PUT" && !session) return { status: 400, body: { error: "invalid Google account" } };
  account.setSession(session);
  return { status: 200, body: account.status() };
}

/** Reads the client and boot session, then deletes them so engine CLIs never inherit them. */
export function takeGoogleEnv(env: NodeJS.ProcessEnv): { client: GoogleClient | null; session: GoogleSession | null } {
  const id = env[GOOGLE_CLIENT_ID_ENV]?.trim();
  const secret = env[GOOGLE_CLIENT_SECRET_ENV]?.trim();
  let session: GoogleSession | null = null;
  try {
    session = parseGoogleSession(JSON.parse(env[GOOGLE_ACCOUNT_ENV] ?? "null"));
  } catch {
    session = null;
  }
  delete env[GOOGLE_CLIENT_ID_ENV];
  delete env[GOOGLE_CLIENT_SECRET_ENV];
  delete env[GOOGLE_ACCOUNT_ENV];
  return { client: id && secret ? { id, secret } : null, session };
}

type Options = { fetch?: typeof fetch; now?: () => number; log?: (line: string) => void };

export class GoogleAccount {
  private readonly client: GoogleClient | null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private session: GoogleSession | null;
  private access: { token: string; expiresAt: number } | null = null;
  private problem: "needs-sign-in" | "blocked" | "offline" | null = null;
  private failures = 0;
  private retryAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(client: GoogleClient | null, session: GoogleSession | null, options: Options = {}) {
    this.client = client;
    this.session = session;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  status(): GoogleAccountStatus {
    if (!this.client) return { state: "unavailable" };
    if (!this.session) return { state: "signed-out" };
    return { state: this.problem ?? "signed-in", email: this.session.email };
  }

  setSession(session: GoogleSession | null) {
    this.session = session;
    this.access = null;
    this.problem = null;
    this.failures = 0;
    this.retryAt = 0;
    this.inflight = null;
  }

  getAccessToken(): Promise<string> {
    if (!this.client) return Promise.reject(new GoogleAccountError("unavailable"));
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
