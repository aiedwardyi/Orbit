import "./ProfileFields.test-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

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
      secret: { target: "xaiApiKey", label: "xAI API Key", description: "", placeholder: "", helpUrl: "https://console.x.ai/", requestKey: "r", ...secret },
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

let root: Root | undefined;
let host: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  Object.assign(window, { ogb: undefined });
  applyLocale("en");
  vi.unstubAllGlobals();
});

async function mountAndFill(target = "custom:api.acme.dev") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(SecretRequestCard, {
    botId: "owner-bot", threadId: "owner-thread",
    message: { id: "card", kind: "secret", role: "bot", at: 1, secret: {
      target, label: "Acme", description: "Waiting for a key", placeholder: "", helpUrl: "", requestKey: "r",
      service: { name: "Acme", host: "api.acme.dev", header: "authorization", prefix: "Bearer " },
    } } as Message,
  }))));
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "test-only-key");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

const submit = () => act(async () => {
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});

it("binds a synced card to the displayed host even when its target differs", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ saved: true, config: {} })));
  vi.stubGlobal("fetch", fetchMock);
  await mountAndFill("custom:other.example");
  await submit();
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(init.body as string).target).toBe("custom:api.acme.dev");
});

it.each([
  ["en", "credential-rejected", "The service rejected this key. Check it and try again."],
  ["ko", "credential-rejected", "서비스가 이 키를 거부했습니다. 확인한 다음 다시 시도해 주세요."],
  ["en", "credential-save-timeout", "The key may not have been saved. Check the desktop app on this bot's PC before trying again."],
  ["ko", "credential-save-timeout", "키가 저장되지 않았을 수 있습니다. 다시 시도하기 전에 이 봇이 있는 PC의 데스크톱 앱을 확인해 주세요."],
])("shows an honest %s message for %s", async (locale, error, text) => {
  Object.assign(window, { ogb: { getLocalePreference: () => locale } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error }), { status: 503 })));
  const input = await mountAndFill();
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(text);
  expect(input.disabled).toBe(false);
  applyLocale("en");
});

it("keeps the key and waiting card after a failed save, without notifying provided", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Save failed" }), { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  const input = await mountAndFill();
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  expect(host.textContent).not.toContain("Saved");
  expect(input.value).toBe("test-only-key");
  expect(input.disabled).toBe(false);
  expect(fetchMock.mock.calls).toHaveLength(1);
});

it("saves through the owner's server even when the viewing PC has a credential preload", async () => {
  const viewerSave = vi.fn(async () => ({ customKeys: [] }));
  Object.assign(window, { ogb: { setCredential: viewerSave } });
  let confirm!: (response: Response) => void;
  const fetchMock = vi.fn((path: string) => path === "/api/credentials"
    ? new Promise<Response>((resolve) => { confirm = resolve; })
    : Promise.resolve(new Response(JSON.stringify({ provided: true }))));
  vi.stubGlobal("fetch", fetchMock);
  const input = await mountAndFill();
  await submit();
  expect(viewerSave).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("/api/credentials");
  expect(input.value).toBe("test-only-key");
  expect(host.textContent).not.toContain("Saved");
  await act(async () => confirm(new Response(JSON.stringify({ saved: true, config: { customKeys: [{ host: "api.acme.dev", name: "Acme" }] } }))));
  expect(fetchMock.mock.calls[1][0]).toBe("/api/bots/owner-bot/secret-cards/card/provided");
  expect(input.value).toBe("");
});
