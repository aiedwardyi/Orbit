import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import {
  acceptedSendPaint,
  composerIsBusy,
  dropIdleAcceptedThinking,
  forgetAcceptedSend,
  receiptRejectsAcceptedSend,
  rememberAcceptedSend,
  settleAcceptedSend,
  shouldDropQueueChip,
  turnPresenceWaiting,
  visibleSteerEntries,
} from "./send-accept";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "../components/ChatView.tsx"), "utf8");
const groupView = readFileSync(join(here, "../components/GroupView.tsx"), "utf8");
const composer = readFileSync(join(here, "../components/Composer.tsx"), "utf8");

const settledReply: Message = { id: "a1", role: "bot", kind: "text", text: "done", at: 1 };

describe("acceptedSendPaint", () => {
  it("starts Thinking on an idle send and Sends-next on a busy follow-up", () => {
    expect(acceptedSendPaint({ alreadyBusy: false })).toEqual({ kind: "thinking" });
    expect(acceptedSendPaint({ alreadyBusy: true })).toEqual({ kind: "sends-next" });
  });
});

describe("turnPresenceWaiting", () => {
  it("shows Thinking in the same tick as an accepted idle send, even under a settled reply", () => {
    expect(
      turnPresenceWaiting({
        busy: false,
        lastMessage: settledReply,
        accepted: [{ sendId: "s1", kind: "thinking", text: "next" }],
      }),
    ).toBe(true);
  });

  it("keeps end-of-stream jitter hidden when nothing new was accepted", () => {
    expect(turnPresenceWaiting({ busy: true, lastMessage: settledReply })).toBe(false);
  });

  it("does not paint Thinking for a queued follow-up", () => {
    expect(
      turnPresenceWaiting({
        busy: true,
        lastMessage: settledReply,
        accepted: [{ sendId: "s2", kind: "sends-next", text: "later" }],
      }),
    ).toBe(false);
  });
});

describe("composerIsBusy", () => {
  it("treats an accepted start-turn as busy before the server echoes it", () => {
    expect(composerIsBusy(false, [{ sendId: "s1", kind: "thinking", text: "hi" }])).toBe(true);
    expect(composerIsBusy(false, [{ sendId: "s2", kind: "sends-next", text: "later" }])).toBe(false);
    expect(composerIsBusy(true, [])).toBe(true);
  });
});

describe("accepted send bookkeeping", () => {
  it("remembers and forgets by sendId without clobbering another thread", () => {
    const first = rememberAcceptedSend({}, "t1", { sendId: "s1", kind: "thinking", text: "hi" });
    const both = rememberAcceptedSend(first, "t2", { sendId: "s2", kind: "sends-next", text: "later" });
    expect(forgetAcceptedSend(both, "t1", "s1")).toEqual({
      t2: [{ sendId: "s2", kind: "sends-next", text: "later" }],
    });
  });

  it("drops Thinking on an idle snapshot thread and keeps Sends-next", () => {
    const accepted = rememberAcceptedSend(
      rememberAcceptedSend({}, "t1", { sendId: "think", kind: "thinking", text: "hi" }),
      "t1",
      { sendId: "queue", kind: "sends-next", text: "later" },
    );
    expect(dropIdleAcceptedThinking(accepted, [{ threadId: "t1", busy: false }]).t1).toEqual([
      { sendId: "queue", kind: "sends-next", text: "later" },
    ]);
    expect(dropIdleAcceptedThinking(accepted, [{ threadId: "t1", busy: true }])).toBe(accepted);
  });

  it("rejects an accepted send when the POST receipt says dispatch failed", () => {
    expect(receiptRejectsAcceptedSend({ dispatchFailed: true })).toBe(true);
    expect(receiptRejectsAcceptedSend({ dispatchFailed: true, queued: true })).toBe(true);
    expect(receiptRejectsAcceptedSend({ cancelled: true })).toBe(true);
    expect(receiptRejectsAcceptedSend({ ok: true })).toBe(false);
    expect(receiptRejectsAcceptedSend({ queued: true, queueId: "q1" })).toBe(false);
    expect(receiptRejectsAcceptedSend(null)).toBe(false);
  });

  it("lets POST settle only a Sends-next chip, not Thinking", () => {
    const accepted = rememberAcceptedSend(
      rememberAcceptedSend({}, "t1", { sendId: "think", kind: "thinking", text: "hi" }),
      "t1",
      { sendId: "queue", kind: "sends-next", text: "later" },
    );
    const settled = settleAcceptedSend(accepted, "t1", "think");
    expect(settled.t1?.map((entry) => entry.sendId)).toEqual(["think", "queue"]);
    expect(settleAcceptedSend(settled, "t1", "queue").t1).toEqual([
      { sendId: "think", kind: "thinking", text: "hi" },
    ]);
  });
});

describe("visibleSteerEntries", () => {
  it("surfaces an accepted follow-up as Sends-next before the POST queueId arrives", () => {
    expect(
      visibleSteerEntries(
        { t1: [{ queueId: "q1", text: "confirmed" }] },
        "t1",
        [{ sendId: "s-new", kind: "sends-next", text: "soon" }],
      ),
    ).toEqual([
      { queueId: "q1", text: "confirmed" },
      { queueId: "s-new", text: "soon" },
    ]);
  });

  it("does not duplicate a follow-up whose sendId already landed as a queueId", () => {
    expect(
      visibleSteerEntries(
        { t1: [{ queueId: "s-new", text: "soon" }] },
        "t1",
        [{ sendId: "s-new", kind: "sends-next", text: "soon" }],
      ),
    ).toEqual([{ queueId: "s-new", text: "soon" }]);
  });
});

describe("queue cancel chrome", () => {
  it("does not drop a chip while the server says that send is already running", () => {
    expect(shouldDropQueueChip({ cancelled: false, running: true })).toBe(false);
    expect(shouldDropQueueChip({ cancelled: true })).toBe(true);
    expect(shouldDropQueueChip({ cancelled: false, running: false })).toBe(false);
  });
});

describe("send-accept wiring", () => {
  it("paints Thinking and Sends-next from accepted-send helpers, not POST wait", () => {
    expect(chatView).toContain("turnPresenceWaiting");
    expect(groupView).toContain("turnPresenceWaiting");
    expect(composer).toContain("composerIsBusy");
    expect(composer).toContain("visibleSteerEntries");
  });

  it("clears optimistic Thinking from a dispatch-failed receipt, not hydrate", () => {
    const store = readFileSync(join(here, "../state/store.tsx"), "utf8");
    expect(store).toContain("receiptRejectsAcceptedSend");
    expect(store).toContain("shouldDropQueueChip");
  });
});
