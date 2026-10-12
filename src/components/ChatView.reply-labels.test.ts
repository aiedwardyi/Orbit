// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Message } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import { applySkin } from "@/lib/skins";

import { ChatView } from "./ChatView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const comm: NonNullable<Message["comm"]> = { groupId: "pair", withBotId: "atlas", withName: "Atlas", withColor: "pink" };
const inbound: Message = {
  id: "inbound", at: 1, role: "user", kind: "text", text: "Check the release.",
  from: { botId: "atlas", name: "Atlas", color: "pink" }, comm,
};
const text = (id: string, role: Message["role"] = "bot"): Message => ({ id, at: 2, role, kind: "text", text: id });
const exchange = (): Message[] => [
  { id: "received", at: 1, role: "bot", kind: "activity", tool: { name: "Message from @Atlas" }, comm },
  { ...inbound },
  { id: "read", at: 1, role: "bot", kind: "activity", tool: { name: "Read", ok: true } },
  text("first reply"),
  text("second reply"),
];
const bot = (messages: Message[], busy = false): Bot => ({
  id: "helper", threadId: "thread-helper", name: "Helper", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy, activity: busy ? "working" : "idle", modelSelection: { instanceId: "inst", model: "m" }, messages,
});

let unmount: (() => Promise<void>) | null = null;
let selected = "";
function Selection() {
  selected = useStore().state.selectedId;
  return null;
}

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  applySkin("precision");
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
  const render = async (next: Bot) => {
    await act(async () => root.render(createElement(I18nProvider, null,
      createElement(StoreProvider, null, createElement(ChatView, { bot: next }), createElement(Selection)),
    )));
  };
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await render(current);
  await act(async () => {
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" });
  });
  return { host, render };
}

const label = (chip: HTMLButtonElement) => chip.querySelector("span.truncate")?.textContent;
const chips = (host: HTMLElement) => Array.from(host.querySelectorAll("button")).filter((button) => label(button)?.startsWith("Reply to @"));

describe("ChatView peer reply labels", () => {
  it.each(["legacy", "linked"])("labels the first bubble of a saved %s exchange without changing its data", async (format) => {
    const messages = exchange();
    if (format === "linked") {
      messages.forEach((message, i) => { message.parentId = messages[i - 1]?.id ?? null; });
    }
    const saved = JSON.stringify(messages);
    const { host } = await mount({ ...bot(messages), activeLeafId: format === "linked" ? messages.at(-1)?.id : undefined });
    const chip = chips(host)[0];

    expect(chips(host)).toHaveLength(1);
    expect(label(chip)).toBe("Reply to @Atlas");
    expect(chip.closest("[data-mid]")?.getAttribute("data-mid")).toBe("first reply");
    expect(chip.closest("[data-mid]")?.lastElementChild?.getAttribute("data-orbit-message")).toBe("bot");
    expect(host.querySelector('[data-mid="second reply"]')?.textContent).not.toContain("Reply to @");
    expect(host.textContent).toContain("Message from @Atlas");
    expect(JSON.stringify(messages)).toBe(saved);
  });

  it.each(["ordinary", "takeover"])("does not label a reply after a %s user message", async (kind) => {
    const human = text("Edward's question", "user");
    const { host } = await mount(bot(kind === "ordinary" ? [human, text("answer")] : [inbound, human, text("answer")]));
    expect(chips(host)).toHaveLength(0);
  });

  it("opens the pair channel when the reply chip is clicked", async () => {
    const { host } = await mount(bot(exchange()));
    expect(chips(host)).toHaveLength(1);
    await act(async () => { chips(host)[0].click(); });
    expect(selected).toBe("pair");
  });

  it("keeps the comm chip in the Terminal skin", async () => {
    applySkin("terminal");
    const { host } = await mount(bot(exchange()));
    expect(chips(host)).toHaveLength(1);
    expect(chips(host)[0].querySelector("svg")).not.toBeNull();
    expect(chips(host)[0].className).toBe(host.querySelector('[data-mid="received"] button')?.className);
  });

  it("translates the reply label into Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    const { host } = await mount(bot(exchange()));
    expect(host.querySelector('[data-mid="first reply"] button span.truncate')?.textContent).toBe("@Atlas에게 답장");
  });

  it("labels each peer turn once and skips hidden summaries", async () => {
    const nextComm = { ...comm, withBotId: "bounty", withName: "Bounty" };
    const { host } = await mount(bot([
      inbound,
      { ...text("summary"), summarized: true },
      text("first reply"), text("second reply"),
      { ...inbound, id: "next inbound", from: { botId: "bounty", name: "Bounty", color: "pink" }, comm: nextComm },
      text("next reply"), text("next second reply"),
    ]));
    expect(chips(host).map(label)).toEqual(["Reply to @Atlas", "Reply to @Bounty"]);
    expect(chips(host).map((chip) => chip.closest("[data-mid]")?.getAttribute("data-mid"))).toEqual(["first reply", "next reply"]);
  });

  it("skips blank bot text and labels the real reply", async () => {
    const { host } = await mount(bot([inbound, { ...text("blank"), text: " \n" }, text("answer")]));
    expect(chips(host).map((chip) => chip.closest("[data-mid]")?.getAttribute("data-mid"))).toEqual(["answer"]);
  });

  it("keeps the label and bubble when a streamed peer reply settles", async () => {
    const current = bot([inbound], true);
    const { host, render } = await mount(current);
    await act(async () => {
      for (const event of [
        { type: "turn.started", threadId: current.threadId, turnId: "peer", createdAt: 3 },
        { type: "content.delta", threadId: current.threadId, turnId: "peer", streamKind: "assistant_text", delta: "Answer", createdAt: 4 },
      ]) {
        FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ kind: "runtime", event }), lastEventId: "" });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const chip = chips(host)[0];
    const bubble = host.querySelector('[data-orbit-message="bot"]');
    expect(chips(host)).toHaveLength(1);
    const reply = { ...text("Answer"), parentId: inbound.id };
    await render(bot([inbound, reply]));
    await act(async () => {
      FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ kind: "message", threadId: current.threadId, message: reply }), lastEventId: "" });
    });
    expect(chips(host)).toHaveLength(1);
    expect(chips(host)[0]).toBe(chip);
    expect(host.querySelector('[data-orbit-message="bot"]')).toBe(bubble);
  });

  it("does not relabel later bubbles when the first reply is outside the mounted window", async () => {
    const messages = [inbound, ...Array.from({ length: 240 }, (_, i) => text(`reply ${i}`))];
    const { host } = await mount(bot(messages));
    expect(host.querySelector('[data-mid="reply 0"]')).toBeNull();
    expect(chips(host)).toHaveLength(0);
    const earlier = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.startsWith("Show earlier messages"));
    expect(earlier).toBeTruthy();
    await act(async () => { earlier?.click(); });
    expect(chips(host)).toHaveLength(1);
    expect(chips(host)[0].closest("[data-mid]")?.getAttribute("data-mid")).toBe("reply 0");
  });
});
