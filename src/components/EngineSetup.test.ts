import { describe, expect, it } from "vitest";

import { installCommandFor, isApiKeySetupMessage, needsApiKey, needsCli, needsSignIn, setupErrorAction } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("API key setup", () => {
  function gemini(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
    return {
      instanceId: "gemini",
      driverKind: "geminiAgent",
      displayName: "Gemini API",
      models: { default: "auto", options: [] },
      snapshot,
    };
  }

  it("treats an installed Gemini CLI without a key as an API-key paste, not Retry", () => {
    const missingKey = gemini({ state: "available", authenticated: false, version: "0.1.0" });
    expect(needsApiKey(missingKey)).toBe(true);
    expect(setupErrorAction("Gemini API key missing", missingKey)).toBe("key");
    expect(setupErrorAction("Gemini API key missing", undefined)).toBe("key");
    expect(isApiKeySetupMessage("Gemini API key missing")).toBe(true);
  });

  it("still installs the CLI first when the binary is absent", () => {
    const missingCli = gemini({ state: "unavailable", reason: "`gemini` CLI not found" });
    expect(needsCli(missingCli)).toBe(true);
    expect(setupErrorAction("Gemini API key missing", missingCli)).toBe("cli");
  });

  it("keeps Grok on the Terminal sign-in path", () => {
    const grok: InstanceInfo = {
      instanceId: "grok",
      driverKind: "grokAgent",
      displayName: "Grok",
      models: { default: "grok-4.6", options: [] },
      snapshot: { state: "available", authenticated: false },
    };
    expect(needsApiKey(grok)).toBe(false);
    expect(setupErrorAction("Grok CLI is not signed in", grok)).toBe("cli");
  });

  it("does not send CLI engines to Connections just because the error mentions an API key", () => {
    const grok = (authenticated: boolean): InstanceInfo => ({
      instanceId: "grok",
      driverKind: "grokAgent",
      displayName: "Grok",
      models: { default: "grok-4.6", options: [] },
      snapshot: { state: "available", authenticated },
    });
    expect(setupErrorAction("Invalid API key provided", grok(false))).toBe("cli");
    expect(setupErrorAction("Invalid API key provided", grok(true))).toBe("retry");
  });

  it("still pastes a key when Gemini is installed but the snapshot has not flagged unauthenticated", () => {
    const installed = gemini({ state: "available", authenticated: true, version: "0.1.0" });
    const unset = gemini({ state: "available", version: "0.1.0" });
    expect(needsApiKey(installed)).toBe(false);
    expect(needsApiKey(unset)).toBe(false);
    expect(setupErrorAction("Gemini API key missing", installed)).toBe("key");
    expect(setupErrorAction("Gemini API key missing", unset)).toBe("key");
  });
});

describe("installCommandFor", () => {
  const grokAndClaude = {
    grok: {
      docsUrl: "https://x.ai/cli",
      command: {
        darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
        linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
        win32: "irm https://x.ai/cli/install.ps1 | iex",
      },
    },
    claude: {
      docsUrl: "https://claude.com/claude-code",
      command: {
        darwin: "npm install -g @anthropic-ai/claude-code",
        linux: "npm install -g @anthropic-ai/claude-code",
        win32: "irm https://claude.ai/install.ps1 | iex",
      },
    },
  };

  function withHostPlatform<T>(platform: "darwin" | "win32" | "linux", run: () => T): T {
    const previous = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      value: { ...(previous ?? {}), ogb: { platform } },
      configurable: true,
      writable: true,
    });
    try {
      return run();
    } finally {
      Object.defineProperty(globalThis, "window", {
        value: previous,
        configurable: true,
        writable: true,
      });
    }
  }

  it("returns the official Windows PowerShell one-liners on win32", () => {
    withHostPlatform("win32", () => {
      expect(installCommandFor(grokAndClaude.grok)).toBe("irm https://x.ai/cli/install.ps1 | iex");
      expect(installCommandFor(grokAndClaude.claude)).toBe("irm https://claude.ai/install.ps1 | iex");
    });
  });

  it("keeps the POSIX installers on macOS and Linux", () => {
    withHostPlatform("darwin", () => {
      expect(installCommandFor(grokAndClaude.grok)).toBe("curl -fsSL https://x.ai/cli/install.sh | bash");
      expect(installCommandFor(grokAndClaude.claude)).toBe("npm install -g @anthropic-ai/claude-code");
    });
    withHostPlatform("linux", () => {
      expect(installCommandFor(grokAndClaude.grok)).toBe("curl -fsSL https://x.ai/cli/install.sh | bash");
      expect(installCommandFor(grokAndClaude.claude)).toBe("npm install -g @anthropic-ai/claude-code");
    });
  });
});
