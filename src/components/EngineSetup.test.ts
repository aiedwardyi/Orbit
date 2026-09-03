import { describe, expect, it } from "vitest";

import { installCommandFor, needsCli, needsSignIn } from "./EngineSetup";
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
