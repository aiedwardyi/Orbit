// Remote-mode gates without booting the harness: key file, handshake
// compare, cookie minting, and the Host/Origin/API checks index.ts wires in.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  apiRequestAuthorized,
  autoRemoteHost,
  buildRemoteSetCookie,
  hostMatchesRemote,
  initRemoteAccess,
  loadOrCreateRemoteKey,
  originAllowedByRemote,
  remoteCookieAuthorized,
  remoteKeyMatches,
  remoteLinkUrl,
  remoteHostRetry,
  resolveRemoteHost,
  type RemoteSetup,
} from "./remote-access.ts";

const HOST = "home.tail1234.ts.net";
const freshDir = () => mkdtempSync(join(tmpdir(), "orbit-remote-"));

describe("remote access", () => {
  it("stays off without ORBIT_REMOTE_HOST", () => {
    expect(resolveRemoteHost({})).toBeUndefined();
    expect(resolveRemoteHost({ ORBIT_REMOTE_HOST: "   " })).toBeUndefined();
    expect(resolveRemoteHost({ ORBIT_REMOTE_HOST: `https://${HOST}/` })).toBeUndefined();
    expect(hostMatchesRemote(HOST, undefined)).toBe(false);
    expect(originAllowedByRemote(`https://${HOST}`, undefined)).toBe(false);
    expect(remoteCookieAuthorized("orbit_remote=abc", undefined)).toBe(false);
    expect(apiRequestAuthorized(false, "orbit_remote=abc", undefined)).toBe(false);
  });

  it("rejects a wrong or missing handshake key", () => {
    const key = loadOrCreateRemoteKey(freshDir());
    expect(remoteKeyMatches("0".repeat(64), key)).toBe(false);
    expect(remoteKeyMatches(undefined, key)).toBe(false);
    expect(remoteKeyMatches(null, key)).toBe(false);
    expect(remoteKeyMatches("", key)).toBe(false);
    expect(remoteCookieAuthorized("orbit_remote=wrong", key)).toBe(false);
    expect(remoteCookieAuthorized(undefined, key)).toBe(false);
  });

  it("mints a cookie on the correct key that authorizes /api/*", () => {
    const key = loadOrCreateRemoteKey(freshDir());
    expect(remoteKeyMatches(key, key)).toBe(true);
    const setCookie = buildRemoteSetCookie(key);
    expect(setCookie).toContain(`orbit_remote=${key}`);
    for (const attr of ["Path=/", "Max-Age=2592000", "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(setCookie).toContain(attr);
    }
    expect(remoteCookieAuthorized(`theme=dark; orbit_remote=${key}`, key)).toBe(true);
    expect(apiRequestAuthorized(false, `orbit_remote=${key}`, key)).toBe(true);
  });

  it("keeps the local boot-token path working", () => {
    const key = loadOrCreateRemoteKey(freshDir());
    expect(apiRequestAuthorized(true, undefined, key)).toBe(true);
    expect(apiRequestAuthorized(true, undefined, undefined)).toBe(true);
    expect(apiRequestAuthorized(false, undefined, key)).toBe(false);
  });

  it("refuses the cookie alone on the terminal bridge route", () => {
    const key = loadOrCreateRemoteKey(freshDir());
    expect(apiRequestAuthorized(false, `orbit_remote=${key}`, key, "/api/internal/terminal-bridge")).toBe(false);
    expect(apiRequestAuthorized(true, `orbit_remote=${key}`, key, "/api/internal/terminal-bridge")).toBe(true);
    expect(apiRequestAuthorized(false, `orbit_remote=${key}`, key, "/api/internal/agents")).toBe(true);
  });

  it("lets the remote cookie drive the desktop updater", () => {
    const key = loadOrCreateRemoteKey(freshDir());
    for (const path of ["/api/update/state", "/api/update/check", "/api/update/download", "/api/update/install"]) {
      expect(apiRequestAuthorized(false, `orbit_remote=${key}`, key, path)).toBe(true);
      expect(apiRequestAuthorized(false, "orbit_remote=wrong", key, path)).toBe(false);
      expect(apiRequestAuthorized(false, undefined, key, path)).toBe(false);
    }
  });

  it("lets the remote cookie read a bot terminal snapshot", () => {
    const key = loadOrCreateRemoteKey(freshDir());
    expect(apiRequestAuthorized(false, `orbit_remote=${key}`, key, "/api/bots/bot-1/terminal")).toBe(true);
    expect(apiRequestAuthorized(true, undefined, key, "/api/bots/bot-1/terminal")).toBe(true);
    expect(apiRequestAuthorized(false, undefined, key, "/api/bots/bot-1/terminal")).toBe(false);
  });

  it("rejects unrelated hostnames when remote mode is on", () => {
    expect(resolveRemoteHost({ ORBIT_REMOTE_HOST: HOST })).toBe(HOST);
    expect(hostMatchesRemote(HOST, HOST)).toBe(true);
    expect(hostMatchesRemote(`${HOST}:443`, HOST)).toBe(true);
    expect(hostMatchesRemote(HOST.toUpperCase(), HOST)).toBe(true);
    expect(hostMatchesRemote("evil.example.com", HOST)).toBe(false);
    expect(hostMatchesRemote(`${HOST}.evil.com`, HOST)).toBe(false);
    expect(hostMatchesRemote(`evil-${HOST}`, HOST)).toBe(false);
    expect(hostMatchesRemote(undefined, HOST)).toBe(false);
    expect(originAllowedByRemote(`https://${HOST}`, HOST)).toBe(true);
    expect(originAllowedByRemote(`HTTPS://${HOST.toUpperCase()}`, HOST)).toBe(true);
    expect(originAllowedByRemote("https://evil.example.com", HOST)).toBe(false);
  });

  it("accepts only a bare https origin", () => {
    expect(originAllowedByRemote(`http://${HOST}`, HOST)).toBe(false);
    expect(originAllowedByRemote(`https://${HOST}:443`, HOST)).toBe(false);
    expect(originAllowedByRemote(`https://${HOST}:8443`, HOST)).toBe(false);
    expect(originAllowedByRemote(`https://${HOST}/`, HOST)).toBe(false);
    expect(originAllowedByRemote(`https://user@${HOST}`, HOST)).toBe(false);
  });

  it("persists one stable key per data dir", () => {
    const dir = freshDir();
    const first = loadOrCreateRemoteKey(dir);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(loadOrCreateRemoteKey(dir)).toBe(first);
    expect(readFileSync(join(dir, "remote-key.json"), "utf8")).toContain(first);
    expect(loadOrCreateRemoteKey(freshDir())).not.toBe(first);
  });

  it("never passes the key to the boot logger", () => {
    const dir = freshDir();
    const lines: string[] = [];
    const { host, key } = initRemoteAccess({ ORBIT_REMOTE_HOST: HOST }, dir, (l) => lines.push(l));
    expect(host).toBe(HOST);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(lines).toEqual([
      `Remote mode on: https://${HOST}/remote?key=<redacted> (key in ${join(dir, "remote-key.json")})`,
    ]);
    expect(lines.some((l) => l.includes(key!))).toBe(false);
  });

  it("logs nothing and mints no key when off", () => {
    const lines: string[] = [];
    expect(initRemoteAccess({}, freshDir(), (l) => lines.push(l))).toEqual({ host: undefined, key: undefined });
    expect(lines).toEqual([]);
  });

  it("builds the phone link only when both host and key are set", () => {
    expect(remoteLinkUrl(HOST, "a".repeat(64))).toBe(`https://${HOST}/remote?key=${"a".repeat(64)}`);
    expect(remoteLinkUrl(undefined, "a".repeat(64))).toBeUndefined();
    expect(remoteLinkUrl(HOST, undefined)).toBeUndefined();
    expect(remoteLinkUrl(undefined, undefined)).toBeUndefined();
  });

  it("regenerates the key when ORBIT_REMOTE_ROTATE_KEY is truthy", () => {
    const dir = freshDir();
    const quiet = () => {};
    const first = initRemoteAccess({ ORBIT_REMOTE_HOST: HOST }, dir, quiet).key;
    expect(initRemoteAccess({ ORBIT_REMOTE_HOST: HOST, ORBIT_REMOTE_ROTATE_KEY: "0" }, dir, quiet).key).toBe(first);
    const rotated = initRemoteAccess({ ORBIT_REMOTE_HOST: HOST, ORBIT_REMOTE_ROTATE_KEY: "1" }, dir, quiet).key;
    expect(rotated).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated).not.toBe(first);
    expect(remoteCookieAuthorized(`orbit_remote=${first}`, rotated)).toBe(false);
    expect(loadOrCreateRemoteKey(dir)).toBe(rotated);
  });

  describe("tailscale auto-detect", () => {
    const PORT = 8799;
    const SERVE = `serve --bg --https=443 http://127.0.0.1:${PORT}`;
    const running = JSON.stringify({ BackendState: "Running", Self: { DNSName: `${HOST.toUpperCase()}.` } });
    const servedTo = (proxy: string) =>
      JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } } });
    const detect = (env: NodeJS.ProcessEnv, outputs: Record<string, string | Error>, platform: NodeJS.Platform = "linux") => {
      const lines: string[] = [];
      const calls: string[] = [];
      const exec = async (file: string, args: string[]) => {
        calls.push([file, ...args].join(" "));
        const out = outputs[args.join(" ")] ?? new Error("ENOENT");
        if (out instanceof Error) throw out;
        return out;
      };
      return { lines, calls, host: autoRemoteHost(env, PORT, exec, (l) => lines.push(l), platform) };
    };

    it("serves 443 to this port when Tailscale is running and 443 is free", async () => {
      const run = detect({}, { "status --json": running, "serve status --json": "{}", [SERVE]: "" });
      expect(await run.host).toBe(HOST);
      expect(run.calls).toEqual(["tailscale status --json", "tailscale serve status --json", `tailscale ${SERVE}`]);
      expect(run.lines).toEqual([]);
    });

    it("leaves an existing serve rule to this port alone", async () => {
      const run = detect({}, { "status --json": running, "serve status --json": servedTo(`http://127.0.0.1:${PORT}`) });
      expect(await run.host).toBe(HOST);
      expect(run.calls).not.toContain(`tailscale ${SERVE}`);
    });

    it("never overwrites 443 serving something else", async () => {
      for (const serve of [servedTo("http://127.0.0.1:3000"), JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } })]) {
        const run = detect({}, { "status --json": running, "serve status --json": serve, [SERVE]: "" });
        expect(await run.host).toBeUndefined();
        expect(run.calls).not.toContain(`tailscale ${SERVE}`);
        expect(run.lines).toEqual([`Remote auto: ${HOST}:443 already serves something else, remote off`]);
      }
    });

    it("logs the reason when serve fails", async () => {
      const run = detect({}, { "status --json": running, "serve status --json": "{}", [SERVE]: new Error("HTTPS is not enabled") });
      expect(await run.host).toBeUndefined();
      expect(run.lines).toEqual(["Remote auto: tailscale serve failed, remote off: HTTPS is not enabled"]);
    });

    it("stays off when logged out", async () => {
      const run = detect({}, { "status --json": JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" } }) });
      expect(await run.host).toBeUndefined();
      expect(run.calls).toEqual(["tailscale status --json"]);
      expect(run.lines).toEqual(["Remote auto: Tailscale not logged in (NeedsLogin), remote off"]);
    });

    it("stays off when Tailscale is not installed", async () => {
      const run = detect({}, {}, "win32");
      expect(await run.host).toBeUndefined();
      expect(run.calls).toEqual(["tailscale status --json", "C:\\Program Files\\Tailscale\\tailscale.exe status --json"]);
      expect(run.lines).toEqual(["Remote auto: Tailscale not found, remote off"]);
    });

    it("skips detection when ORBIT_REMOTE_HOST is set or ORBIT_REMOTE_AUTO=0", async () => {
      for (const env of [{ ORBIT_REMOTE_HOST: "other.tail1234.ts.net" }, { ORBIT_REMOTE_AUTO: "0" }]) {
        const run = detect(env, { "status --json": running, "serve status --json": "{}", [SERVE]: "" });
        expect(await run.host).toBeUndefined();
        expect(run.calls).toEqual([]);
        expect(run.lines).toEqual([]);
      }
    });

    it("mints a key for the detected host", () => {
      const { host, key } = initRemoteAccess({}, freshDir(), () => {}, HOST);
      expect(host).toBe(HOST);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});

describe("Phone Link setup", () => {
  const enableUrl = "https://login.tailscale.com/f/serve?node=node123&next=%2F";
  const running = JSON.stringify({ BackendState: "Running", Self: { DNSName: `${HOST}.` } });
  const quiet = () => {};

  function fake(failure?: Error) {
    return async (_file: string, args: string[]) => {
      if (args[0] === "status") return running;
      if (args[1] === "status") return "{}";
      if (failure) throw failure;
      return "";
    };
  }

  it("reports the exact Serve enable URL from output beyond the log limit", async () => {
    let setup: RemoteSetup | undefined;
    const error = Object.assign(new Error("command failed"), {
      stderr: "progress ".repeat(100),
      stdout: `Serve is not enabled on your tailnet.\nTo enable, visit:\n${enableUrl}\n`,
    });
    expect(await autoRemoteHost({}, 8799, fake(error), quiet, "linux", (value) => { setup = value; })).toBeUndefined();
    expect(setup).toEqual({ state: "serve-disabled", enableUrl });
  });

  it.each([
    "http://login.tailscale.com/f/serve?node=x",
    "https://login.tailscale.com.evil.test/f/serve?node=x",
    "https://login.tailscale.com@evil.test/f/serve?node=x",
    "https://evil.test/f/serve?node=x",
    "https://login.tailscale.com:444/f/serve?node=x",
    "https://user@login.tailscale.com/f/serve?node=x",
  ])("refuses an untrusted setup URL %s", async (url) => {
    let setup: RemoteSetup | undefined;
    await autoRemoteHost({}, 8799, fake(new Error(`Serve is not enabled on your tailnet. ${url}`)), quiet, "linux", (value) => { setup = value; });
    expect(setup).toEqual({ state: "serve-disabled" });
  });

  it("does not offer an enable URL for an unrelated Serve failure", async () => {
    let setup: RemoteSetup | undefined;
    await autoRemoteHost({}, 8799, fake(new Error(`connection failed ${enableUrl}`)), quiet, "linux", (value) => { setup = value; });
    expect(setup).toEqual({ state: "error" });
  });

  it.each([
    [new Error("ENOENT"), "missing"],
    [new Error("failed to connect to local tailscaled"), "not-running"],
  ])("reports unavailable Tailscale: %s", async (error, state) => {
    let setup: RemoteSetup | undefined;
    await autoRemoteHost({}, 8799, async () => { throw error; }, quiet, "win32", (value) => { setup = value; });
    expect(setup).toEqual({ state });
  });

  it.each(["Stopped", "NeedsLogin"])("reports Tailscale %s with a start/connect step", async (BackendState) => {
    let setup: RemoteSetup | undefined;
    await autoRemoteHost({}, 8799, async () => JSON.stringify({ BackendState }), quiet, "linux", (value) => { setup = value; });
    expect(setup).toEqual({ state: "not-running" });
  });

  it.each(["missing", "not-running", "serve-disabled"])("recovers from %s without restarting or overlapping detection", async (initial) => {
    let available = false;
    let now = 0;
    const hosts: string[] = [];
    let calls = 0;
    const exec = async (file: string, args: string[]) => {
      calls++;
      if (!available && initial === "missing") throw new Error("ENOENT");
      if (!available && initial === "not-running") return JSON.stringify({ BackendState: "Stopped" });
      return fake(!available ? new Error(`Serve is not enabled on your tailnet. ${enableUrl}`) : undefined)(file, args);
    };
    const retry = remoteHostRetry({}, 8799, (host) => hosts.push(host), exec, quiet, "linux", () => now);
    await Promise.all([retry.refresh(), retry.refresh()]);
    expect(retry.status().state).toBe(initial);
    const firstCalls = calls;
    available = true;
    await retry.refresh();
    expect(calls).toBe(firstCalls);
    now = 5_000;
    await Promise.all([retry.refresh(), retry.refresh()]);
    expect(retry.status()).toEqual({ state: "ready" });
    expect(hosts).toEqual([HOST]);
    expect(calls - firstCalls).toBe(3);
    now = 10_000;
    await retry.refresh();
    expect(hosts).toEqual([HOST]);
  });

  it("keeps explicit auto-off from starting Tailscale", async () => {
    const retry = remoteHostRetry({ ORBIT_REMOTE_AUTO: "0" }, 8799, () => { throw new Error("unexpected host"); }, async () => { throw new Error("unexpected command"); }, quiet);
    await retry.refresh();
    expect(retry.status()).toEqual({ state: "disabled" });
  });
});
