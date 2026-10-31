import { describe, expect, it } from "vitest";

import { offscreenLimit } from "./chat-tail.ts";
import type { Message } from "./store.ts";

const reply = (i: number): Message => ({ id: `m${i}`, at: i, role: "bot", kind: "text", text: "ok" });
const prompt = (i: number): Message => ({ id: `m${i}`, at: i, role: "user", kind: "text", text: "go" });
const thread = (length: number, promptAt?: number) =>
  Array.from({ length }, (_, i) => (i === promptAt ? prompt(i) : reply(i)));
const read = {};

describe("offscreen chat tail", () => {
  it("keeps a short tail for a chat with recent prompts", () => {
    expect(offscreenLimit(thread(300, 290), 200, read)).toBe(30);
  });

  it("reaches back to the last prompt", () => {
    expect(offscreenLimit(thread(300, 220), 200, read)).toBe(80);
  });

  it("skips posts from other bots", () => {
    const messages = thread(300, 220);
    messages[290] = { ...prompt(290), from: { botId: "b2", name: "Pip", color: "blue" } };
    expect(offscreenLimit(messages, 200, read)).toBe(80);
  });

  it("reaches back to an open question with no prompt after it", () => {
    const messages = thread(300);
    messages[150] = { ...reply(150), kind: "options", card: { askUser: true } as Message["card"] };
    expect(offscreenLimit(messages, 200, read)).toBe(150);
  });

  it("reaches back to an open request and the oldest worker launch", () => {
    const messages = thread(300, 290);
    messages[200] = { ...reply(200), kind: "options", card: { requestId: "r1" } as Message["card"] };
    expect(offscreenLimit(messages, 200, read)).toBe(100);
    messages[120] = { ...reply(120), kind: "launch" };
    expect(offscreenLimit(messages, 200, read)).toBe(180);
  });

  it("keeps every unread reply", () => {
    expect(offscreenLimit(thread(300, 290), 200, { unread: true, readAt: 239 })).toBe(60);
    expect(offscreenLimit(thread(300, 290), 200, { unread: true, readAt: 10 })).toBe(200);
    expect(offscreenLimit(thread(300, 220), 200, { unread: true })).toBe(80);
  });

  it("reaches back to the newest previewable row", () => {
    const messages = thread(300, 280).map((message, i) => (i > 240 ? { ...message, role: "bot" as const, kind: "activity" as const } : message));
    expect(offscreenLimit(messages, 200, read)).toBe(60);
  });

  it("reaches back to every note in range", () => {
    const messages = thread(300, 290);
    messages[150] = { ...reply(150), kind: "note" };
    expect(offscreenLimit(messages, 200, read)).toBe(150);
  });

  it("keeps the full page when an older branch is active", () => {
    expect(offscreenLimit(thread(300, 290), 200, read, "m250")).toBe(200);
    expect(offscreenLimit(thread(300, 290), 200, read, "m299")).toBe(30);
  });

  it("keeps the full page when the active path skips an older branch", () => {
    const messages = thread(300, 290).map((message, i) => (i > 0 ? { ...message, parentId: `m${i - 1}` } : message));
    messages[299] = { ...messages[299]!, parentId: "m150" };
    expect(offscreenLimit(messages, 200, read, "m299")).toBe(200);
  });

  it("reaches past a compaction row to the newest previewable reply", () => {
    const messages = thread(300, 280);
    messages[260] = { ...reply(260), kind: "compaction", text: undefined };
    for (let i = 261; i < 300; i++) messages[i] = { ...reply(i), kind: "activity" };
    expect(offscreenLimit(messages, 200, read)).toBe(41);
  });
});
