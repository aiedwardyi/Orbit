// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Message } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import { applySkin } from "@/lib/skins";

import { ChatView, stampedReplyComm } from "./ChatView";

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

  it("labels a stamped reply past a user row between ask and answer", async () => {
    const stamped = { ...text("first reply"), comm: { ...comm } };
    expect(stampedReplyComm(stamped)).toEqual(comm);
    const { host } = await mount(bot([inbound, text("Edward's question", "user"), stamped, text("second reply")]));
    expect(chips(host)).toHaveLength(1);
    expect(label(chips(host)[0])).toBe("Reply to @Atlas");
    expect(chips(host)[0].closest("[data-mid]")?.getAttribute("data-mid")).toBe("first reply");
    expect(host.querySelector('[data-mid="second reply"]')?.textContent).not.toContain("Reply to @");
  });

  it("labels an unstamped reply by inference and leaves the stamp path empty", async () => {
    const reply = text("first reply");
    expect(stampedReplyComm(reply)).toBeUndefined();
    const { host } = await mount(bot([inbound, reply]));
    expect(chips(host)).toHaveLength(1);
    expect(chips(host)[0].closest("[data-mid]")?.getAttribute("data-mid")).toBe("first reply");
  });

  it("gives a stamped reply with a matching ask exactly one chip", async () => {
    const stamped = { ...text("first reply"), comm: { ...comm } };
    expect(stampedReplyComm(stamped)).toEqual(comm);
    const { host } = await mount(bot([inbound, stamped, text("second reply")]));
    expect(chips(host)).toHaveLength(1);
    expect(chips(host)[0].closest("[data-mid]")?.getAttribute("data-mid")).toBe("first reply");
    expect(host.querySelector('[data-mid="second reply"]')?.textContent).not.toContain("Reply to @");
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

describe("ChatView asker-side peer rows", () => {
  const sent: Message = { id: "sent", at: 1, role: "bot", kind: "activity", tool: { name: "Message to @Atlas" }, comm: { ...comm, peer: "message" }, text: "Check the release." };
  const reply: Message = { id: "reply", at: 2, role: "bot", kind: "activity", tool: { name: "Reply from @Atlas" }, comm: { ...comm, peer: "reply" }, text: "Release is green." };
  const rowLabel = (host: HTMLElement, id: string) => host.querySelector(`[data-mid="${id}"] button span.truncate`)?.textContent;
  const body = (host: HTMLElement, id: string) => host.querySelector(`[data-mid="${id}"] [data-peer-body]`);

  it("shows the sent message, then the reply, then the bot's own take, and an older chip as today", async () => {
    const old: Message = { id: "old", at: 1, role: "bot", kind: "activity", tool: { name: "@Atlas replied" }, comm };
    const { host } = await mount(bot([old, sent, reply, text("My take")]));
    const ids = Array.from(host.querySelectorAll("[data-mid]")).map((row) => row.getAttribute("data-mid"));
    expect(ids).toEqual(["old", "sent", "reply", "My take"]);
    expect(rowLabel(host, "old")).toBe("@Atlas replied");
    expect(body(host, "old")).toBeNull();
    expect(host.querySelector('[data-mid="old"]')?.lastElementChild?.className).toBe("flex justify-start");
    expect(rowLabel(host, "sent")).toBe("Message to @Atlas");
    expect(rowLabel(host, "reply")).toBe("Reply from @Atlas");
    expect(body(host, "sent")?.textContent).toBe("Check the release.");
    expect(body(host, "reply")?.textContent).toBe("Release is green.");
    expect(chips(host)).toHaveLength(0);
    for (const id of ["sent", "reply"]) {
      selected = "";
      await act(async () => { host.querySelector<HTMLButtonElement>(`[data-mid="${id}"] button`)?.click(); });
      expect(selected).toBe("pair");
    }
  });

  it("folds a long body like a long message", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `step ${i}`).join("\n");
    const { host } = await mount(bot([sent, { ...reply, text: long }]));
    const fold = () => body(host, "reply")?.firstElementChild?.className ?? "";
    const toggle = () => body(host, "reply")?.querySelector("button");
    expect(body(host, "sent")?.querySelector("button")).toBeNull();
    expect(fold()).toContain("max-h-40");
    expect(toggle()?.textContent).toBe("Show full message");
    await act(async () => { toggle()?.click(); });
    expect(fold()).not.toContain("max-h-40");
    expect(toggle()?.textContent).toBe("Show less");
    await act(async () => { toggle()?.click(); });
    expect(fold()).toContain("max-h-40");
  });

  it("keeps a handoff chip's status label over its message", async () => {
    const { host } = await mount(bot([{ ...sent, tool: { name: "Delivered to @Atlas" }, comm }]));
    expect(rowLabel(host, "sent")).toBe("Delivered to @Atlas");
    expect(body(host, "sent")?.textContent).toBe("Check the release.");
  });

  it("translates both labels into Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    const { host } = await mount(bot([sent, reply]));
    expect(rowLabel(host, "sent")).toBe("@Atlas에게 보낸 메시지");
    expect(rowLabel(host, "reply")).toBe("@Atlas의 답장");
  });

  it("translates the fold labels of a long peer message into Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    const long = Array.from({ length: 12 }, (_, i) => `step ${i}`).join("\n");
    const { host } = await mount(bot([{ ...reply, text: long }]));
    const toggle = () => body(host, "reply")?.querySelector("button");
    expect(toggle()?.textContent).toBe("전체 메시지 보기");
    await act(async () => { toggle()?.click(); });
    expect(toggle()?.textContent).toBe("접기");
  });
});

