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
    install: { docsUrl: "https://claude.com/claude-code", command: { darwin: "npm install -g @anthropic-ai/claude-code" } },
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
    install: { docsUrl: "https://x.ai/cli", command: { darwin: "curl -fsSL https://x.ai/cli/install.sh | bash" } },
  }),
  unavailable({
    instanceId: "antigravity",
    driverKind: "antigravityAgent",
    displayName: "Antigravity",
    install: { docsUrl: "https://antigravity.example" },
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
  it("screams one Grok or Claude connect path instead of the engine zoo", () => {
    const html = markup();
    expect(html).toContain("Connect Grok or Claude");
    expect(html).toContain("Your bots need one of these to run. Pick the one you already use.");
    expect(html).toContain("Install Grok");
    expect(html).toContain("Install Claude");
    expect(html).toContain("curl -fsSL https://x.ai/cli/install.sh | bash");
    expect(html).toContain("npm install -g @anthropic-ai/claude-code");
    expect(html.indexOf("Install Grok")).toBeLessThan(html.indexOf("Install Claude"));
    expect(html).toContain("Check again");
    expect(html).not.toContain("Install an AI engine to get started");
    expect(html).not.toContain("Install Codex");
    expect(html).not.toContain("Install Gemini");
    expect(html).not.toContain("Install Kimi");
    expect(html).not.toContain("Install Antigravity");
    expect(html).not.toContain(">Cloud<");
    expect(html).not.toContain(">Local<");
  });
});
