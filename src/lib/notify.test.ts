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
  icon: "/notify-icons/squircle-white.png",
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

function installIconRaster(fetchIcon: typeof fetch) {
  const drawImage = vi.fn();
  vi.stubGlobal("fetch", fetchIcon);
  vi.stubGlobal("createImageBitmap", async () => ({ width: 300, height: 200, close: vi.fn() }));
  vi.stubGlobal("document", {
    hasFocus: () => false,
    createElement: () => ({ getContext: () => ({ drawImage }), toDataURL: (type: string) => `data:${type};base64,iVBORw0K` }),
  });
  return { drawImage };
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

    showNotification(frame, vi.fn(), frame.threadId);

    expect(notices).toHaveLength(0);
  });

  it("still alerts a focused app when another task is visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), "another-thread");

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

  it("shows the frame's bot icon", () => {
    const { notices } = installNotification("granted");

    showNotification(frame, vi.fn());
    expect(notices[0]?.options?.icon).toBe("/notify-icons/squircle-white.png");

    showNotification({ ...frame, icon: "" }, vi.fn());
    expect(notices[1]?.options?.icon).toBeUndefined();
  });

  it("hands a background toast to the desktop shell with the bot icon as a PNG data URL", async () => {
    const { notices } = installNotification("default");
    const showNative = vi.fn();
    vi.stubGlobal("window", { focus: vi.fn(), ogb: { showNotification: showNative } });
    const fetchIcon = vi.fn(async () => new Response(new Uint8Array([1])));
    const { drawImage } = installIconRaster(fetchIcon);

    showNotification(frame, vi.fn(), "other-thread");

    await vi.waitFor(() => expect(showNative).toHaveBeenCalledOnce());
    expect(fetchIcon).toHaveBeenCalledWith("/notify-icons/squircle-white.png");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 50, 0, 200, 200, 0, 0, 200, 200);
    expect(showNative).toHaveBeenCalledWith({
      title: frame.title,
      body: frame.body,
      icon: "data:image/png;base64,iVBORw0K",
      botId: frame.botId,
      threadId: frame.threadId,
      visibleThreadId: "other-thread",
    });
    expect(notices).toHaveLength(0);
  });

  it("still toasts through the shell, without an icon, when the icon fetch fails", async () => {
    installNotification("default");
    const showNative = vi.fn();
    vi.stubGlobal("window", { focus: vi.fn(), ogb: { showNotification: showNative } });
    installIconRaster(vi.fn(async () => new Response(null, { status: 404 })));

    showNotification(frame, vi.fn());

    await vi.waitFor(() => expect(showNative).toHaveBeenCalledOnce());
    expect(showNative.mock.calls[0]?.[0]).not.toHaveProperty("icon");
  });

  it("still asks the shell to toast when a minimized window reports renderer focus", async () => {
    const { notices } = installNotification("granted", true);
    const showNative = vi.fn();
    vi.stubGlobal("window", { focus: vi.fn(), ogb: { showNotification: showNative } });

    showNotification(frame, vi.fn(), frame.threadId);

    await vi.waitFor(() => expect(showNative).toHaveBeenCalledOnce());
    expect(notices).toHaveLength(0);
  });

  it("carries the terminal session to the native toast", async () => {
    const { notices } = installNotification("default");
    const showNative = vi.fn();
    vi.stubGlobal("window", { focus: vi.fn(), ogb: { showNotification: showNative } });

    showNotification({ ...frame, openTerminal: true, terminalSessionId: "session-1" }, vi.fn());

    await vi.waitFor(() => expect(showNative).toHaveBeenCalledWith(expect.objectContaining({
      openTerminal: true,
      terminalSessionId: "session-1",
    })));
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
    expect(buildTerminalNotification(bot, "activity")).toMatchObject({
      title: "Maus terminal activity",
      body: "New terminal activity.",
      openTerminal: true,
    });
  });

  it("carries the terminal session through the open target", () => {
    expect(buildTerminalNotification(bot, "bell", "session-1")).toMatchObject({
      openTerminal: true,
      terminalSessionId: "session-1",
    });
  });

  it("keeps the badge reason explicit in both supported locales", () => {
    expect(terminalAttentionCopy("bell")).toEqual({
      label: "Waiting",
      tooltip: "The terminal is waiting for input.",
    });
    expect(terminalAttentionCopy("exit", "ko")).toEqual({
      label: "완료",
      tooltip: "터미널 프로세스가 끝났습니다.",
    });
    expect(terminalAttentionCopy("error", "ko").label).toBe("오류");
    expect(terminalAttentionCopy("activity", "ko")).toEqual({
      label: "활동",
      tooltip: "터미널에 새 활동이 있습니다.",
    });
  });

  it("uses the bot's own icon", () => {
    expect(buildTerminalNotification(bot, "bell")?.icon).toBe("/notify-icons/peach-white.png");
    expect(buildTerminalNotification({ ...bot, avatarCrop: "mascot", mascotStyle: "icon-05" }, "bell")?.icon)
      .toBe("/avatars/icon-05-ledger-white.png");
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
