// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Message } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({ state: { bots: [], instances: [], config: {} }, dispatch: () => undefined }),
    useStoreDispatch: () => () => undefined,
  };
});

import { I18nProvider } from "@/lib/i18n";
import { Transcript } from "./GroupView";

const ask: Message = {
  id: "q1",
  role: "bot",
  kind: "options",
  at: 1,
  card: { title: "Your bot has a question", subtitle: "Prod or staging?", options: ["Prod", "Staging"], askUser: true },
};
const reply: Message = { id: "u1", role: "user", kind: "text", at: 2, text: "Staging" };

describe("GroupView ask records", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("reads the shown transcript, not the live room, for a card in a jump window", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const group = { id: "room-1", name: "Room", threadId: "t1", messages: [] } as unknown as Group;
    await act(async () =>
      root!.render(
        createElement(
          I18nProvider,
          null,
          createElement(Transcript, {
            group,
            members: [],
            messages: [ask, reply],
            transcript: [ask, reply],
            streamingMessage: null,
            dock: null,
            onReply: () => undefined,
            onFocusComposer: () => undefined,
            onMessageMenu: () => undefined,
            workers: [],
          }),
        ),
      ),
    );
    expect(host.querySelector("[data-ask-user-record]")?.getAttribute("data-ask-user-record")).toBe("answered");
  });
});
