// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Page {
  hits: ReturnType<typeof hit>[];
  more: boolean;
}

const mock = vi.hoisted(() => ({ landed: new Array<string>(), pages: new Array<(body: Page) => void>() }));

const hit = (messageId: string) => ({ threadId: "t", messageId, at: 1, role: "bot", kind: "text", snippet: "q", matchStart: 0, matchLength: 1, matches: 1 });
const page = Array.from({ length: 100 }, (_, i) => hit(`m${i}`));

// oxlint-disable-next-line anti-slop/no-module-mocking -- the bar talks to the API and the store; this test releases one page by hand.
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: {}, dispatch: () => {} }),
  api: (path: string) => (path.includes("&before=") ? new Promise<Page>((resolve) => { mock.pages.push(resolve); }) : Promise.resolve({ hits: page, more: true })),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- landing scrolls the real transcript; only the call is recorded.
vi.mock("@/lib/focus-message", () => ({
  landOnSearchHit: async (found: { messageId: string }) => { mock.landed.push(found.messageId); },
  restoreChatChrome: () => {},
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- pins the default (chips) skin.
vi.mock("@/lib/skins", () => ({ useSkin: () => "precision", isTerminalSkin: () => false }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- keys stand in for strings.
vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { ChatFindBar } from "./ChatFindBar";

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => root?.unmount());
  root = null;
  mock.landed.length = 0;
  mock.pages.length = 0;
  document.body.innerHTML = "";
});

async function mount(threadId: string) {
  const host = document.body.appendChild(document.createElement("main"));
  root = createRoot(host);
  const show = (id: string) => root!.render(createElement(ChatFindBar, { threadId: id, initialQuery: "q", initialMessageId: "m99", onClose: () => {} }));
  await act(async () => show(threadId));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="find.older"]')!.click());
  return show;
}

describe("ChatFindBar late older page", () => {
  it("does not land after the bar unmounts", async () => {
    await mount("t");
    expect(mock.landed).toEqual(["m99"]);
    await act(async () => root!.unmount());
    root = null;
    await act(async () => mock.pages[0]!({ hits: [hit("older")], more: false }));
    expect(mock.landed).toEqual(["m99"]);
  });

  it("does not land after the chat changes", async () => {
    const show = await mount("t");
    await act(async () => show("other"));
    await act(async () => mock.pages[0]!({ hits: [hit("older")], more: false }));
    expect(mock.landed).not.toContain("older");
  });
});
