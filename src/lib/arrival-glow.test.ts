// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARRIVAL_GLOW_THROTTLE_MS,
  arrivalChatForFrame,
  arrivalNonce,
  noteArrival,
  resetArrivalGlow,
  subscribeArrival,
  type ArrivalFrame,
} from "./arrival-glow";

afterEach(() => {
  resetArrivalGlow();
  vi.restoreAllMocks();
});

const chats = (selectedId = "open") => ({
  hydrated: true,
  selectedId,
  bots: [
    { id: "open", threadId: "open-thread" },
    { id: "closed", threadId: "closed-thread" },
    { id: "archived", threadId: "archived-thread", hidden: true },
  ],
  groups: [{ id: "room", threadId: "room-thread" }],
});

const frame = (threadId: string, message: ArrivalFrame["message"]) => ({ threadId, message });

describe("noteArrival", () => {
  it("throttles one chat to a glow per 10 s", () => {
    expect(noteArrival("a", 1_000)).toBe(true);
    expect(noteArrival("a", 1_000 + ARRIVAL_GLOW_THROTTLE_MS - 1)).toBe(false);
    expect(noteArrival("a", 1_000 + ARRIVAL_GLOW_THROTTLE_MS)).toBe(true);
  });

  it("throttles chats independently", () => {
    expect(noteArrival("a", 1_000)).toBe(true);
    expect(noteArrival("b", 1_000)).toBe(true);
    expect(noteArrival("a", 2_000)).toBe(false);
    expect(noteArrival("b", 2_000)).toBe(false);
  });

  it("bumps only the arriving chat's nonce", () => {
    noteArrival("a", 1_000);
    expect(arrivalNonce("a")).toBe(1);
    expect(arrivalNonce("b")).toBe(0);
    noteArrival("b", 1_000);
    expect(arrivalNonce("a")).toBe(1);
    expect(arrivalNonce("b")).toBe(2);
  });

  it("notifies only the arriving chat's subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeArrival("a", a);
    subscribeArrival("b", b);
    noteArrival("b", 1_000);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    expect(noteArrival("a", 20_000)).toBe(true);
    expect(a).not.toHaveBeenCalled();
  });

  it("keeps a later subscriber when a stale unsubscribe runs again", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeArrival("a", a);
    offA();
    subscribeArrival("a", b);
    offA();
    noteArrival("a", 1_000);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("arrivalChatForFrame", () => {
  const liveBotText = { role: "bot", kind: "text", text: "hello", at: 5 };

  it("glows a closed chat's live bot reply", () => {
    expect(arrivalChatForFrame(frame("closed-thread", liveBotText), chats())).toBe("closed");
  });

  it("glows a room reply", () => {
    expect(arrivalChatForFrame(frame("room-thread", liveBotText), chats())).toBe("room");
  });

  it("stays quiet before hydration", () => {
    expect(arrivalChatForFrame(frame("closed-thread", liveBotText), { ...chats(), hydrated: false })).toBeNull();
  });

  it("stays quiet on replayed, imported, and unowned frames", () => {
    expect(arrivalChatForFrame({ ...frame("closed-thread", liveBotText), replayed: true }, chats())).toBeNull();
    expect(arrivalChatForFrame({ ...frame("closed-thread", liveBotText), imported: true }, chats())).toBeNull();
    expect(arrivalChatForFrame(frame("nope-thread", liveBotText), chats())).toBeNull();
    expect(arrivalChatForFrame({ message: liveBotText }, chats())).toBeNull();
    expect(arrivalChatForFrame(frame("closed-thread", null), chats())).toBeNull();
  });

  it("stays quiet for the open chat and hidden bots", () => {
    expect(arrivalChatForFrame(frame("open-thread", liveBotText), chats())).toBeNull();
    expect(arrivalChatForFrame(frame("archived-thread", liveBotText), chats())).toBeNull();
    expect(arrivalChatForFrame(frame("room-thread", liveBotText), chats("room"))).toBeNull();
  });

  it("stays quiet for own sends, tool rows, cards, and summaries", () => {
    const kinds = [
      { role: "user", kind: "text", text: "hi", at: 5 },
      { role: "bot", kind: "activity", tool: { name: "Bash", ok: true }, at: 5 },
      { role: "bot", kind: "options", card: { askUser: true }, at: 5 },
      { role: "bot", kind: "screen", at: 5 },
      { role: "bot", kind: "text", summarized: true, at: 5 },
    ];
    for (const message of kinds) {
      expect(arrivalChatForFrame(frame("closed-thread", message), chats()), JSON.stringify(message)).toBeNull();
    }
  });
});
