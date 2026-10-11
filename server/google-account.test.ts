import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acpChildEnv } from "./drivers/acp/core.ts";
import { grokSupport } from "./drivers/acp/grok.ts";
import { GOOGLE_ACCOUNT_ENV, GoogleAccount, GoogleAccountError, applyGoogleAccountMessage, googleAccountRoute, takeGoogleEnv, type GoogleSession } from "./google-account.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const SESSION: GoogleSession = { refreshToken: "refresh-token-SECRET", sub: "sub-1", email: "me@example.com" };

function tokenEndpoint(...replies: Array<{ status?: number; body: unknown } | Error>) {
  const calls: URLSearchParams[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body)));
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, mock: fetch };
}

const ok = (token = "access-token-SECRET", expires = 3600) => ({ body: { access_token: token, expires_in: expires } });

function account(endpoint: ReturnType<typeof tokenEndpoint>, clock = { t: 0 }, session: GoogleSession | null = SESSION) {
  return new GoogleAccount(CLIENT, session, { fetch: endpoint.fetch, now: () => clock.t, log: () => {} });
}

async function stateOf(promise: Promise<unknown>) {
  return promise.then(
    () => "resolved",
    (error) => (error instanceof GoogleAccountError ? error.state : String(error)),
  );
}

describe("google account", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is unavailable without a client and makes no call", async () => {
    const endpoint = tokenEndpoint(ok());
    const google = new GoogleAccount(null, SESSION, { fetch: endpoint.fetch, log: () => {} });
    expect(google.status()).toEqual({ state: "unavailable" });
    expect(await stateOf(google.getAccessToken())).toBe("unavailable");
    expect(endpoint.mock).not.toHaveBeenCalled();
  });

  it("reports signed-out, then signed-in with the email", () => {
    const google = account(tokenEndpoint(ok()), { t: 0 }, null);
    expect(google.status()).toEqual({ state: "signed-out" });
    google.setSession(SESSION);
    expect(google.status()).toEqual({ state: "signed-in", email: "me@example.com" });
  });

  it("refreshes with the client secret", async () => {
    const endpoint = tokenEndpoint(ok());
    expect(await account(endpoint).getAccessToken()).toBe("access-token-SECRET");
    expect(Object.fromEntries(endpoint.calls[0]!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-token-SECRET",
      client_id: "client-id-test",
      client_secret: "client-secret-test",
    });
  });

  it("caches the access token until a minute before expiry", async () => {
    const clock = { t: 0 };
    const endpoint = tokenEndpoint(ok("first"), ok("second"));
    const google = account(endpoint, clock);
    expect(await google.getAccessToken()).toBe("first");
    clock.t = 3600_000 - 61_000;
    expect(await google.getAccessToken()).toBe("first");
    clock.t = 3600_000 - 59_000;
    expect(await google.getAccessToken()).toBe("second");
    expect(endpoint.mock).toHaveBeenCalledTimes(2);
  });

  it("makes one refresh for concurrent callers", async () => {
    const endpoint = tokenEndpoint(ok());
    const google = account(endpoint);
    const tokens = await Promise.all([google.getAccessToken(), google.getAccessToken(), google.getAccessToken()]);
    expect(tokens).toEqual(["access-token-SECRET", "access-token-SECRET", "access-token-SECRET"]);
    expect(endpoint.mock).toHaveBeenCalledTimes(1);
  });

  it("goes to needs-sign-in on invalid_grant and stops calling Google", async () => {
    const endpoint = tokenEndpoint({ status: 400, body: { error: "invalid_grant" } });
    const google = account(endpoint);
    expect(await stateOf(google.getAccessToken())).toBe("needs-sign-in");
    expect(await stateOf(google.getAccessToken())).toBe("needs-sign-in");
    expect(google.status()).toEqual({ state: "needs-sign-in", email: "me@example.com" });
    expect(endpoint.mock).toHaveBeenCalledTimes(1);
  });

  it("goes to blocked on admin_policy_enforced and stops calling Google", async () => {
    const endpoint = tokenEndpoint({ status: 400, body: { error: "admin_policy_enforced" } });
    const google = account(endpoint);
    expect(await stateOf(google.getAccessToken())).toBe("blocked");
    expect(await stateOf(google.getAccessToken())).toBe("blocked");
    expect(google.status().state).toBe("blocked");
    expect(endpoint.mock).toHaveBeenCalledTimes(1);
  });

  it("backs off as offline on network errors, then recovers", async () => {
    const clock = { t: 0 };
    const endpoint = tokenEndpoint(new TypeError("fetch failed"), new TypeError("fetch failed"), ok());
    const google = account(endpoint, clock);
    expect(await stateOf(google.getAccessToken())).toBe("offline");
    expect(google.status().state).toBe("offline");
    clock.t = 4_000;
    expect(await stateOf(google.getAccessToken())).toBe("offline");
    expect(endpoint.mock).toHaveBeenCalledTimes(1);
    clock.t = 5_000;
    expect(await stateOf(google.getAccessToken())).toBe("offline");
    clock.t = 5_000 + 14_000;
    expect(await stateOf(google.getAccessToken())).toBe("offline");
    expect(endpoint.mock).toHaveBeenCalledTimes(2);
    clock.t = 5_000 + 15_000;
    expect(await google.getAccessToken()).toBe("access-token-SECRET");
    expect(google.status().state).toBe("signed-in");
  });

  it("a new sign-in clears needs-sign-in", async () => {
    const endpoint = tokenEndpoint({ status: 400, body: { error: "invalid_grant" } }, ok());
    const google = account(endpoint);
    await stateOf(google.getAccessToken());
    google.setSession({ ...SESSION, refreshToken: "fresh" });
    expect(google.status().state).toBe("signed-in");
    expect(await google.getAccessToken()).toBe("access-token-SECRET");
  });

  it("sign out forgets the token without any call", async () => {
    const endpoint = tokenEndpoint(ok());
    const google = account(endpoint);
    await google.getAccessToken();
    endpoint.mock.mockClear();
    google.setSession(null);
    expect(google.status()).toEqual({ state: "signed-out" });
    expect(await stateOf(google.getAccessToken())).toBe("signed-out");
    expect(endpoint.mock).not.toHaveBeenCalled();
  });

  it("takes the client and session out of the env", () => {
    const env: NodeJS.ProcessEnv = {
      WINK_GOOGLE_CLIENT_ID: "id",
      WINK_GOOGLE_CLIENT_SECRET: "secret",
      OMB_GOOGLE_ACCOUNT_TOKEN: JSON.stringify(SESSION),
    };
    expect(takeGoogleEnv(env)).toEqual({ client: { id: "id", secret: "secret" }, session: SESSION });
    expect(env).toEqual({});
    expect(takeGoogleEnv({ WINK_GOOGLE_CLIENT_ID: "id", OMB_GOOGLE_ACCOUNT_TOKEN: "{bad" })).toEqual({ client: null, session: null });
  });

  it("keeps the account variable out of an engine child env", () => {
    const env = acpChildEnv(grokSupport, { cli: "grok", fullAuto: false, prewarm: true }, { PATH: "/bin", [GOOGLE_ACCOUNT_ENV]: JSON.stringify(SESSION) });
    expect(env).not.toHaveProperty(GOOGLE_ACCOUNT_ENV);
    expect(env.PATH).toBe("/bin");
  });

  it("takes the Google env before the registry can spawn a prewarmed child", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source.indexOf("takeGoogleEnv(process.env)")).toBeGreaterThan(-1);
    expect(source.indexOf("takeGoogleEnv(process.env)")).toBeLessThan(source.indexOf("await registry.load("));
  });

  it("never writes tokens to logs, config or the sync folder", async () => {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void lines.push(args.join(" "))),
    );
    const endpoint = tokenEndpoint(ok(), { status: 400, body: { error: "invalid_grant" } }, new TypeError("fetch failed"));
    const clock = { t: 0 };
    const google = new GoogleAccount(CLIENT, SESSION, { fetch: endpoint.fetch, now: () => clock.t });
    await google.getAccessToken();
    clock.t = 10 * 3600_000;
    await stateOf(google.getAccessToken());
    google.setSession(SESSION);
    await stateOf(google.getAccessToken());
    expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
    const files = (root: string): string[] =>
      readdirSync(root).flatMap((name) => (statSync(join(root, name)).isDirectory() ? files(join(root, name)) : [join(root, name)]));
    const written = [...lines, ...files(homedir()).map((file) => readFileSync(file, "utf8")), JSON.stringify(google.status())].join("\n");
    for (const secret of ["refresh-token-SECRET", "access-token-SECRET", "client-secret-test"]) expect(written).not.toContain(secret);
  });
});

