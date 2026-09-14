import { describe, expect, it } from "vitest";

import { installCommandFor, isApiKeySetupMessage, needsApiKey, needsCli, needsSignIn, openInstallTerminalOrCopy, setupErrorAction } from "./EngineSetup";
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
    expect(setupErrorAction("OpenCode API key missing", undefined)).toBe("retry");
    expect(setupErrorAction("Invalid API key provided", undefined)).toBe("retry");
    expect(isApiKeySetupMessage("Gemini API key missing")).toBe(true);
  });

  it("sends Meta Muse sign-in through the CLI, never Connections", () => {
    const muse: InstanceInfo = {
      instanceId: "muse",
      driverKind: "museAgent",
      displayName: "Meta Muse",
      models: { default: "muse-spark-1.3", options: [] },
      snapshot: { state: "available", authenticated: false },
    };
    expect(needsApiKey(muse)).toBe(false);
    expect(setupErrorAction("Muse CLI is not signed in", muse)).toBe("cli");
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
    const cli = (driverKind: string, authenticated: boolean): InstanceInfo => ({
      instanceId: driverKind,
      driverKind,
      displayName: driverKind,
      models: { default: "default", options: [] },
      snapshot: { state: "available", authenticated },
    });
    for (const kind of ["grokAgent", "claudeAgent"] as const) {
      expect(setupErrorAction("Invalid API key provided", cli(kind, false))).toBe("cli");
      expect(setupErrorAction("Invalid API key provided", cli(kind, true))).toBe("retry");
    }
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

describe("openInstallTerminalOrCopy", () => {
  it("reports opened without touching the clipboard when the terminal launches", async () => {
    let copies = 0;
    const result = await openInstallTerminalOrCopy("install-cmd", async () => true, async () => {
      copies++;
    });
    expect(result).toBe("opened");
    expect(copies).toBe(0);
  });

  it("trusts the main-process clipboard copy when no terminal launches", async () => {
    let copies = 0;
    const result = await openInstallTerminalOrCopy("install-cmd", async () => false, async () => {
      copies++;
    });
    expect(result).toBe("copied");
    expect(copies).toBe(0);
  });

  it("copies the command when the terminal invoke rejects", async () => {
    let copied: string | null = null;
    const result = await openInstallTerminalOrCopy(
      "install-cmd",
      async () => {
        throw new Error("No handler registered for 'engine:open-terminal'");
      },
      async (text) => {
        copied = text;
      },
    );
    expect(result).toBe("copied");
    expect(copied).toBe("install-cmd");
  });

  it("copies the command when there is no terminal opener at all", async () => {
    let copied: string | null = null;
    const result = await openInstallTerminalOrCopy("install-cmd", undefined, async (text) => {
      copied = text;
    });
    expect(result).toBe("copied");
    expect(copied).toBe("install-cmd");
  });

  it("propagates a blocked clipboard so the caller shows no false copied state", async () => {
    await expect(
      openInstallTerminalOrCopy(
        "install-cmd",
        async () => {
          throw new Error("no handler");
        },
        async () => {
          throw new Error("clipboard blocked");
        },
      ),
    ).rejects.toThrow("clipboard blocked");
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
