// @vitest-environment happy-dom
import { rmSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";

import { DATA_DIR } from "../../server/config.ts";
import type { CommsBus } from "../../server/comms-visibility.ts";
import {
  drainDelegations,
  finishDelegatedTurn,
  queueDelegation,
  takeOverDelegatedTurn,
  _pendingCount,
  _resetPending,
} from "../../server/delegations.ts";
import { Store, type BotRecord, type GroupRecord } from "../../server/store.ts";

import { ChatView } from "./ChatView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const toBot = (record: BotRecord, messages: Message[]): Bot => ({
  id: record.id, threadId: record.threadId, name: record.name, title: "", description: "", notifications: false,
  color: "blue", unread: false, busy: false, activity: "idle", modelSelection: { instanceId: "inst", model: "m" }, messages,
});

async function mount(current: Bot) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots: [current], groups: [], computerControl: {} })
    : new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null,
    createElement(StoreProvider, null, createElement(ChatView, { bot: current })),
  )));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return host;
}

describe("a bot's resent request in the target's chat", () => {
  let store: Store;
  let career: BotRecord;
  let wink: BotRecord;
  let commsBus: CommsBus;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    store = new Store(() => ({ instanceId: "claude", model: "fake-model" }));
    career = store.patchBot(store.createBot().id, { name: "Career" })!;
    wink = store.patchBot(store.createBot().id, { name: "Wink" })!;
    commsBus = { store, broadcast: () => {} };
  });

  const runTarget = (_to: string, _prompt: string, _depth: number, _src: string, channel: GroupRecord | undefined, taskId: string, _from: string, transcriptText?: string) => {
    // the user row startTurn stores for a peer's message
    store.appendMessage(wink.threadId, {
      role: "user",
      kind: "text",
      text: transcriptText,
      from: { botId: career.id, name: career.name, color: career.color },
      comm: channel ? { groupId: channel.id, withBotId: career.id, withName: career.name, withColor: career.color } : undefined,
    });
    turn = { channelId: channel?.id, toBotId: wink.id, taskId, sourceThreadId: career.threadId, sourceBotId: career.id };
  };
  let turn: Parameters<typeof takeOverDelegatedTurn>[1];
  const drain = () => drainDelegations(commsBus, { store, broadcast: () => {} }, career.threadId, runTarget);

  it("leads with the sender's chip, as the original does", async () => {
    queueDelegation(commsBus, career, { toBotId: wink.id, message: "What changed in the resume?", depth: 0 }, 1);
    drain();
    await vi.waitFor(() => expect(turn && _pendingCount(career.threadId)).toBe(0));
    takeOverDelegatedTurn(commsBus, turn, "Edward");
    store.appendMessage(wink.threadId, { role: "user", kind: "text", text: "Hey Wink" });
    finishDelegatedTurn(commsBus, turn, true, "Edward, 1.0.157 is out.");
    drain();
    await vi.waitFor(() => expect(store.messagesFor(wink.threadId).filter((m) => m.role === "user" && m.from)).toHaveLength(2));

    const stored = store.messagesFor(wink.threadId);
    const rows = stored.filter((m) => m.tool?.name === "Message from @Career" || (m.role === "user" && m.from));
    expect(rows.map((m) => m.tool?.name ?? m.text)).toEqual([
      "Message from @Career", "What changed in the resume?",
      "Message from @Career", "Answering Career's earlier request",
    ]);

    const host = await mount(toBot(wink, stored as Message[]));
    const bubble = [...host.querySelectorAll("[data-mid]")].find((row) => row.textContent?.includes("Answering Career's earlier request"));
    expect(bubble?.previousElementSibling?.textContent).toContain("Message from @Career");
  });
});
