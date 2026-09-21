// Remote-mode gates without booting the harness: key file, handshake
// compare, cookie minting, and the Host/Origin/API checks index.ts wires in.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  apiRequestAuthorized,
  buildRemoteSetCookie,
  hostMatchesRemote,
  loadOrCreateRemoteKey,
  originAllowedByRemote,
  remoteCookieAuthorized,
  remoteHandshakeUrl,
  remoteKeyMatches,
  resolveRemoteHost,
} from "./remote-access.ts";

const HOST = "home.tail396477.ts.net";
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
    for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
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
    expect(originAllowedByRemote("https://evil.example.com", HOST)).toBe(false);
  });

  it("persists one stable key per data dir", () => {
    const dir = freshDir();
    const first = loadOrCreateRemoteKey(dir);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(loadOrCreateRemoteKey(dir)).toBe(first);
    expect(readFileSync(join(dir, "remote-key.json"), "utf8")).toContain(first);
    expect(loadOrCreateRemoteKey(freshDir())).not.toBe(first);
  });

  it("builds the handshake URL for the boot log", () => {
    expect(remoteHandshakeUrl(HOST, "k")).toBe(`https://${HOST}/remote?key=k`);
  });
});
