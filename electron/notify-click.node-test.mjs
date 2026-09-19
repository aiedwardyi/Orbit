import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { handleDesktopNotify, parseNotifyPayload, shouldShowDesktopToast } from "./desktop-notify.mjs";
import { activateExistingWindow } from "./single-instance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

function fakeWindow({ focused = false, minimized = false, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isFocused: () => focused,
    isMinimized: () => minimized,
    isDestroyed: () => destroyed,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    webContents: { getURL: () => "http://127.0.0.1:8799/", send: (...a) => calls.push(["send", ...a]) },
  };
}

function fakeNotificationClass() {
  const notices = [];
  class FakeNotification {
    constructor(o) { this.options = o; this.handlers = {}; notices.push(this); }
    on(e, h) { this.handlers[e] = h; }
    show() {}
  }
  return { FakeNotification, notices };
}

function clickWithRealActivate({ winOpts, payload }) {
  const { FakeNotification, notices } = fakeNotificationClass();
  const win = fakeWindow(winOpts);
  const clicks = [];
  const result = handleDesktopNotify({
    win,
    payload,
    Notification: FakeNotification,
    nativeSupported: true,
    icon: "icon.png",
    activate: (w) => activateExistingWindow([w]),
    sendClick: (t) => clicks.push(t),
  });
  assert.equal(result.shown, true);
  assert.equal(notices.length, 1);
  notices[0].handlers.click();
  return { win, clicks };
}

test("minimized click restores the one window and opens that bot's chat", () => {
  const { win, clicks } = clickWithRealActivate({
    winOpts: { focused: false, minimized: true },
    payload: { title: "Maus finished", body: "done", botId: "bot-7", threadId: "thread-7", visibleThreadId: "other" },
  });
  assert.deepEqual(win.calls.filter((c) => typeof c === "string"), ["restore", "show", "focus"]);
  assert.deepEqual(clicks, [{ botId: "bot-7", threadId: "thread-7" }]);
});

test("background click focuses the existing window for the right bot", () => {
  const { win, clicks } = clickWithRealActivate({
    winOpts: { focused: false, minimized: false },
    payload: { title: "Maus finished", body: "done", botId: "bot-2", threadId: "thread-2", visibleThreadId: "thread-9" },
  });
  assert.ok(win.calls.includes("show") && win.calls.includes("focus"));
  assert.deepEqual(clicks, [{ botId: "bot-2", threadId: "thread-2" }]);
});

test("focused on another bot still toasts and routes to the notifying bot", () => {
  assert.equal(
    shouldShowDesktopToast({ focused: true, minimized: false, visibleThreadId: "thread-9", frameThreadId: "thread-2" }),
    true,
  );
  const { clicks } = clickWithRealActivate({
    winOpts: { focused: true, minimized: false },
    payload: { title: "Maus finished", body: "done", botId: "bot-2", threadId: "thread-2", visibleThreadId: "thread-9" },
  });
  assert.deepEqual(clicks, [{ botId: "bot-2", threadId: "thread-2" }]);
});

test("terminal toast click carries the terminal target, chat carries none", () => {
  const term = clickWithRealActivate({
    winOpts: {},
    payload: { title: "t", body: "b", botId: "bot-1", threadId: "thread-1", openTerminal: true, terminalSessionId: "s-1" },
  });
  assert.deepEqual(term.clicks, [{ botId: "bot-1", threadId: "thread-1", openTerminal: true, terminalSessionId: "s-1" }]);
  const parsed = parseNotifyPayload({ title: "t", botId: "bot-1", threadId: "thread-1", openTerminal: true, terminalSessionId: "s-1" });
  assert.equal(parsed.openTerminal, true);
  assert.equal(parsed.terminalSessionId, "s-1");
});

test("main notify click reuses main window and never spawns one", () => {
  const main = read("electron/main.mjs");
  const at = main.indexOf('ipcMain.on("desktop:notify"');
  assert.ok(at > -1);
  const end = main.indexOf('ipcMain.on("desktop:taskbar-busy"', at);
  assert.ok(end > at);
  const block = main.slice(at, end);
  assert.ok(block.includes("activateExistingWindow"));
  assert.ok(block.includes("desktop:notification-click"));
  assert.ok(block.includes("sendClick"));
  assert.ok(block.includes("target"));
  assert.ok(!block.includes("new BrowserWindow"));
  assert.ok(!block.includes("createWindow("));
  assert.ok(!block.includes("revealPackagedApp"));
  assert.ok(!block.includes("openDesktopViewer"));
});

test("notification never selects an unknown bot like a sidebar cannot", () => {
  const store = read("src/state/store.tsx");
  const at = store.indexOf("export function openNotificationTarget(");
  assert.ok(at > -1);
  const fn = store.slice(at, at + 1500);
  const guardAt = fn.indexOf("if (!bot) return;");
  const botSelectAt = fn.indexOf('id: target.botId');
  assert.ok(guardAt > -1 && botSelectAt > -1);
  assert.ok(guardAt < botSelectAt, "must resolve the bot before dispatching select");
});

test("renderer carries bot target to shell and opens it like sidebar select", () => {
  const lib = read("src/lib/notify.ts");
  assert.ok(lib.includes("botId: frame.botId"));
  assert.ok(lib.includes("threadId: frame.threadId"));
  assert.ok(lib.includes("openTerminal"));
  assert.ok(lib.includes("onOpen(target)"));
  const store = read("src/state/store.tsx");
  assert.ok(store.includes("openNotificationTarget"));
  assert.ok(store.includes('type: "select"'));
  const app = read("src/App.tsx");
  assert.ok(app.includes("openNotificationTarget(dispatch, target"));
  assert.ok(app.includes("setTerminalViews((views) => ({ ...views, [target.botId]: true }))"));
  assert.ok(app.includes("setTerminalViews((views) => ({ ...views, [target.botId]: false }))"));
  const preload = read("electron/preload.cjs");
  assert.ok(preload.includes("desktop:notify"));
  assert.ok(preload.includes("desktop:notification-click"));
});
