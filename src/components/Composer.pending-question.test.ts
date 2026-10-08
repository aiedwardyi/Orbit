// @vitest-environment happy-dom
// The pinned ask_user question over the composer, against the real store:
// a tap goes out exactly the way a typed answer would, and the x settles it.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Group, type Message } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

const question: Message = {
  id: "ask-1",
  role: "bot",
  kind: "options",
  at: 2,
  card: {
    title: "Your bot has a question",
    subtitle: "Ship to prod or staging?\nStaging has last week's data.",
    options: ["Prod", "Staging"],
    askUser: true,
  },
};
const approval: Message = {
  id: "approval-1",
  role: "bot",
  kind: "options",
  at: 3,
  card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" },
};

const bot = (messages: Message[]): Bot => ({
  id: "asker", threadId: "asker-thread", name: "Ada", title: "", description: "",
  notifications: false, color: "blue", unread: false, messages, busy: true, activity: "working",
  modelSelection: { instanceId: "claude", model: "claude" },
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
const calls: Array<{ method: string; path: string; body: unknown }> = [];

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  calls.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Loads the chat into the store the way the app does, then mounts its composer. */
async function mount(props: Parameters<typeof Composer>[0]) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === "/api/bots?messages=200") {
      return new Response(JSON.stringify({ bots: [props.bot, ...(props.members ?? [])].filter(Boolean), groups: [props.group].filter(Boolean) }));
    }
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(StoreProvider, null, createElement(Composer, props))));
  await act(async () => FakeEventSource.current!.onmessage?.({
    data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
    lastEventId: "",
  }));
}

const pin = () => host!.querySelector("[data-pending-question]");
const textarea = () => host!.querySelector("textarea");
const pinButton = (name: string) => {
  const found = [...(pin()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === name || button.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`no ${name} button in the pin`);
  return found;
};
const sent = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path);

describe("pinned ask_user question", () => {
  it("shows who asks, the full question and its choices, and keeps the composer enabled", async () => {
    await mount({ bot: bot([question]) });
    expect(pin()?.getAttribute("aria-label")).toBe("Ada asks");
    expect(pin()?.textContent).toContain("Ship to prod or staging?\nStaging has last week's data.");
    expect(pinButton("Prod")).toBeTruthy();
    expect(pinButton("Staging")).toBeTruthy();
    expect(textarea()?.disabled).toBe(false);
  });

  it("sends a tapped choice as the answer and persists answered, not dismissed", async () => {
    await mount({ bot: bot([question]) });
    await act(async () => pinButton("Prod").click());
    expect(sent("PATCH", "/api/bots/asker/cards/ask-1").map((call) => call.body)).toEqual([{ answered: "Prod" }]);
    expect(sent("POST", "/api/bots/asker/messages").map((call) => call.body)).toEqual([{ text: "Prod" }]);
  });

  it("dismisses with the x", async () => {
    await mount({ bot: bot([question]) });
    await act(async () => pinButton("Dismiss question").click());
    expect(sent("PATCH", "/api/bots/asker/cards/ask-1").map((call) => call.body)).toEqual([{ dismissed: true }]);
    expect(sent("POST", "/api/bots/asker/messages")).toEqual([]);
  });

  it("leaves once the person has sent a later message", async () => {
    await mount({ bot: bot([question, { id: "u1", role: "user", kind: "text", at: 4, text: "Staging" }]) });
    expect(pin()).toBeNull();
  });

  it("waits behind a pending approval, which keeps its composer takeover", async () => {
    await mount({ bot: bot([question, approval]) });
    expect(pin()).toBeNull();
    expect(host!.querySelector('[role="region"][aria-label="Pending approval"]')).not.toBeNull();
    expect(textarea()?.disabled).toBe(true);
  });

  it("names the room member who asked and answers in the room", async () => {
    const member = bot([]);
    const group: Group = {
      id: "room", threadId: "room-thread", name: "War room", memberIds: [member.id], bulletin: "",
      defaultResponder: { kind: "everyone" }, unread: false, createdAt: 1,
      messages: [{ ...question, from: { botId: member.id, name: member.name, color: member.color } }],
    };
    await mount({ group, members: [member] });
    expect(pin()?.getAttribute("aria-label")).toBe("Ada asks");
    await act(async () => pinButton("Staging").click());
    expect(sent("PATCH", "/api/groups/room/cards/ask-1").map((call) => call.body)).toEqual([{ answered: "Staging" }]);
    expect(sent("POST", "/api/groups/room/messages").map((call) => call.body)).toEqual([
      expect.objectContaining({ text: "Staging", sendId: expect.any(String) }),
    ]);
  });
});
