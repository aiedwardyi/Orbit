import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import type { Message } from "@/state/store";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "navigator", { value: { language: "en" }, configurable: true });
});

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: {}, dispatch: () => undefined }),
}));

import { SecretRequestCard } from "./SecretRequestCard";

applyLocale("en");

const render = (secret: Partial<NonNullable<Message["secret"]>>) =>
  renderToStaticMarkup(createElement(I18nProvider, null, createElement(SecretRequestCard, {
    botId: "bot",
    threadId: "thread",
    message: {
      id: "m1",
      kind: "secret",
      secret: { target: "xaiApiKey", label: "xAI API key", description: "", placeholder: "", helpUrl: "https://console.x.ai/", requestKey: "r", ...secret },
    } as Message,
  })));

describe("SecretRequestCard", () => {
  it("shows the host a custom key is locked to", () => {
    const html = render({
      target: "custom:api.acme.dev",
      label: "Acme",
      helpUrl: "",
      service: { name: "Acme", host: "api.acme.dev", header: "authorization", prefix: "Bearer " },
    });
    expect(html).toContain("This key will only be sent to api.acme.dev");
    expect(html).toContain("text-[17px]");
    expect(html).not.toContain("Where to get this key");
  });

  it("keeps built-in cards unchanged", () => {
    const html = render({});
    expect(html).not.toContain("will only be sent to");
    expect(html).toContain("Where to get this key");
  });
});
