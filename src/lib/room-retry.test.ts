import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { roomRetry } from "./room-retry";

const msg = (m: Partial<Message>): Message => ({ id: "m1", role: "bot", kind: "text", at: 1, ...m });

describe("roomRetry", () => {
  it("the last message is an error activity: returns its id and the last user message's text", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "translate this", replyToId: "r0", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: network error", ok: false },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, undefined, "thread-1")).toEqual({
      messageId: "a1",
      text: "translate this",
      replyToId: "r0",
      threadId: "thread-1",
    });
  });

  it("a later message follows the error: null", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "translate this", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: network error", ok: false },
        at: 2,
      }),
      msg({ id: "u2", role: "user", kind: "text", text: "nevermind", at: 3 }),
    ];
    expect(roomRetry(messages, undefined)).toBeNull();
  });

  it("a member is busy: null", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "translate this", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: network error", ok: false },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, "bot-worker")).toBeNull();
  });

  it("a setup error: null", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "translate this", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: claude cli missing", ok: false, setup: true },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, undefined)).toBeNull();
  });

  it("a usage-limit error: returns its id", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "translate this", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: monthly quota exhausted", ok: false, usageLimit: { resetsAt: 1800000000 } },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, undefined)).toEqual({
      messageId: "a1",
      text: "translate this",
      replyToId: undefined,
      threadId: undefined,
    });
  });

  it("no earlier user message with text: null", () => {
    const noUserMessages: Message[] = [
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: network error", ok: false },
        at: 1,
      }),
    ];
    expect(roomRetry(noUserMessages, undefined)).toBeNull();

    const emptyTextUserMessages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "   ", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: network error", ok: false },
        at: 2,
      }),
    ];
    expect(roomRetry(emptyTextUserMessages, undefined)).toBeNull();
  });
});
