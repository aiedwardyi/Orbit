import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { InstanceInfo } from "@/state/store";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: { ogb: undefined },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" },
    configurable: true,
  });
});

function unavailable(partial: Pick<InstanceInfo, "instanceId" | "driverKind" | "displayName"> & { install?: InstanceInfo["install"] }): InstanceInfo {
  return {
    models: { default: "", options: [] },
    snapshot: { state: "unavailable", reason: "CLI not found" },
    ...partial,
  };
}

const zoo: InstanceInfo[] = [
  unavailable({
    instanceId: "gemini",
    driverKind: "geminiAgent",
    displayName: "Gemini",
    install: { docsUrl: "https://gemini.example", command: { darwin: "npm i -g @google/gemini-cli" } },
  }),
  unavailable({
    instanceId: "claude",
    driverKind: "claudeAgent",
    displayName: "Claude",
    install: {
      docsUrl: "https://claude.com/claude-code",
      needsNode: true,
      command: {
        darwin: "npm install -g @anthropic-ai/claude-code",
        win32: "irm https://claude.ai/install.ps1 | iex",
      },
    },
  }),
  unavailable({
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    install: { docsUrl: "https://kimi.example", command: { darwin: "npm i -g kimi" } },
  }),
  unavailable({
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    install: { docsUrl: "https://codex.example", command: { darwin: "npm i -g @openai/codex" } },
  }),
  unavailable({
    instanceId: "grok",
    driverKind: "grokAgent",
    displayName: "Grok",
    install: {
      docsUrl: "https://x.ai/cli",
      command: {
        darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
        win32: "irm https://x.ai/cli/install.ps1 | iex",
      },
    },
  }),
  unavailable({
    instanceId: "antigravity",
    driverKind: "antigravityAgent",
    displayName: "Antigravity",
    install: { docsUrl: "https://antigravity.example" },
  }),
  unavailable({
    instanceId: "muse",
    driverKind: "museAgent",
    displayName: "Meta Muse",
    install: { docsUrl: "https://muse.example", command: { darwin: "curl -fsSL https://muse.example/install.sh | bash" } },
  }),
];

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { instances: zoo },
      dispatch: () => undefined,
      refreshInstances: async () => undefined,
    }),
  };
});

import { NoEngines } from "./NoEngines";
import { I18nProvider } from "@/lib/i18n";

function markup() {
  return renderToStaticMarkup(createElement(I18nProvider, null, createElement(NoEngines)));
}

describe("empty-engine first launch screen", () => {
  it("reuses the quiet row for an installed unsigned-in engine", () => {
    const claude = zoo.find((row) => row.driverKind === "claudeAgent")!;
    const previous = { snapshot: claude.snapshot, install: claude.install };
    claude.snapshot = { state: "available", authenticated: false };
    claude.install = { ...claude.install, login: { args: ["auth", "login"] } };
    try {
      const html = markup();
      expect(html).toContain(">Sign in to Claude<");
      expect(html).not.toContain(">Details<");
      expect(html).not.toContain("Open Sign-in in Terminal");
      expect(html).toContain("Install Grok");
    } finally { Object.assign(claude, previous); }
  });
  it("offers every shipped engine's connect path instead of the retired zoo", () => {
    const html = markup();
    expect(html).toContain("Connect an Engine");
    expect(html).not.toContain("Connect Claude or Grok");
    expect(html).toContain("Your bots run on an engine. Most people start with Claude.");
    const installs = ["Claude", "Codex", "Antigravity", "Grok", "Meta Muse"].map((name) => html.indexOf(`Install ${name}`, html.indexOf("data-engine-connect-commands")));
    expect(installs).not.toContain(-1);
    expect(installs).toEqual([...installs].sort((a, b) => a - b));
    expect(html).toContain("curl -fsSL https://x.ai/cli/install.sh | bash");
    expect(html).toContain("npm install -g @anthropic-ai/claude-code");
    expect(html).toContain("curl -fsSL https://muse.example/install.sh | bash");
    expect(html).toContain("Requires Node.js and npm.");
    expect(html).toContain("Show Commands");
    expect(html).not.toContain("Check again");
    expect(html).not.toContain("Install an AI engine to get started");
    expect(html).not.toContain("Install Gemini");
    expect(html).not.toContain("Install Kimi");
    expect(html).not.toContain(">Cloud<");
    expect(html).not.toContain(">Local<");
  });

  it("shows Windows PowerShell one-liners when the host is win32", () => {
    const previous = window.ogb;
    Object.defineProperty(window, "ogb", {
      value: { platform: "win32" },
      configurable: true,
      writable: true,
    });
    try {
      const html = markup();
      expect(html).toContain("irm https://x.ai/cli/install.ps1 | iex");
      expect(html).toContain("irm https://claude.ai/install.ps1 | iex");
      expect(html).not.toContain("curl -fsSL https://x.ai/cli/install.sh | bash");
      expect(html).not.toContain("npm install -g @anthropic-ai/claude-code");
      expect(html).not.toContain("Requires Node.js and npm.");
    } finally {
      Object.defineProperty(window, "ogb", {
        value: previous,
        configurable: true,
        writable: true,
      });
    }
  });
});
