import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildNotificationOptions,
  buildTerminalNotification,
  canClaimGetNotified,
  desktopNotificationHint,
  requestNotificationPermission,
  showNotification,
  terminalAttentionCopy,
  type NotifyFrame,
} from "./notify";

const frame: NotifyFrame = {
  kind: "done",
  botId: "bot-1",
  botName: "Maus",
  threadId: "thread-1",
  title: "Maus finished",
  body: "All done",
};

function installNotification(permission: NotificationPermission, focused = false) {
  const notices: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    constructor(public title: string, public options?: NotificationOptions) {
      notices.push(this);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", { hasFocus: () => focused });
  vi.stubGlobal("window", { focus: vi.fn() });
  return { notices, requestPermission };
}

afterEach(() => vi.unstubAllGlobals());

describe("desktop notifications", () => {
  it("does not request permission from a background notification frame", () => {
    const { notices, requestPermission } = installNotification("default");
    showNotification(frame, vi.fn());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
  });

  it("requests permission through the explicit settings action", async () => {
    const { requestPermission } = installNotification("default");
    await requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("shows a notification after permission is granted", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: frame.title, options: { body: frame.body, tag: `openmausbot:${frame.botId}` } });
  });

  it("stays quiet only when the exact target thread is already visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, frame.threadId);

    expect(notices).toHaveLength(0);
  });

  it("still alerts a focused app when another task is visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, "another-thread");

    expect(notices).toHaveLength(1);
  });

  it("opens the exact detached task carried by the notification", () => {
    const { notices } = installNotification("granted");
    const onOpen = vi.fn();

    showNotification({ ...frame, threadId: "detached-routine-thread" }, onOpen);
    notices[0]!.onclick?.();

    expect(window.focus).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith({
      botId: frame.botId,
      threadId: "detached-routine-thread",
    });
  });

  it("keeps the terminal session on a browser toast click", () => {
    const { notices } = installNotification("granted");
    const onOpen = vi.fn();

    showNotification({ ...frame, openTerminal: true, terminalSessionId: "session-1" }, onOpen);
    notices[0]!.onclick?.();

    expect(onOpen).toHaveBeenCalledWith({
      botId: frame.botId,
      threadId: frame.threadId,
      openTerminal: true,
      terminalSessionId: "session-1",
    });
  });

  it("groups under the bot, not the thread", () => {
    const { notices } = installNotification("granted");

    showNotification(frame, vi.fn());
    showNotification(
      { ...frame, threadId: "thread-2", body: "Second task done" },
      vi.fn(),
    );

    // one bot across two threads shares a tag, so the platform replaces
    // rather than stacks; another bot gets its own key
    expect(notices[0]?.options?.tag).toBe(`openmausbot:${frame.botId}`);
    expect(notices[1]?.options?.tag).toBe(`openmausbot:${frame.botId}`);
    showNotification({ ...frame, botId: "bot-2" }, vi.fn());
    expect(notices[2]?.options?.tag).toBe(`openmausbot:bot-2`);
  });

  it("carries the bot's avatar when its profile has one", () => {
    const { notices } = installNotification("granted");
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png";

    showNotification(frame, vi.fn(), avatarUrl);
    expect(notices[0]?.options?.icon).toBe(avatarUrl);

    showNotification(frame, vi.fn(), null);
    expect(notices[1]?.options?.icon).toBeUndefined();
  });

  it("hands a background toast to the desktop shell instead of the renderer Notification", () => {
    const { notices } = installNotification("default");
    const showNative = vi.fn();
    vi.stubGlobal("window", { focus: vi.fn(), ogb: { showNotification: showNative } });

    showNotification(frame, vi.fn(), "/avatar.png", "other-thread");

    expect(showNative).toHaveBeenCalledOnce();
    expect(showNative).toHaveBeenCalledWith({
      title: frame.title,
      body: frame.body,
      icon: "/avatar.png",
      botId: frame.botId,
      threadId: frame.threadId,
      visibleThreadId: "other-thread",
    });
    expect(notices).toHaveLength(0);
  });

  it("still asks the shell to toast when a minimized window reports renderer focus", () => {
    const { notices } = installNotification("granted", true);
    const showNative = vi.fn();
    vi.stubGlobal("window", { focus: vi.fn(), ogb: { showNotification: showNative } });

    showNotification(frame, vi.fn(), undefined, frame.threadId);

    expect(showNative).toHaveBeenCalledOnce();
    expect(notices).toHaveLength(0);
  });

  it("carries the terminal session to the native toast", () => {
    const { notices } = installNotification("default");
    const showNative = vi.fn();
    vi.stubGlobal("window", { focus: vi.fn(), ogb: { showNotification: showNative } });

    showNotification({ ...frame, openTerminal: true, terminalSessionId: "session-1" }, vi.fn());

    expect(showNative).toHaveBeenCalledWith(expect.objectContaining({
      openTerminal: true,
      terminalSessionId: "session-1",
    }));
    expect(notices).toHaveLength(0);
  });
});

describe("desktop notification copy", () => {
  it("keeps the friends toggle line only when a toast can actually fire", () => {
    expect(canClaimGetNotified({ toastsAvailable: true, html5: false })).toBe(true);
    expect(canClaimGetNotified({ toastsAvailable: false, html5: true })).toBe(false);
    expect(canClaimGetNotified({ html5: true })).toBe(true);
    expect(canClaimGetNotified({ html5: false })).toBe(false);
    expect(desktopNotificationHint(true)).toBe("Get notified when this bot finishes or needs input");
    expect(desktopNotificationHint(false)).not.toMatch(/Get notified/i);
  });
});

describe("terminal notifications", () => {
  const bot = { id: "bot-1", name: "Maus", threadId: "thread-1" };

  it("builds attention copy for terminal bells, errors, and exits", () => {
    expect(buildTerminalNotification(bot, "bell")).toMatchObject({
      kind: "takeover",
      title: "Maus terminal needs attention",
      body: "The terminal is waiting for you.",
      openTerminal: true,
    });
    expect(buildTerminalNotification(bot, "error")?.body).toBe("The terminal reported an error.");
    expect(buildTerminalNotification(bot, "exit")?.title).toBe("Maus terminal finished");
  });

  it("carries the terminal session through the open target", () => {
    expect(buildTerminalNotification(bot, "bell", "session-1")).toMatchObject({
      openTerminal: true,
      terminalSessionId: "session-1",
    });
  });

  it("keeps the badge reason and tone explicit in both supported locales", () => {
    expect(terminalAttentionCopy("bell")).toEqual({
      label: "Waiting",
      tooltip: "The terminal is waiting for input.",
      tone: "accent",
    });
    expect(terminalAttentionCopy("exit", "ko")).toEqual({
      label: "완료",
      tooltip: "터미널 프로세스가 끝났습니다.",
      tone: "success",
    });
    expect(terminalAttentionCopy("error", "ko").tone).toBe("danger");
  });

  it("honors the bot notification toggle", () => {
    expect(buildTerminalNotification({ ...bot, notifications: false }, "exit")).toBeNull();
  });
});

describe("buildNotificationOptions", () => {
  it("keys coalescing on botId and omits a missing avatar", () => {
    expect(buildNotificationOptions({ id: "bot-9" })).toEqual({
      tag: "openmausbot:bot-9",
      icon: undefined,
    });
  });
});
