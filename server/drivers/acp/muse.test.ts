import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MuseAgentDriver, STATIC_MUSE_MODELS, classifyMuseError, museDefaultCli, museIsAuthenticated, museSignInCommand, museWslFallbackCli, withWslKeySharing } from "./muse.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { augmentedPath, resolveCliSpawn } from "../../env-path.ts";

describe("Meta Muse driver catalog", () => {
  it("serves exactly the two Meta Muse models with the required labels", () => {
    expect(STATIC_MUSE_MODELS.default).toBe("muse-spark-1.3");
    expect(STATIC_MUSE_MODELS.options).toEqual([
      { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
      { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
    ]);
  });

  it("registers as the Meta Muse engine on the muse CLI", () => {
    expect(MuseAgentDriver.driverKind).toBe("museAgent");
    expect(MuseAgentDriver.metadata.displayName).toBe("Meta Muse");
    expect(MuseAgentDriver.models).toEqual(STATIC_MUSE_MODELS);
  });

  it("advertises subscription windows and the official installer", () => {
    expect(MuseAgentDriver.install?.command?.linux).toContain("https://dev.meta.ai/install.sh");
    expect(MuseAgentDriver.install?.command?.darwin).toContain("https://dev.meta.ai/install.sh");
    // Explicit platforms: the shipped value is platform-evaluated, so it is
    // `wsl muse login` on win32 by design, never bare `muse login` there.
    expect(museSignInCommand("darwin")).toBe("muse login");
    expect(museSignInCommand("win32")).toBe("wsl muse login");
    expect(MuseAgentDriver.install?.signInCommand).toBe(museSignInCommand());
  });

  it("accepts META_API_KEY without a stored login", () => {
    // Isolated from the real home: an ambient developer login must not leak
    // into (or out of) this assertion. Pinned off-win32 so the `false` cases
    // never reach the real WSL probe, which CI cannot control.
    const platform = { platform: "linux" } as const;
    const home = mkdtempSync(join(tmpdir(), "omb-muse-nologin-home-"));
    const env = { HOME: home, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "omb-muse-nologin-xdg-")) };
    expect(museIsAuthenticated({ ...env, META_API_KEY: "meta-key" }, undefined, platform)).toBe(true);
    expect(museIsAuthenticated(env, undefined, platform)).toBe(false);
    expect(museIsAuthenticated({ ...env, META_API_KEY: "  " }, undefined, platform)).toBe(false);
  });

  it("probes the WSL-side login on win32 instead of trusting the Windows home", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-muse-win-home-"));
    const env = { HOME: home, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "omb-muse-win-xdg-")) };
    expect(museIsAuthenticated(env, undefined, { platform: "win32", probeWslAuth: () => true })).toBe(true);
    expect(museIsAuthenticated(env, undefined, { platform: "win32", probeWslAuth: () => false })).toBe(false);
    // a probe that throws (no WSL, timeout) reads as logged out, never crashes
    expect(museIsAuthenticated(env, undefined, {
      platform: "win32",
      probeWslAuth: () => {
        throw new Error("wsl missing");
      },
    })).toBe(false);
  });

  it("hands the WSL auth probe the augmented PATH, not the bare GUI one", () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const env = { PATH: "/gui/bin", HOME: "/tmp/win-home" };
    expect(
      museIsAuthenticated(env, undefined, {
        platform: "win32",
        probeWslAuth: (probeEnv) => {
          seen = probeEnv;
          return true;
        },
      }),
    ).toBe(true);
    // System32 (and the rest of the augmented PATH) rides along so wsl.exe
    // resolves; the caller's own entries survive underneath it.
    expect(seen?.PATH).toBe(augmentedPath());
    expect(seen?.HOME).toBe("/tmp/win-home");
  });

  it("never accepts a Windows-side login file for the WSL process", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-muse-stale-home-"));
    const xdg = mkdtempSync(join(tmpdir(), "omb-muse-stale-xdg-"));
    mkdirSync(join(xdg, "muse"), { recursive: true });
    writeFileSync(join(xdg, "muse", "auth.json"), JSON.stringify({ token: "stale-windows-copy" }));
    const env = { HOME: home, XDG_CONFIG_HOME: xdg };
    // The same file counts off-Windows, where the process reads it directly.
    expect(museIsAuthenticated(env, undefined, { platform: "linux" })).toBe(true);
    // On win32 only the key and the WSL-side probe count: a stale copy must
    // not read as signed in while every turn would fail.
    expect(museIsAuthenticated(env, undefined, { platform: "win32", probeWslAuth: () => false })).toBe(false);
    expect(museIsAuthenticated(env, undefined, { platform: "win32", probeWslAuth: () => true })).toBe(true);
    expect(museIsAuthenticated({ ...env, META_API_KEY: "meta-key" }, undefined, { platform: "win32", probeWslAuth: () => false })).toBe(true);
  });

  it("reads the sign-in command for this platform", () => {
    expect(museSignInCommand("win32")).toBe("wsl muse login");
    expect(museSignInCommand("linux")).toBe("muse login");
    expect(museSignInCommand("darwin")).toBe("muse login");
    expect(MuseAgentDriver.install?.signInCommand).toBe(museSignInCommand());
  });

  it("accepts the stored OIDC login at the XDG path", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-muse-home-"));
    const xdg = mkdtempSync(join(tmpdir(), "omb-muse-xdg-"));
    mkdirSync(join(xdg, "muse"), { recursive: true });
    writeFileSync(join(xdg, "muse", "auth.json"), JSON.stringify({ token: "stored" }));
    // Pinned off-win32: on win32 the file path is deliberately ignored in
    // favor of the WSL-side probe (see the stale-copy test below), so an
    // ambient-platform call would take the real probe there.
    const platform = { platform: "linux" } as const;
    expect(museIsAuthenticated({ HOME: home, XDG_CONFIG_HOME: xdg }, undefined, platform)).toBe(true);
    expect(museIsAuthenticated({ HOME: home, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "omb-muse-empty-")) }, undefined, platform)).toBe(false);
  });

  it("classifies auth failures without coupling to messages", () => {
    expect(classifyMuseError({ code: "AUTH_REQUIRED" })).toBe("invalid_credentials");
    expect(classifyMuseError({ code: "QUOTA_EXCEEDED" })).toBe("quota_or_region_restriction");
    expect(classifyMuseError({ code: -32601 })).toBeUndefined();
  });

  it("reads the provider code inside a -32000 envelope before falling back", () => {
    expect(classifyMuseError({ code: -32000, data: { code: "QUOTA_EXCEEDED" } })).toBe("quota_or_region_restriction");
    expect(classifyMuseError({ code: -32000, data: { error: { code: "REGION_RESTRICTED" } } })).toBe("quota_or_region_restriction");
    expect(classifyMuseError({ code: -32000, data: { error: { code: "SUBSCRIPTION_INACTIVE" } } })).toBe("inactive_subscription");
    expect(classifyMuseError({ code: -32000, data: { code: "AUTH_REQUIRED" } })).toBe("invalid_credentials");
    // no inner code (e.g. the harness auth-required envelope) keeps the old fallback
    expect(classifyMuseError({ code: -32000, message: "Authentication required", data: { providerId: "muse" } })).toBe("invalid_credentials");
    expect(classifyMuseError({ code: -32000 })).toBe("invalid_credentials");
    expect(classifyMuseError({ code: -32000, data: { code: "SOMETHING_NEW" } })).toBe("invalid_credentials");
  });

  it("replaces OpenCode in the built-in fleet", () => {
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
    expect(kinds).toContain("museAgent");
    expect(kinds).not.toContain("opencodeGo");
  });

  it("routes spawn through WSL on Windows, direct elsewhere", () => {
    expect(museDefaultCli("win32")).toBe("wsl muse");
    expect(museDefaultCli("linux")).toBe("muse");
    expect(museDefaultCli("darwin")).toBe("muse");
  });

  it("carries the muse argv through the wsl wrapper without a shell", () => {
    const resolved = resolveCliSpawn(museDefaultCli("win32"), ["serve", "--model", "muse-spark-1.3"]);
    // PATHEXT-aware whichWin can return uppercase `wsl.EXE` on win32, so the
    // match is case-insensitive; Windows executes it either way.
    expect(resolved.command).toMatch(/wsl(\.exe)?$/i);
    expect(resolved.args).toEqual(["muse", "serve", "--model", "muse-spark-1.3"]);
  });

  it("shares META_API_KEY into WSL instead of dropping it at the boundary", () => {
    const env: Record<string, string | undefined> = { META_API_KEY: "meta-key" };
    withWslKeySharing(env);
    expect(env.WSLENV).toBe("META_API_KEY");
    const existing: Record<string, string | undefined> = { META_API_KEY: "meta-key", WSLENV: "FOO/bar" };
    withWslKeySharing(existing);
    expect(existing.WSLENV).toBe("FOO/bar:META_API_KEY");
    const missing: Record<string, string | undefined> = {};
    withWslKeySharing(missing);
    expect(missing.WSLENV).toBeUndefined();
  });

  it("installs inside WSL on Windows with a PowerShell-runnable command", () => {
    expect(MuseAgentDriver.install?.command?.win32).toBe('wsl bash -c "curl -fsSL https://dev.meta.ai/install.sh | bash"');
  });

  it("retries a bare CLI override through WSL instead of asking for a filepath", () => {
    expect(museWslFallbackCli("muse")).toBe("wsl muse");
    expect(museWslFallbackCli("  muse  ")).toBe("wsl muse");
    expect(museWslFallbackCli("C:\\tools\\muse.exe")).toBe("wsl C:\\tools\\muse.exe");
    // already wrapped: nothing to fall back to
    expect(museWslFallbackCli("wsl muse")).toBeNull();
    expect(museWslFallbackCli("wsl.exe muse")).toBeNull();
    expect(museWslFallbackCli("WSL muse")).toBeNull();
  });
});
