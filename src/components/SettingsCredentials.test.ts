import "./ProfileFields.test-dom";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { persistPreference, I18nProvider } from "@/lib/i18n";
import { catalogs } from "@/lib/i18n-catalog";
import type { Bot } from "@/state/store";

const { state, dispatch } = vi.hoisted(() => ({
  state: { config: { composio: { configured: true }, box: { configured: true }, tts: { provider: "elevenlabs", configured: false }, imageGen: { configured: false }, customKeys: [{ host: "api.acme.dev", name: "Acme" }] }, bots: [] },
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state, dispatch, flushBotPatches: vi.fn() }),
}));
vi.mock("@/lib/friends-chrome", async (original) => ({
  ...(await original<typeof import("@/lib/friends-chrome")>()),
  showAvatarImageGenerate: () => true,
}));

import { ApiKeyRow, SavedKeys } from "./ApiKeys";
import { VoiceSettings } from "./VoiceSettings";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";

let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  Object.assign(window, { ogb: undefined });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dispatch.mockClear();
  persistPreference("en");
});

async function mount(element: ReactElement, locale: "en" | "ko" = "en") {
  vi.stubGlobal("localStorage", window.localStorage);
  persistPreference(locale);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, element)));
}

async function saveInput() {
  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "test-only-settings-key");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => (input.nextElementSibling as HTMLButtonElement).click());
}

const bot = { id: "bot", name: "Bot", color: "blue" } as Bot;
const rows: [string, () => ReactElement][] = [
  ["composioApiKey", () => createElement(ApiKeyRow, { section: "composio" })],
  ["boxToken", () => createElement(ApiKeyRow, { section: "box" })],
  ["ttsKey", () => createElement(VoiceSettings, { bot, onPatch: vi.fn() })],
  ["openaiImageApiKey", () => createElement(BotProfileAvatarCard, { bot, activeState: "idle", mascotMotion: null, onPatch: vi.fn() })],
];

it("localizes credential failures for every Settings save and removal in English and Korean, preserving unknown errors", async () => {
  const failures = [
    ["desktop-unavailable", "secret.desktopUnavailable"],
    ["credential-rejected", "secret.credentialRejected"],
    ["credential-save-timeout", "secret.saveTimeout"],
    ["invalid-credential", "secret.invalidCredential"],
    ["credential-save-failed", "secret.saveFailed"],
    ["unknown-save-error", null],
  ] as const;
  const actions: [() => ReactElement, () => Promise<void>][] = [
    ...rows.map(([, element]) => [element, saveInput] as [() => ReactElement, () => Promise<void>]),
    [() => createElement(SavedKeys), async () => {
      await act(async () => (host.querySelector('button[aria-label]') as HTMLButtonElement).click());
    }],
  ];
  Object.assign(window, { confirm: () => true });
  for (const locale of ["en", "ko"] as const) {
    for (const [code, key] of failures) {
      vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify(
        path === "/api/key-uses" ? { uses: {} } : { error: code },
      ), { status: path === "/api/key-uses" ? 200 : 503 })));
      for (const [element, action] of actions) {
        await mount(element(), locale);
        await action();
        expect(host.textContent).toContain(key ? catalogs[locale][key] : code);
        await act(async () => root.unmount());
        host.remove();
      }
    }
  }
});

it.each(rows)("saves remote Settings %s through the owner's credential route", async (target, element) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ saved: true, config: state.config })));
  vi.stubGlobal("fetch", fetchMock);
  await mount(element());
  await saveInput();
  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/api/credentials");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string).target).toBe(target);
  expect(dispatch.mock.calls.at(-1)?.[0].config).toEqual(state.config);
});

it("clears a remote Settings key through the encrypted route", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ saved: true, config: state.config })));
  vi.stubGlobal("fetch", fetchMock);
  await mount(createElement(ApiKeyRow, { section: "box" }));
  await act(async () => (host.querySelector('input[type="password"]')!.nextElementSibling as HTMLButtonElement).click());
  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/api/credentials");
  expect(JSON.parse(init.body as string)).toEqual({ target: "boxToken", value: "" });
});

it("removes a remote saved custom key through the encrypted route", async () => {
  const fetchMock = vi.fn(async (path: string) => new Response(JSON.stringify(path === "/api/key-uses" ? { uses: {} } : { saved: true, config: state.config })));
  vi.stubGlobal("fetch", fetchMock);
  Object.assign(window, { confirm: () => true });
  await mount(createElement(SavedKeys));
  await act(async () => (host.querySelector('button[aria-label="Remove the Saved Key"]') as HTMLButtonElement).click());
  const [path, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  expect(path).toBe("/api/credentials");
  expect(JSON.parse(init.body as string)).toEqual({ target: "custom:api.acme.dev", value: "" });
});

it("preserves the owner desktop Settings preload path", async () => {
  const setCredential = vi.fn(async () => state.config);
  Object.assign(window, { ogb: { setCredential } });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await mount(createElement(ApiKeyRow, { section: "box" }));
  await saveInput();
  expect(setCredential).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("keeps the remote Settings input until encrypted storage confirms the save", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ saved: false, config: state.config }))));
  await mount(createElement(ApiKeyRow, { section: "box" }));
  await saveInput();
  expect(dispatch).not.toHaveBeenCalled();
  expect(Boolean((host.querySelector('input[type="password"]') as HTMLInputElement).value)).toBe(true);
});