describe("ChatView target-side peer chips", () => {
  const received: Message = { id: "received", at: 1, role: "bot", kind: "activity", tool: { name: "Message from @Atlas" }, comm: { ...comm, peer: "from" } };
  const old: Message = { ...received, id: "old", comm };
  const rowLabel = (host: HTMLElement, id: string) => host.querySelector(`[data-mid="${id}"] button span.truncate`)?.textContent;

  it("shows the English label as before", async () => {
    const { host } = await mount(bot([received, old]));
    expect(rowLabel(host, "received")).toBe("Message from @Atlas");
    expect(rowLabel(host, "old")).toBe("Message from @Atlas");
  });

  it("shows the bot's reply once, in its bubble, under the Reply to chip", async () => {
    const { host } = await mount(bot([received, inbound, text("first reply")]));
    expect(host.textContent?.split("first reply")).toHaveLength(2);
    expect(host.querySelector('[data-mid="first reply"] [data-peer-body]')).toBeNull();
    expect(rowLabel(host, "first reply")).toBe("Reply to @Atlas");
  });

  it("shows the peer's message on the left like the asker side, with no edit control", async () => {
    const { host } = await mount(bot([received, inbound]));
    const row = host.querySelector<HTMLElement>('[data-mid="inbound"] [data-orbit-message]');
    expect(row?.className).not.toMatch(/items-end|animate-msg-in/);
    expect(row?.getAttribute("data-orbit-message")).toBe("peer");
    expect(row?.querySelector("[data-peer-body]")?.textContent).toBe("Check the release.");
    expect(row?.querySelector(".bg-bubble-user, [data-message-hover-actions], [aria-label='Edit message']")).toBeNull();
    await act(async () => { row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })); });
    expect(document.querySelector("[data-message-menu]")?.textContent).toContain("Copy");
  });

  it("keeps the local user's own message on the right with its edit control", async () => {
    const { host } = await mount(bot([received, inbound, text("my question", "user")]));
    const row = host.querySelector('[data-mid="my question"] [data-orbit-message]');
    expect(row?.getAttribute("data-orbit-message")).toBe("user");
    expect(row?.className).toContain("items-end");
    expect(row?.querySelector("[aria-label='Edit message']")).not.toBeNull();
  });

  it("gives a peer message the bot menu with reactions and pin", async () => {
    const { host } = await mount(bot([received, inbound]));
    const row = host.querySelector('[data-mid="inbound"] [data-orbit-message]')!;
    await act(async () => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })); });
    const menu = document.querySelector("[data-message-menu]");
    expect(menu?.querySelectorAll("[data-menu-reaction]")).toHaveLength(6);
    expect(menu?.querySelector("[data-menu-pin]")?.textContent).toBe("Pin message");
  });

  it("makes the peer body selectable after the touch menu's Select text", async () => {
    const { host } = await mount(bot([received, inbound]));
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" }));
    const row = host.querySelector('[data-mid="inbound"] [data-orbit-message]')!;
    const body = row.querySelector("[data-peer-body]")!;
    const hold = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(hold, "touches", { value: [{ clientX: 10, clientY: 10 }] });
    await act(async () => { body.dispatchEvent(hold); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 520)); });
    await act(async () => { body.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>("[data-menu-select]")!.click(); });
    expect(row.hasAttribute("data-select-mode")).toBe(true);
    expect(body.closest("[data-orbit-message-content]")).not.toBeNull();
    expect(window.getSelection()?.toString()).toBe(inbound.text);
    await act(async () => { document.body.dispatchEvent(new Event("touchstart", { bubbles: true })); });
  });

  it("makes a short peer message keyboard reachable for copy, reply and pin", async () => {
    const { host } = await mount(bot([received, inbound]));
    const row = host.querySelector<HTMLElement>('[data-mid="inbound"] [data-orbit-message]')!;
    expect(row.tabIndex).toBe(0);
    row.focus();
    for (const key of [{ key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
      await act(async () => { row.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...key })); });
      const menu = document.querySelector("[data-message-menu]");
      for (const action of ["copy", "reply", "pin"]) expect(menu?.querySelector(`[data-menu-${action}]`)).not.toBeNull();
      expect(document.activeElement).toBe(menu?.querySelector("button"));
      await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })); });
      expect(document.activeElement).toBe(row);
    }
  });

  it("renders stored bot reactions on a peer message", async () => {
    const { host } = await mount(bot([received, { ...inbound, reactions: [{ emoji: "👍", by: "helper" }] }]));
    const reaction = host.querySelector('[data-mid="inbound"] [data-message-reactions] button');
    expect(reaction?.textContent).toBe("👍");
    expect(reaction?.getAttribute("title")).toBe("Helper");
  });

  it("renders peer image and file attachments without exposing their markup", async () => {
    const attached = { ...inbound, text: 'Check the release.\n<attached-image path="/uploads/12345678-1234-1234-1234-123456789abc.png" />\n<attached-file path="/uploads/release.pdf" name="release.pdf" size="1024" />' };
    const { host } = await mount(bot([received, attached]));
    const row = host.querySelector('[data-mid="inbound"] [data-orbit-message]')!;
    expect(row.querySelector("img")).not.toBeNull();
    expect(row.querySelector("[data-file-row]")?.textContent).toContain("release.pdf");
    expect(row.querySelector("[data-peer-body]")?.textContent).toBe("Check the release.");
    expect(row.textContent).not.toMatch(/<attached-(image|file)/);
  });

  it.each([["en", "Open the conversation with Atlas"], ["ko", "Atlas 대화 열기"]])("titles the chip in %s", async (locale, title) => {
    localStorage.setItem("omb-locale", locale);
    const { host } = await mount(bot([received]));
    expect(host.querySelector('[data-mid="received"] button')?.getAttribute("title")).toBe(title);
  });

  it("translates a marked chip and an old one into Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    const { host } = await mount(bot([received, old]));
    expect(rowLabel(host, "received")).toBe("@Atlas에게서 온 메시지");
    expect(rowLabel(host, "old")).toBe("@Atlas에게서 온 메시지");
  });
});

