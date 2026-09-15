// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo, Message } from "@/state/store";

let mockState = {
  bots: [] as Bot[],
  instances: [] as InstanceInfo[],
};

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: mockState,
      dispatch: () => undefined,
    }),
  };
});

import { RoomToolChip } from "./GroupView";

describe("RoomToolChip", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    host?.remove();
  });

  it("A rejected resend re-enables the Retry button", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    let capturedCallbacks: { onError?: () => void } | undefined;
    const onRetry = (callbacks?: { onError?: () => void }) => {
      capturedCallbacks = callbacks;
    };

    const message: Message = {
      id: "a1",
      role: "bot",
      kind: "activity",
      tool: { name: "error: failed", ok: false },
      at: 1,
    };

    await act(async () => {
      root.render(createElement(RoomToolChip, { message, onRetry }));
    });

    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      button?.click();
    });

    expect(button?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      capturedCallbacks?.onError?.();
    });

    expect(button?.hasAttribute("disabled")).toBe(false);
  });

  it("A failed turn offers Show full message and expands the truncated pill", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const longError = `error: provider-private history is incompatible with the active route: reasoning replay rs_aaa:rs_bbb has no provider mapping, so this text runs long`;
    const message: Message = {
      id: "a9",
      role: "bot",
      kind: "activity",
      tool: { name: longError, ok: false },
      at: 9,
    };

    await act(async () => {
      root.render(createElement(RoomToolChip, { message, onRetry: () => {} }));
    });

    const pill = () => host.querySelector("span.max-w-\\[480px\\], span.break-words");
    expect(pill()?.className).toMatch(/truncate/);
    expect(host.textContent).toContain("Show full message");

    const toggle = [...host.querySelectorAll("button")].find((b) => b.textContent === "Show full message");
    expect(toggle).not.toBeUndefined();
    await act(async () => {
      toggle?.click();
    });

    expect(pill()?.className).not.toMatch(/truncate/);
    expect(host.textContent).toContain(longError);
    expect(host.textContent).toContain("Show less");

    const collapse = [...host.querySelectorAll("button")].find((b) => b.textContent === "Show less");
    await act(async () => {
      collapse?.click();
    });
    expect(pill()?.className).toMatch(/truncate/);
  });

  it("A setup error on the last activity from the sole responder: exposes the same action setupErrorAction gives 1:1", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const botAlice = {
      id: "b1",
      name: "Alice",
      color: "blue",
      modelSelection: { model: "claude-3-7-sonnet", instanceId: "claude" },
    } as unknown as Bot;
    const claudeInstance = {
      instanceId: "claude",
      driverKind: "claudeAgent",
      displayName: "Claude",
      models: { default: "claude-3-7-sonnet", options: [] },
      install: {
        command: { win32: "npm install -g @anthropic-ai/claude-code", darwin: "npm i", linux: "npm i" },
      },
      snapshot: { state: "unavailable", reason: "`claude` CLI not found" },
    } as unknown as InstanceInfo;
    mockState = {
      bots: [botAlice],
      instances: [claudeInstance],
    };

    const cliMessage: Message = {
      id: "a1",
      role: "bot",
      kind: "activity",
      tool: { name: "error: claude cli missing", ok: false, setup: true },
      from: { botId: "b1", name: "Alice", color: "blue" as any },
      at: 2,
    };

    const prevOgb = window.ogb;
    window.ogb = { platform: "win32" } as any;
    try {
      await act(async () => {
        root.render(createElement(RoomToolChip, { message: cliMessage, onRetry: () => {} }));
      });

      // 1:1 setupErrorAction gives "cli", which renders EngineSetup with install action
      expect(host.querySelector("code")?.textContent).toBe(claudeInstance.install?.command?.win32);
      expect(host.textContent).toContain("Copy command");
    } finally {
      window.ogb = prevOgb;
    }

    const botBob = {
      id: "b2",
      name: "Bob",
      color: "orange",
      modelSelection: { model: "auto", instanceId: "gemini" },
    } as unknown as Bot;
    const geminiInstance = {
      instanceId: "gemini",
      driverKind: "geminiAgent",
      displayName: "Gemini",
      models: { default: "auto", options: [] },
      snapshot: { state: "available", authenticated: false, version: "0.1.0" },
    } as unknown as InstanceInfo;
    mockState = {
      bots: [botAlice, botBob],
      instances: [claudeInstance, geminiInstance],
    };

    // API key setup error renders OpenConnectionsCta
    const keyMessage: Message = {
      id: "a2",
      role: "bot",
      kind: "activity",
      tool: { name: "error: Gemini API key missing", ok: false, setup: true },
      from: { botId: "b2", name: "Bob", color: "amber" as any },
      at: 3,
    };

    await act(async () => {
      root.render(createElement(RoomToolChip, { message: keyMessage, onRetry: () => {} }));
    });

    expect(host.querySelector("button")?.textContent).toMatch(/enter api key/i);

    // Without onRetry/canSetup (not sole responder or not last activity), no setup action exposed
    await act(async () => {
      root.render(createElement(RoomToolChip, { message: keyMessage }));
    });

    expect(host.querySelector("button")).toBeNull();
  });
});
