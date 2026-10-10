// What is worth interrupting someone for. The policy is small, so the
// tests are mostly about the cases where the answer is "stay quiet".
import { describe, expect, it } from "vitest";

import { buildNotification, summarize } from "./notify.ts";

const bot = { id: "bot-1", name: "Scout", threadId: "thread-1" };

describe("buildNotification", () => {
  it("names the bot and carries the detail, per kind", () => {
    expect(buildNotification("approval", bot, "thread-1", "rm -rf ./build")).toMatchObject({
      kind: "approval",
      botId: "bot-1",
      threadId: "thread-1",
      title: "Scout needs approval",
      body: "rm -rf ./build",
    });
    expect(buildNotification("question", bot, "thread-1", "which branch?")?.title).toBe("Scout has a question");
    expect(buildNotification("done", bot, "thread-1", "pushed the branch")?.title).toBe("Scout finished");
    expect(buildNotification("routine-failed", bot, "thread-1", "boom")?.title).toBe("Scout's routine failed");
  });

  it("stays silent for a bot whose notifications are off", () => {
    const quiet = { ...bot, notifications: false };
    for (const kind of ["approval", "question", "done", "routine-failed"] as const) {
      expect(buildNotification(kind, quiet, "thread-1", "anything")).toBeNull();
    }
    // absent means "not turned off" — older bot records predate the flag
    expect(buildNotification("approval", { ...bot, notifications: undefined }, "thread-1", "x")).not.toBeNull();
    expect(buildNotification("approval", { ...bot, notifications: true }, "thread-1", "x")).not.toBeNull();
  });

  it("does not buzz for a finish with nothing to say", () => {
    expect(buildNotification("done", bot, "thread-1", "   ")).toBeNull();
    expect(buildNotification("done", bot, "thread-1", "")).toBeNull();
    // ...but a blocked bot is worth knowing about even with a thin summary
    expect(buildNotification("approval", bot, "thread-1", "")).not.toBeNull();
  });

  it("uses the thread it was raised on, not the bot's current one", () => {
    // a routine runs a bot in a detached task; the notification has to open
    // that conversation, not whatever the bot happens to be showing
    expect(buildNotification("done", bot, "other-thread", "done")?.threadId).toBe("other-thread");
  });

  it("carries the bot's icon for every kind", () => {
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp";
    const photo = { ...bot, avatarUrl, avatarCrop: "circle" };
    for (const kind of ["approval", "question", "done", "routine-failed", "takeover"] as const) {
      expect(buildNotification(kind, photo, "thread-1", "detail")?.icon).toBe(avatarUrl);
      expect(buildNotification(kind, { ...bot, mascotStyle: "squircle", color: "blue" }, "thread-1", "detail")?.icon)
        .toBe("/notify-icons/squircle-blue.png");
    }
    expect(buildNotification("done", bot, "thread-1", "pushed")).not.toHaveProperty("avatarUrl");
  });
});

describe("summarize", () => {
  it("flattens a model's answer into one lock-screen line", () => {
    expect(summarize("line one\n\nline two")).toBe("line one line two");
    expect(summarize("before\n```js\nconst x = 1;\n```\nafter")).toBe("before after");
    expect(summarize("   padded   ")).toBe("padded");
  });

  it("drops markdown marks", () => {
    expect(summarize("Not yet.\n\n- **Test:** I ran `codex -m gpt-6.1-sol` and it failed.")).toBe(
      "Not yet. Test: I ran codex -m gpt-6.1-sol and it failed.",
    );
    expect(summarize("## Done\n1. See [the log](https://x.io) *now*\n> quoted")).toBe("Done See the log now quoted");
    expect(summarize("keep snake_case and 2 * 3")).toBe("keep snake_case and 2 * 3");
  });

  it("clamps long text with an ellipsis", () => {
    const long = summarize("x".repeat(400));
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
    expect(summarize("short")).toBe("short");
  });
});
