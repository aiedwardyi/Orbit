import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { roomRetry } from "./room-retry";

const msg = (m: Partial<Message>): Message => ({ id: "m1", role: "bot", kind: "text", at: 1, ...m });

const members = [
  { id: "b1", name: "Alice" },
  { id: "b2", name: "Bob" },
];

const singleMember = [{ id: "b1", name: "Alice" }];
const leadGroup = { defaultResponder: { kind: "member" as const, botId: "b1" } };
const everyoneGroup = { defaultResponder: { kind: "everyone" as const } };
const mentionsGroup = { defaultResponder: { kind: "mentions" as const } };

describe("roomRetry", () => {
  it("the last message is an error activity: returns its id and the last user message's text", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "translate this", replyToId: "r0", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: network error", ok: false },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, singleMember, leadGroup, "thread-1")).toEqual({
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
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
      msg({ id: "u2", role: "user", kind: "text", text: "nevermind", at: 3 }),
    ];
    expect(roomRetry(messages, singleMember, leadGroup, "thread-1")).toBeNull();
  });

  it("a member is busy: null", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "translate this", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: network error", ok: false },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, singleMember, leadGroup, "thread-1", "bot-worker")).toBeNull();
  });

  it("a setup error: null", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "translate this", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: claude cli missing", ok: false, setup: true },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, singleMember, leadGroup, "thread-1")).toBeNull();
  });

  it("a usage-limit error: returns its id", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "translate this", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: monthly quota exhausted", ok: false, usageLimit: { resetsAt: 1800000000 } },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, singleMember, leadGroup, "thread-1")).toEqual({
      messageId: "a1",
      text: "translate this",
      replyToId: undefined,
      threadId: "thread-1",
    });
  });

  it("no earlier user message with text: null", () => {
    const noUserMessages: Message[] = [
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: network error", ok: false },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 1,
      }),
    ];
    expect(roomRetry(noUserMessages, singleMember, leadGroup, "thread-1")).toBeNull();

    const emptyTextUserMessages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "   ", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: network error", ok: false },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
    ];
    expect(roomRetry(emptyTextUserMessages, singleMember, leadGroup, "thread-1")).toBeNull();
  });

  it("@everyone text with two members -> null", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "@everyone check this", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: failed", ok: false },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, members, mentionsGroup, "thread-1")).toBeNull();
  });

  it("two @mentions -> null", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "@Alice and @Bob help", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: failed", ok: false },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, members, mentionsGroup, "thread-1")).toBeNull();
  });

  it("a room whose default is everyone, no mention -> null", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "hello everyone", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: failed", ok: false },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, members, everyoneGroup, "thread-1")).toBeNull();
  });

  it("the default responder is the failed member -> payload", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "hello alice", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: failed", ok: false },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, members, leadGroup, "thread-1")).toEqual({
      messageId: "a1",
      text: "hello alice",
      replyToId: undefined,
      threadId: "thread-1",
    });
  });

  it("the sole responder is a different member than the failed one -> null", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "@Bob help", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: failed", ok: false },
        from: { botId: "b1", name: "Alice", color: "blue" as any },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, members, mentionsGroup, "thread-1")).toBeNull();
  });

  it("failed activity without from.botId -> null", () => {
    const messages: Message[] = [
      msg({ id: "u1", role: "user", kind: "text", text: "hello alice", at: 1 }),
      msg({
        id: "a1",
        role: "bot",
        kind: "activity",
        tool: { name: "error: failed", ok: false },
        at: 2,
      }),
    ];
    expect(roomRetry(messages, members, leadGroup, "thread-1")).toBeNull();
  });
});
