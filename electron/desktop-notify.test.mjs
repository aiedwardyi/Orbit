import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  WINDOWS_APP_USER_MODEL_ID,
  canClaimDesktopToasts,
  handleDesktopNotify,
  parseNotifyPayload,
  shouldShowDesktopToast,
  taskbarBusyIndicator,
  windowsAppUserModelId,
  withToastCapability,
} from "./desktop-notify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frame = {
  title: "Maus finished",
  body: "All done",
  icon: "/api/attachments/face.png",
  botId: "bot-1",
  threadId: "thread-1",
  visibleThreadId: "other-thread",
};

function fakeWindow({ focused = false, minimized = false, destroyed = false, url = "http://127.0.0.1:8799/" } = {}) {
  const calls = [];
  return {
    calls,
    isFocused: () => focused,
    isMinimized: () => minimized,
    isDestroyed: () => destroyed,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    webContents: {
      getURL: () => url,
      send: (...args) => calls.push(["send", ...args]),
    },
  };
}

function fakeNotificationClass() {
  const notices = [];
  class FakeNotification {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.shown = false;
      notices.push(this);
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    show() {
      this.shown = true;
    }
  }
  return { FakeNotification, notices };
}

describe("Windows toast identity", () => {
  it("uses the packaged appId as the AppUserModelID", () => {
    const builder = readFileSync(path.join(root, "electron-builder.yml"), "utf8");
    expect(WINDOWS_APP_USER_MODEL_ID).toBe("com.orbit.agentdesk");
    expect(windowsAppUserModelId()).toBe("com.orbit.agentdesk");
    expect(builder).toMatch(/^appId: com\.orbit\.agentdesk$/m);
  });

  it("sets that AppUserModelID in main before any window can exist", () => {
    const main = readFileSync(path.join(root, "electron/main.mjs"), "utf8");
    const preload = readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
    const aumidAt = main.indexOf("setAppUserModelId(windowsAppUserModelId())");
    const readyAt = main.indexOf("app.whenReady()");
    expect(aumidAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(aumidAt);
    expect(main).toContain("handleDesktopNotify(");
    expect(main).toContain("taskbarBusyIndicator(");
    expect(preload).toContain("desktop:notify");
    expect(preload).toContain("desktop:taskbar-busy");
    expect(preload).toContain("desktop:notification-click");
  });
});

describe("shouldShowDesktopToast", () => {
  it("fires when the window is minimized, even on the same thread", () => {
    expect(
      shouldShowDesktopToast({
        focused: true,
        minimized: true,
        visibleThreadId: "thread-1",
        frameThreadId: "thread-1",
      }),
    ).toBe(true);
  });

  it("stays quiet only when the window is focused and that thread is on screen", () => {
    expect(
      shouldShowDesktopToast({
        focused: true,
        minimized: false,
        visibleThreadId: "thread-1",
        frameThreadId: "thread-1",
      }),
    ).toBe(false);
  });

  it("still fires a focused window that is looking at another task", () => {
    expect(
      shouldShowDesktopToast({
        focused: true,
        minimized: false,
        visibleThreadId: "other-thread",
        frameThreadId: "thread-1",
      }),
    ).toBe(true);
  });

  it("fires when Orbit is in the background", () => {
    expect(
      shouldShowDesktopToast({
        focused: false,
        minimized: false,
        visibleThreadId: "thread-1",
        frameThreadId: "thread-1",
      }),
    ).toBe(true);
  });
});

describe("parseNotifyPayload", () => {
  it("keeps the bot and thread the toast should open", () => {
    expect(parseNotifyPayload(frame)).toEqual({
      title: "Maus finished",
      body: "All done",
      icon: "/api/attachments/face.png",
      botId: "bot-1",
      threadId: "thread-1",
      visibleThreadId: "other-thread",
    });
  });

  it("rejects payloads that cannot address a conversation", () => {
    expect(parseNotifyPayload(null)).toBeNull();
    expect(parseNotifyPayload({ title: "x", botId: "bot-1" })).toBeNull();
    expect(parseNotifyPayload({ title: 1, botId: "bot-1", threadId: "t" })).toBeNull();
  });
});

describe("taskbarBusyIndicator", () => {
  it("uses Windows indeterminate progress while a turn runs", () => {
    expect(taskbarBusyIndicator(true)).toEqual({ progress: 0, mode: "indeterminate" });
  });

  it("clears the taskbar progress when idle", () => {
    expect(taskbarBusyIndicator(false)).toEqual({ progress: -1, mode: "none" });
  });
});

describe("canClaimDesktopToasts", () => {
  it("claims Get notified only when a real delivery path exists", () => {
    expect(canClaimDesktopToasts({ nativeSupported: true })).toBe(true);
    expect(canClaimDesktopToasts({ html5Available: true, html5Permission: "granted" })).toBe(true);
    expect(canClaimDesktopToasts({ html5Available: true, html5Permission: "default" })).toBe(true);
    expect(canClaimDesktopToasts({ html5Available: true, html5Permission: "denied" })).toBe(false);
    expect(canClaimDesktopToasts({})).toBe(false);
  });
});

describe("withToastCapability", () => {
  it("surfaces whether the shell can actually toast", () => {
    expect(withToastCapability({ host: { platform: "win32" } }, true)).toEqual({
      host: { platform: "win32" },
      toasts: { available: true },
    });
    expect(withToastCapability({ host: { platform: "win32" } }, false).toasts.available).toBe(false);
  });
});

describe("handleDesktopNotify", () => {
  it("shows a main-process toast when Orbit is in the background", () => {
    const { FakeNotification, notices } = fakeNotificationClass();
    const win = fakeWindow();
    const clicks = [];

    const result = handleDesktopNotify({
      win,
      payload: frame,
      Notification: FakeNotification,
      nativeSupported: true,
      icon: "C:\\orbit\\icon.png",
      activate: (target) => target.calls.push("activate"),
      sendClick: (target) => clicks.push(target),
    });

    expect(result).toEqual({ shown: true });
    expect(notices).toHaveLength(1);
    expect(notices[0].options).toMatchObject({
      title: frame.title,
      body: frame.body,
      silent: false,
      icon: "C:\\orbit\\icon.png",
    });
    expect(notices[0].shown).toBe(true);

    notices[0].handlers.click();
    expect(win.calls).toContain("activate");
    expect(clicks).toEqual([{ botId: "bot-1", threadId: "thread-1" }]);
  });

  it("does not show a toast when the OS cannot notify", () => {
    const { FakeNotification, notices } = fakeNotificationClass();
    const result = handleDesktopNotify({
      win: fakeWindow(),
      payload: frame,
      Notification: FakeNotification,
      nativeSupported: false,
    });
    expect(result).toEqual({ shown: false });
    expect(notices).toHaveLength(0);
  });

  it("does not show a toast when the exact thread is already on a focused window", () => {
    const { FakeNotification, notices } = fakeNotificationClass();
    const result = handleDesktopNotify({
      win: fakeWindow({ focused: true, minimized: false }),
      payload: { ...frame, visibleThreadId: frame.threadId },
      Notification: FakeNotification,
      nativeSupported: true,
    });
    expect(result).toEqual({ shown: false });
    expect(notices).toHaveLength(0);
  });
});