describe("desktop Google account updates", () => {
  it("applies valid parent messages, clears null and ignores malformed sessions", () => {
    const google = account(tokenEndpoint(ok()), { t: 0 }, null);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(applyGoogleAccountMessage({ type: "orbit:google-account", session: SESSION }, google)).toBe(true);
      expect(google.status()).toEqual({ state: "signed-in", email: SESSION.email });
      for (const session of [undefined, {}, { ...SESSION, refreshToken: 123 }]) {
        expect(applyGoogleAccountMessage({ type: "orbit:google-account", session }, google)).toBe(true);
        expect(google.status().state).toBe("signed-in");
      }
      expect(log).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(log.mock.calls)).not.toContain(SESSION.refreshToken);
      expect(applyGoogleAccountMessage({ type: "orbit:google-account", session: null }, google)).toBe(true);
      expect(google.status().state).toBe("signed-out");
      for (const message of [null, {}, { type: "orbit:other" }]) {
        expect(applyGoogleAccountMessage(message, google)).toBe(false);
      }
    } finally {
      log.mockRestore();
    }
  });

  it.each(["PUT", "DELETE"] as const)("refuses authenticated %s with a parent port and permits dev updates", async (method) => {
    const google = account(tokenEndpoint(ok()));
    const readBody = vi.fn(async () => SESSION);
    expect((await googleAccountRoute(method, true, readBody, google)).status).toBe(404);
    expect(readBody).not.toHaveBeenCalled();
    expect(google.status().state).toBe("signed-in");
    expect((await googleAccountRoute(method, false, readBody, google)).status).toBe(200);
    expect(google.status().state).toBe(method === "PUT" ? "signed-in" : "signed-out");
  });

  it.each(["invalid_client", "unauthorized_client"])("blocks %s without retrying", async (error) => {
    const clock = { t: 0 };
    const endpoint = tokenEndpoint({ status: 400, body: { error } });
    const google = account(endpoint, clock);
    expect(await stateOf(google.getAccessToken())).toBe("blocked");
    clock.t = 24 * 3600_000;
    expect(await stateOf(google.getAccessToken())).toBe("blocked");
    expect(endpoint.mock).toHaveBeenCalledTimes(1);
  });
});
