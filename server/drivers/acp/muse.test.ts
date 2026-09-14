import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MuseAgentDriver, STATIC_MUSE_MODELS, classifyMuseError, museDefaultCli, museIsAuthenticated, museSignInCommand, withWslKeySharing } from "./muse.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { resolveCliSpawn } from "../../env-path.ts";

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
    expect(MuseAgentDriver.install?.signInCommand).toBe("muse login");
  });

  it("accepts META_API_KEY without a stored login", () => {
    // Isolated from the real home: an ambient developer login must not leak
    // into (or out of) this assertion.
    const home = mkdtempSync(join(tmpdir(), "omb-muse-nologin-home-"));
    const env = { HOME: home, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "omb-muse-nologin-xdg-")) };
    expect(museIsAuthenticated({ ...env, META_API_KEY: "meta-key" })).toBe(true);
    expect(museIsAuthenticated(env)).toBe(false);
    expect(museIsAuthenticated({ ...env, META_API_KEY: "  " })).toBe(false);
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
    expect(museIsAuthenticated({ HOME: home, XDG_CONFIG_HOME: xdg })).toBe(true);
    expect(museIsAuthenticated({ HOME: home, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "omb-muse-empty-")) })).toBe(false);
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
});
