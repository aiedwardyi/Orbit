import { describe, expect, it } from "vitest";

import type { Notification } from "./notify.ts";
import { createPingLimiter, pingForMailbox, pingForNotification } from "./phone-ping.ts";

const frame = (kind: Notification["kind"]): Notification => ({
  kind,
  botId: "bot-1",
  botName: "Scout",
  threadId: "thread-1",
  title: `Scout ${kind}`,
  body: "detail",
});

describe("pingForNotification", () => {
  it("always pings when a bot is blocked on you", () => {
    for (const kind of ["approval", "question", "takeover"] as const) {
      expect(pingForNotification(frame(kind))).toEqual({ title: `Scout ${kind}`, message: "detail", priority: 4 });
    }
    expect(pingForNotification(frame("routine-failed"))).toEqual({ title: "Scout routine-failed", message: "detail" });
  });

  it("pings done only for turns of 60 s or longer", () => {
    expect(pingForNotification(frame("done"))).toBeNull();
    expect(pingForNotification(frame("done"), 59_999)).toBeNull();
    expect(pingForNotification(frame("done"), 60_000)).toEqual({ title: "Scout done", message: "detail" });
  });
});

describe("pingForMailbox", () => {
  it("pings FAIL and BLOCKED reports with the first line", () => {
    expect(pingForMailbox("Scout", "FAIL PHONE-PING branch=x sha=abc dirty=no\nlong detail")).toEqual({
      title: "Scout: worker FAIL",
      message: "FAIL PHONE-PING branch=x sha=abc dirty=no",
      tags: ["warning"],
    });
    expect(pingForMailbox("Scout", "BLOCKED NICK branch=none\r\nwhy")?.title).toBe("Scout: worker BLOCKED");
  });

  it("stays quiet for DONE reports and plain notes", () => {
    expect(pingForMailbox("Scout", "DONE NICK branch=x sha=y dirty=no\nall good")).toBeNull();
    expect(pingForMailbox("Scout", "the build FAILed")).toBeNull();
    expect(pingForMailbox("Scout", "FAILED to start")).toBeNull();
    expect(pingForMailbox("Scout", "")).toBeNull();
  });
});

describe("createPingLimiter", () => {
  it("drops a repeat title+message per bot within 10 s", () => {
    let now = 0;
    const allow = createPingLimiter(10_000, () => now);
    expect(allow("bot-1", "Scout finished", "done")).toBe(true);
    expect(allow("bot-1", "Scout finished", "done")).toBe(false);
    expect(allow("bot-1", "Scout has a question", "done")).toBe(true);
    expect(allow("bot-2", "Scout finished", "done")).toBe(true);
    now = 9_999;
    expect(allow("bot-1", "Scout finished", "done")).toBe(false);
    now = 10_000;
    expect(allow("bot-1", "Scout finished", "done")).toBe(true);
  });

  it("lets two distinct FAIL reports through but drops an exact repeat", () => {
    let now = 0;
    const allow = createPingLimiter(10_000, () => now);
    const cardA = pingForMailbox("Scout", "FAIL CARD-A branch=x sha=abc dirty=no\ndetail")!;
    const cardB = pingForMailbox("Scout", "FAIL CARD-B branch=x sha=abc dirty=no\ndetail")!;
    expect(allow("bot-1", cardA.title, cardA.message)).toBe(true);
    now = 1_000;
    expect(allow("bot-1", cardB.title, cardB.message)).toBe(true);
    now = 2_000;
    expect(allow("bot-1", cardA.title, cardA.message)).toBe(false);
  });
});
