import { describe, expect, it } from "vitest";

import { installCommandFor, needsCli, needsSignIn, openInstallTerminalOrCopy, setupErrorAction } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n";
import { EngineSetup } from "./EngineSetup";

it("offers one-click sign-in for an installed CLI", () => {
  const previous = globalThis.window;
  Object.defineProperty(globalThis, "window", { value: { ogb: { platform: "win32" } }, configurable: true, writable: true });
  try {
    const row = { ...instance({ state: "available", authenticated: false }), install: { login: { args: ["login"] }, signInCommand: "fake login" } };
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(EngineSetup, { instance: row })));
    expect(html).toContain(">Sign In<");
    expect(html).toContain(">Not signed in<");
    expect(html).not.toContain("fake login");
    expect(html).not.toContain("Terminal");
  } finally {
    Object.defineProperty(globalThis, "window", { value: previous, configurable: true, writable: true });
  }
});

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "grok",
    driverKind: "grokAgent",
    displayName: "Grok",
    models: { default: "grok-4.6", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`grok` CLI not found" });
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
  it("sends Meta Muse sign-in through the CLI, never Connections", () => {
    const muse: InstanceInfo = {
      instanceId: "muse",
      driverKind: "museAgent",
      displayName: "Meta Muse",
      models: { default: "muse-spark-1.3", options: [] },
      snapshot: { state: "available", authenticated: false },
    };
    expect(setupErrorAction(muse)).toBe("cli");
  });

  it("still installs the CLI first when the binary is absent", () => {
    const missingCli = instance({ state: "unavailable", reason: "`grok` CLI not found" });
    expect(needsCli(missingCli)).toBe(true);
    expect(setupErrorAction(missingCli)).toBe("cli");
  });

  it("keeps Grok on the Terminal sign-in path", () => {
    const grok: InstanceInfo = {
      instanceId: "grok",
      driverKind: "grokAgent",
      displayName: "Grok",
      models: { default: "grok-4.6", options: [] },
      snapshot: { state: "available", authenticated: false },
    };
    expect(setupErrorAction(grok)).toBe("cli");
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
      expect(setupErrorAction(cli(kind, false))).toBe("cli");
      expect(setupErrorAction(cli(kind, true))).toBe("retry");
    }
  });

  it("offers Terminal when the error carries signIn and an instance is known", () => {
    const agy = instance({ state: "available", version: "1.2.4" });
    expect(setupErrorAction(agy, true)).toBe("cli");
    expect(setupErrorAction(agy)).toBe("retry");
    expect(setupErrorAction(undefined, true)).toBe("retry");
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
