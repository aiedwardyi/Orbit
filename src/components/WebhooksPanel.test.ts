// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebhookTrigger } from "@/lib/webhooks";
import type { Bot } from "@/state/store";

let webhooks: WebhookTrigger[] = [];

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { webhooks, routineRuns: [], webhookAttempts: [], instances: [], config: { box: { configured: false } } },
      dispatch: () => undefined,
    }),
  };
});

vi.mock("@/components/Avatar", () => ({
  BotAvatar: () => null,
}));

import { WebhooksPanel } from "./WebhooksPanel";

const bots = [
  { id: "b1", name: "Ada", modelSelection: { instanceId: "codex", model: "m" } },
  { id: "b2", name: "Bo", modelSelection: { instanceId: "codex", model: "m" } },
] as Bot[];

const webhook = (botId: string): WebhookTrigger => ({
  id: "w1", endpointId: "e1", name: "Builds", prompt: "", botId, runOn: "maus", enabled: true, createdAt: 1, updatedAt: 1, deliveryCount: 0,
});

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  webhooks = [];
});

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(WebhooksPanel, { bots })));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  };
  const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
  const editSettings = async () => {
    host.querySelector("details.relative")!.setAttribute("open", "");
    await act(async () => button("Edit settings").click());
  };
  return { host, button, editSettings };
}

describe("webhook editor", () => {
  it("closes the ... menu when Edit settings opens the editor", async () => {
    webhooks = [webhook("b1")];
    const ui = await render();
    await ui.editSettings();
    expect(ui.host.textContent).toContain("Edit webhook");
    await act(async () => ui.button("Cancel").click());
    expect(ui.host.querySelector("details.relative")!.hasAttribute("open")).toBe(false);
  });

  it("picks the first live bot for a webhook whose bot is gone", async () => {
    webhooks = [webhook("gone")];
    const ui = await render();
    await ui.editSettings();
    expect(ui.button("Ada").className).toContain("border-accent/70");
    expect(ui.button("Save changes").disabled).toBe(false);
  });
});