describe("ChatView handoff status lines", () => {
  const rowLabel = (host: HTMLElement, id: string) => host.querySelector(`[data-mid="${id}"] button span.truncate`)?.textContent;
  const delivered: Message = { id: "delivered", at: 1, role: "bot", kind: "activity", tool: { name: "Delivered to @Atlas" }, comm };
  const failed: Message = { id: "failed", at: 2, role: "bot", kind: "activity", tool: { name: "error: delegation failed \u2014 Atlas is offline", ok: false } };
  const steered: Message = { id: "steered", at: 3, role: "user", kind: "text", text: "Use the staging key.", steered: true };
  const midTitle = (host: HTMLElement, label: string) =>
    Array.from(host.querySelectorAll('[data-mid="steered"] [title]')).find((el) => el.textContent === label)?.getAttribute("title");

  it("shows the server lines and the mid-turn note as written in English", async () => {
    const { host } = await mount(bot([delivered, failed, steered]));
    expect(rowLabel(host, "delivered")).toBe("Delivered to @Atlas");
    expect(host.querySelector('[data-mid="failed"]')?.textContent).toBe("delegation failed \u2014 Atlas is offline");
    expect(host.querySelector('[data-mid="steered"]')?.textContent).toContain("sent mid-turn");
    expect(midTitle(host, "sent mid-turn")).toBe("Sent while the bot was working \u2014 it saw this before its next step, inside the same turn.");
  });

  it("shows the chip, the error row and the mid-turn note in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    const { host } = await mount(bot([delivered, failed, steered]));
    expect(rowLabel(host, "delivered")).toBe("@Atlas에게 전달됨");
    expect(host.querySelector('[data-mid="failed"]')?.textContent).toBe("위임 실패 - Atlas is offline");
    expect(host.querySelector('[data-mid="steered"]')?.textContent).toContain("작업 중에 전송됨");
    expect(midTitle(host, "작업 중에 전송됨")).toBe("봇이 작업하는 동안 보냄 - 같은 턴 안에서 다음 단계 전에 이 메시지를 확인했습니다.");
  });

  it("translates a non-chip line inside a Terminal skin run", async () => {
    localStorage.setItem("omb-locale", "ko");
    applySkin("terminal");
    const denied: Message = { id: "denied", at: 1, role: "bot", kind: "activity", tool: { name: "Delegation to @Atlas denied by user", ok: false } };
    const { host } = await mount(bot([denied, { ...denied, id: "denied2", at: 2 }]));
    expect(host.textContent).toContain("@Atlas에게 한 위임을 사용자가 거부했습니다");
    expect(host.textContent).not.toContain("denied by user");
  });
});

describe("ChatView long user message fold", () => {
  const long: Message = { id: "long", at: 1, role: "user", kind: "text", text: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") };
  const toggle = (host: HTMLElement) => Array.from(host.querySelectorAll("button")).find((button) => /message|Show less|메시지 보기|접기/.test(button.textContent ?? "") && button.closest('[data-mid="long"]'));

  it.each([["en", "Show full message", "Show less"], ["ko", "전체 메시지 보기", "접기"]])("labels the fold in %s", async (locale, open, close) => {
    localStorage.setItem("omb-locale", locale);
    const { host } = await mount(bot([long]));
    expect(toggle(host)?.textContent).toBe(open);
    await act(async () => { toggle(host)?.click(); });
    expect(toggle(host)?.textContent).toBe(close);
  });
});
