import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig, parseConfigPatch, saveConfig } from "./config.ts";
import { acpChildEnv } from "./drivers/acp/core.ts";
import { grokSupport } from "./drivers/acp/grok.ts";
import { GOOGLE_ACCOUNT_ENV, GoogleAccount, GoogleAccountError, applyGoogleAccountMessage, googleAccountRoute, googlePhotoOffered, googleProfileFill, googleProfilePhoto, takeGoogleEnv, type GoogleSession } from "./google-account.ts";

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
      WINK_GOOGLE_WEB_CLIENT_ID: " web-id ",
      OMB_GOOGLE_ACCOUNT_TOKEN: JSON.stringify(SESSION),
    };
    expect(takeGoogleEnv(env)).toEqual({ client: { id: "id", secret: "secret" }, webClientId: "web-id", teamRelay: null, teamOwner: null, session: SESSION });
    expect(env).toEqual({});
    expect(takeGoogleEnv({ WINK_GOOGLE_CLIENT_ID: "id", OMB_GOOGLE_ACCOUNT_TOKEN: "{bad", WINK_TEAM_RELAY: " wink.example ", WINK_TEAM_OWNER: " abc " })).toEqual({
      client: null,
      webClientId: null,
      teamRelay: "wink.example",
      teamOwner: "abc",
      session: null,
    });
    expect(takeGoogleEnv({})).toEqual({ client: null, webClientId: null, teamRelay: null, teamOwner: null, session: null });
  });

  it("holds the newest ID token from sign-in or refresh, and drops it on sign-out", async () => {
    const clock = { t: 0 };
    const endpoint = tokenEndpoint(ok("first"), { body: { access_token: "second", expires_in: 3600, id_token: "id-token-refreshed" } });
    const google = account(endpoint, clock, null);
    const refreshed = vi.fn();
    google.onIdToken(refreshed);
    google.setSession(SESSION, "id-token-signin");
    expect(google.idToken()).toBe("id-token-signin");
    await google.getAccessToken();
    expect(google.idToken()).toBe("id-token-signin");
    expect(refreshed).not.toHaveBeenCalled();
    clock.t = 3600_000;
    await google.getAccessToken();
    expect(google.idToken()).toBe("id-token-refreshed");
    expect(refreshed).toHaveBeenCalledOnce();
    google.setSession(SESSION);
    expect(google.idToken()).toBeNull();
    google.setSession(null, "id-token-orphan");
    expect(google.idToken()).toBeNull();
    expect(JSON.stringify(google.status())).not.toContain("id-token");
  });

  it("refreshes for a fresh ID token on demand, even with a cached access token", async () => {
    const withId = (access: string, id?: string) => ({ body: { access_token: access, expires_in: 3600, id_token: id } });
    const endpoint = tokenEndpoint(withId("first", "id-token-1"), withId("second", "id-token-2"), withId("third"));
    const google = account(endpoint);
    await google.getAccessToken();
    expect(await google.freshIdToken()).toBe("id-token-2");
    expect(await google.getAccessToken()).toBe("second");
    expect(await google.freshIdToken()).toBeNull();
    expect(google.idToken()).toBe("id-token-2");
    expect(endpoint.mock).toHaveBeenCalledTimes(3);
    expect(endpoint.calls[1]!.get("refresh_token")).toBe("refresh-token-SECRET");
  });

  it("gives no fresh ID token on invalid_grant, keeps needs-sign-in and stops calling Google", async () => {
    const endpoint = tokenEndpoint({ status: 400, body: { error: "invalid_grant" } });
    const google = account(endpoint);
    expect(await google.freshIdToken()).toBeNull();
    expect(await google.freshIdToken()).toBeNull();
    expect(google.status().state).toBe("needs-sign-in");
    expect(endpoint.mock).toHaveBeenCalledTimes(1);
  });

  it("rejects a fresh ID token request while offline", async () => {
    const google = account(tokenEndpoint(new TypeError("fetch failed")));
    expect(await stateOf(google.freshIdToken())).toBe("offline");
    expect(await stateOf(google.freshIdToken())).toBe("offline");
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

  it("does not report signed out before the boot push", async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source.includes("new GoogleAccount(googleEnv.client, null, { awaitSession: Boolean(utilityParentPort) })")).toBe(true);
    const google = new GoogleAccount(CLIENT, null, { awaitSession: true, log: () => {} });
    expect(google.status()).toEqual({ state: "pending" });
    expect(await stateOf(google.getAccessToken())).toBe("pending");
    expect(applyGoogleAccountMessage({ type: "orbit:google-account", session: { refreshToken: 1 } }, google)).toBe(true);
    expect(google.status()).toEqual({ state: "pending" });
    expect(applyGoogleAccountMessage({ type: "orbit:google-account", session: SESSION }, google)).toBe(true);
    expect(google.status()).toEqual({ state: "signed-in", email: SESSION.email });
    const empty = new GoogleAccount(CLIENT, null, { awaitSession: true, log: () => {} });
    expect(applyGoogleAccountMessage({ type: "orbit:google-account", session: null }, empty)).toBe(true);
    expect(empty.status()).toEqual({ state: "signed-out" });
    expect(JSON.stringify([google.status(), empty.status()])).not.toContain(SESSION.refreshToken);
  });

  it("starts a standalone server signed out instead of pending forever", async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source.includes("new GoogleAccount(googleEnv.client, null, { awaitSession: true })")).toBe(false);
    const standalone = new GoogleAccount(CLIENT, null, { awaitSession: Boolean(undefined), log: () => {} });
    expect(standalone.status()).toEqual({ state: "signed-out" });
    expect(await stateOf(standalone.getAccessToken())).toBe("signed-out");
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

  it("takes a pushed ID token beside the session, from the parent port or the dev route", async () => {
    const google = account(tokenEndpoint(ok()), { t: 0 }, null);
    applyGoogleAccountMessage({ type: "orbit:google-account", session: { ...SESSION, idToken: "id-token-port" } }, google);
    expect(google.idToken()).toBe("id-token-port");
    expect(google.owner()).toEqual({ sub: SESSION.sub, email: SESSION.email });
    applyGoogleAccountMessage({ type: "orbit:google-account", session: { ...SESSION, idToken: 7 } }, google);
    expect(google.idToken()).toBeNull();
    await googleAccountRoute("PUT", false, async () => ({ ...SESSION, idToken: "id-token-dev" }), google);
    expect(google.idToken()).toBe("id-token-dev");
    await googleAccountRoute("DELETE", false, async () => ({}), google);
    expect(google.idToken()).toBeNull();
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

describe("profile fill from Google sign-in", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const PICTURE = "https://lh3.googleusercontent.com/a/photo=s96-c";
  const idToken = (claims: Record<string, unknown>) =>
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ sub: SESSION.sub, email: SESSION.email, ...claims })).toString("base64url")}.sig`;
  const picture = (reply: Response | Error = new Response(PNG, { headers: { "content-type": "image/png" } })) =>
    vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    }) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
  const saved = () => vi.fn((_bytes: Buffer, mime: string) => `/api/attachments/saved.${mime === "image/png" ? "png" : "jpg"}`);

  it("fills an empty name and an unset avatar with the cached picture", async () => {
    const fetch = picture();
    const save = saved();
    const fill = await googleProfileFill(idToken({ name: " Ada Lovelace ", picture: PICTURE }), SESSION.sub, () => ({ name: "  " }), save, fetch);
    expect(fill).toEqual({ name: "Ada Lovelace", avatarUrl: "/api/attachments/saved.png" });
    expect(String(fetch.mock.calls[0]![0])).toBe(PICTURE);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    expect(save).toHaveBeenCalledWith(PNG, "image/png");
  });

  it("never overwrites a name or avatar the user set", async () => {
    const fetch = picture();
    const save = saved();
    const current = { name: "Countess", avatarUrl: "/api/attachments/mine.png" };
    expect(await googleProfileFill(idToken({ name: "Ada", picture: PICTURE }), SESSION.sub, () => current, save, fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(await googleProfileFill(idToken({ name: "Ada", picture: PICTURE }), SESSION.sub, () => ({ name: "Countess" }), save, fetch)).toEqual({ avatarUrl: "/api/attachments/saved.png" });
  });

  it("keeps an avatar the user set while the picture was downloading", async () => {
    let current: { avatarUrl?: string } = {};
    const fetch = vi.fn(async () => {
      current = { avatarUrl: "/api/attachments/mine.png" };
      return new Response(PNG);
    }) as unknown as typeof globalThis.fetch;
    const save = saved();
    expect(await googleProfileFill(idToken({ picture: PICTURE }), SESSION.sub, () => current, save, fetch)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("does not fill back a photo or name the user removed", async () => {
    const fetch = picture();
    const save = saved();
    expect(await googleProfileFill(idToken({ name: "Ada", picture: PICTURE }), SESSION.sub, () => ({ name: "", avatarCleared: true, nameCleared: true }), save, fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(await googleProfileFill(idToken({ name: "Ada", picture: PICTURE }), SESSION.sub, () => ({ avatarCleared: true }), save, fetch)).toEqual({ name: "Ada" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the photo removed when the user removes it while the picture was downloading", async () => {
    let current: { avatarCleared?: boolean } = {};
    const fetch = vi.fn(async () => {
      current = { avatarCleared: true };
      return new Response(PNG);
    }) as unknown as typeof globalThis.fetch;
    const save = saved();
    expect(await googleProfileFill(idToken({ picture: PICTURE }), SESSION.sub, () => current, save, fetch)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("fills nothing from an old-scope token without name or picture", async () => {
    const fetch = picture();
    const save = saved();
    expect(await googleProfileFill(idToken({}), SESSION.sub, () => undefined, save, fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores a token for another account or a malformed token", async () => {
    const fetch = picture();
    expect(await googleProfileFill(idToken({ sub: "sub-2", name: "Eve", picture: PICTURE }), SESSION.sub, () => undefined, saved(), fetch)).toBeNull();
    expect(await googleProfileFill("not-a-token", SESSION.sub, () => undefined, saved(), fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a network error", picture(new Error("offline")), PICTURE],
    ["an HTTP error", picture(new Response("nope", { status: 404 })), PICTURE],
    ["a non-image body", picture(new Response("<html>")), PICTURE],
    ["an oversized picture", picture(new Response(Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]))), PICTURE],
    ["an oversized picture with no length", picture(new Response(new Blob([PNG, new Uint8Array(1024 * 1024)]).stream())), PICTURE],
    ["a non-Google host", picture(), "https://evil.example/photo.png"],
    ["plain http", picture(), "http://lh3.googleusercontent.com/a/photo"],
  ])("leaves the default avatar after %s and still fills the name", async (_case, fetch, url) => {
    const save = saved();
    expect(await googleProfileFill(idToken({ name: "Ada", picture: url }), SESSION.sub, () => undefined, save, fetch)).toEqual({ name: "Ada" });
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves the default avatar when the picture cannot be stored", async () => {
    const save = vi.fn(() => {
      throw new Error("disk full");
    });
    expect(await googleProfileFill(idToken({ name: "Ada", picture: PICTURE }), SESSION.sub, () => undefined, save, picture())).toEqual({ name: "Ada" });
  });

  it("puts the Google picture back over a removed photo", async () => {
    const fetch = picture();
    const save = saved();
    saveConfig(parseConfigPatch({ profile: { name: "Ada", avatarUrl: "" } }));
    expect(loadConfig().profile?.avatarCleared).toBe(true);
    const profile = await googleProfilePhoto(idToken({ picture: PICTURE }), SESSION.sub, save, fetch);
    expect(String(fetch.mock.calls[0]![0])).toBe(PICTURE);
    expect(save).toHaveBeenCalledWith(PNG, "image/png");
    saveConfig({ profile: profile! });
    expect(loadConfig().profile).toEqual({ name: "Ada", avatarUrl: "/api/attachments/saved.png", googleAvatarUrl: "/api/attachments/saved.png" });
  });

  it.each([
    ["signed out", null, undefined],
    ["a token without a picture", idToken({ name: "Ada" }), SESSION.sub],
    ["a token for another account", idToken({ sub: "sub-2", picture: PICTURE }), SESSION.sub],
  ])("refuses the Google photo when %s", async (_case, token, sub) => {
    const fetch = picture();
    const save = saved();
    expect(await googleProfilePhoto(token, sub, save, fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses the Google photo when the picture cannot be fetched", async () => {
    const save = saved();
    expect(await googleProfilePhoto(idToken({ picture: PICTURE }), SESSION.sub, save, picture(new Response("nope", { status: 404 })))).toBeNull();
    expect(await googleProfilePhoto(idToken({ picture: "https://evil.example/photo.png" }), SESSION.sub, save, picture())).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("offers the Google photo only when signed in with a picture that is not already the photo", () => {
    const token = idToken({ picture: PICTURE });
    expect(googlePhotoOffered(token, SESSION.sub, undefined)).toBe(true);
    expect(googlePhotoOffered(token, SESSION.sub, { avatarUrl: "/api/attachments/mine.png", googleAvatarUrl: "/api/attachments/g.png" })).toBe(true);
    expect(googlePhotoOffered(token, SESSION.sub, { googleAvatarUrl: "/api/attachments/g.png" })).toBe(true);
    expect(googlePhotoOffered(token, SESSION.sub, { avatarUrl: "/api/attachments/g.png", googleAvatarUrl: "/api/attachments/g.png" })).toBe(false);
    expect(googlePhotoOffered(null, undefined, undefined)).toBe(false);
    expect(googlePhotoOffered(idToken({ name: "Ada" }), SESSION.sub, undefined)).toBe(false);
  });
});
