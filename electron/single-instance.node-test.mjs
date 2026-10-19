import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { buildConnectingPage, shouldDeliverPackageInstall } from "./boot-page.mjs";
import { parseNotificationTargetFromCommandLine } from "./desktop-notify.mjs";
import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";
import * as singleInstance from "./single-instance.mjs";
import { channelFromCommandLine } from "./update-channel.mjs";

const { activateExistingWindow } = singleInstance;

function fakeWindow({ destroyed = false, minimized = false, focused = false, loading = false } = {}) {
  const calls = [];
  const win = {
    calls,
    loading,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isFocused: () => focused,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    webContents: {
      getURL: () => "http://127.0.0.1:8799/",
      isLoadingMainFrame: () => win.loading,
      send: (...args) => calls.push(["send", ...args]),
    },
  };
  return win;
}

test("shows and focuses the only living window", () => {
  const win = fakeWindow();
  assert.equal(activateExistingWindow([win]), true);
  assert.deepEqual(win.calls, ["show", "focus"]);
});

test("restores a minimized window before showing it", () => {
  const win = fakeWindow({ minimized: true });
  assert.equal(activateExistingWindow([win]), true);
  assert.deepEqual(win.calls, ["restore", "show", "focus"]);
});

test("skips destroyed windows without touching them", () => {
  const dead = fakeWindow({ destroyed: true });
  const alive = fakeWindow();
  assert.equal(activateExistingWindow([dead, alive]), true);
  assert.deepEqual(dead.calls, []);
  assert.deepEqual(alive.calls, ["show", "focus"]);
});

test("prefers the focused window among several", () => {
  const first = fakeWindow();
  const second = fakeWindow({ focused: true });
  assert.equal(activateExistingWindow([first, second]), true);
  assert.deepEqual(first.calls, []);
  assert.deepEqual(second.calls, ["show", "focus"]);
});

test("reports failure when no window can be activated", () => {
  const dead = fakeWindow({ destroyed: true });
  assert.equal(activateExistingWindow([]), false);
  assert.equal(activateExistingWindow([dead]), false);
  assert.deepEqual(dead.calls, []);
});

function activationHarness(mainWindow, windows, { startupWindowCreated = true } = {}) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const notification = source.slice(source.indexOf("function deliverNotificationTarget("), source.indexOf("let mainWindow = null;"));
  assert.ok(notification.includes("desktop:notification-click"));
  const handlers = source.slice(source.indexOf("function deliverPackageInstall("), source.indexOf("// Packaged: the harness server"));
  assert.ok(handlers.includes('app.on("second-instance"'));
  const activate = source.match(/app\.on\("activate", \(\) => \{[\s\S]*?\n  \}\);/);
  assert.ok(activate);
  const events = new Map();
  const created = [];
  const surfaces = [];
  const channels = [];
  const context = vm.createContext({
    ...singleInstance,
    mainWindow,
    startupWindowCreated,
    pendingPackageInstallUrl: null,
    pendingNotificationTarget: null,
    app: { isPackaged: true, isReady: () => true, on: (event, handler) => events.set(event, handler) },
    BrowserWindow: { getAllWindows: () => [...windows, ...created] },
    shouldDeliverPackageInstall,
    packageUrlFromCommandLine,
    packageUrlFromDeepLink,
    parseNotificationTargetFromCommandLine,
    channelFromCommandLine,
    switchUpdateChannel: (channel) => channels.push(channel),
    BOOT_READY: "ready",
    packagedBootPhase: "ready",
    startBrowserSurface: (win) => surfaces.push(win),
    createWindow: () => {
      const win = fakeWindow({ loading: true });
      context.mainWindow = win;
      created.push(win);
      return win;
    },
  });
  vm.runInContext(`${notification}\n${handlers}\n${activate[0]}`, context);
  return { context, events, created, surfaces, channels };
}

const packageUrl = "https://github.com/acme/bots/blob/main/bot.md";
const packageLink = `orbit://install?url=${encodeURIComponent(packageUrl)}`;
const notificationTarget = { botId: "bot-1", threadId: "thread-1" };

function activate(harness, event) {
  const { context, events } = harness;
  context.pendingPackageInstallUrl = packageUrl;
  context.pendingNotificationTarget = notificationTarget;
  if (event === "second-instance") {
    events.get(event)({}, ["Wink", packageLink, "--orbit-notify-bot=bot-1", "--orbit-notify-thread=thread-1"]);
  } else if (event === "open-url") {
    let prevented = false;
    events.get(event)({ preventDefault: () => { prevented = true; } }, packageLink);
    assert.equal(prevented, true);
  } else {
    events.get(event)();
  }
}

test("cold-boot notification stays pending through the connecting page until the app loads", () => {
  const win = fakeWindow();
  let url = buildConnectingPage({ message: "Connecting" });
  win.webContents.getURL = () => url;
  const { context } = activationHarness(win, [win]);
  context.pendingNotificationTarget = notificationTarget;
  vm.runInContext("deliverNotificationTarget(mainWindow);", context);
  assert.deepEqual(win.calls, []);
  assert.strictEqual(context.pendingNotificationTarget, notificationTarget);

  url = "http://127.0.0.1:8799/";
  win.loading = true;
  vm.runInContext("deliverNotificationTarget(mainWindow);", context);
  assert.deepEqual(win.calls, []);
  assert.strictEqual(context.pendingNotificationTarget, notificationTarget);

  win.loading = false;
  vm.runInContext("deliverNotificationTarget(mainWindow);", context);
  assert.deepEqual(win.calls, [["send", "desktop:notification-click", notificationTarget]]);
  assert.equal(context.pendingNotificationTarget, null);
});

for (const event of ["second-instance", "open-url"]) {
  test(`${event} during startup leaves the first window to startup and delivers there`, () => {
    const harness = activationHarness(null, [], { startupWindowCreated: false });
    activate(harness, event);
    const { context, created, surfaces } = harness;
    assert.equal(created.length, 0);
    assert.deepEqual(surfaces, []);

    const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const startup = source.match(/const win = createWindow\(\);\s*startupWindowCreated = true;/);
    assert.ok(startup);
    vm.runInContext(startup[0], context);
    assert.equal(created.length, 1);
    const win = created[0];
    assert.strictEqual(context.mainWindow, win);

    activate(harness, event);
    assert.equal(created.length, 1);
    win.loading = false;
    vm.runInContext("deliverPackageInstall(mainWindow); deliverNotificationTarget(mainWindow);", context);
    assert.deepEqual(win.calls.filter((call) => Array.isArray(call)), [
      ["send", "package:install", packageUrl],
      ["send", "desktop:notification-click", notificationTarget],
    ]);
  });
}

for (const event of ["second-instance", "open-url", "activate"]) {
  test(`${event} recreates a missing or destroyed main without consuming pending targets in aux`, () => {
    for (const mainWindow of [null, fakeWindow({ destroyed: true })]) {
      const aux = fakeWindow({ focused: true });
      const harness = activationHarness(mainWindow, [aux]);
      activate(harness, event);
      const { context, created, surfaces } = harness;
      assert.equal(created.length, 1);
      const next = created[0];
      assert.strictEqual(context.mainWindow, next);
      assert.deepEqual(aux.calls, []);
      assert.equal(context.pendingPackageInstallUrl, packageUrl);
      assert.deepEqual(context.pendingNotificationTarget, notificationTarget);
      assert.deepEqual(next.calls, []);
      assert.deepEqual(surfaces, [next]);

      context.aux = aux;
      vm.runInContext("deliverPackageInstall(aux); deliverNotificationTarget(aux);", context);
      assert.deepEqual(aux.calls, []);
      assert.equal(context.pendingPackageInstallUrl, packageUrl);
      assert.deepEqual(context.pendingNotificationTarget, notificationTarget);

      next.loading = false;
      vm.runInContext("deliverPackageInstall(mainWindow); deliverNotificationTarget(mainWindow);", context);
      assert.deepEqual(next.calls, [
        ["send", "package:install", packageUrl],
        ["send", "desktop:notification-click", notificationTarget],
      ]);
      assert.equal(context.pendingPackageInstallUrl, null);
      assert.equal(context.pendingNotificationTarget, null);
    }
  });

  test(`${event} focuses the live main and delivers there while an aux window is focused`, () => {
    const aux = fakeWindow({ focused: true });
    const mainWindow = fakeWindow({ minimized: true });
    const harness = activationHarness(mainWindow, [aux, mainWindow]);
    activate(harness, event);
    assert.equal(harness.created.length, 0);
    assert.deepEqual(aux.calls, []);
    assert.deepEqual(mainWindow.calls, [
      "restore", "show", "focus",
      ["send", "package:install", packageUrl],
      ["send", "desktop:notification-click", notificationTarget],
    ]);
    assert.equal(harness.context.pendingPackageInstallUrl, null);
    assert.equal(harness.context.pendingNotificationTarget, null);
  });
}

test("second-instance hands an update channel flag to the updater and still focuses the window", () => {
  const mainWindow = fakeWindow();
  const harness = activationHarness(mainWindow, [mainWindow]);
  harness.events.get("second-instance")({}, ["Orbit.exe", "--update-channel=stable"]);
  assert.deepEqual(harness.channels, ["stable"]);
  assert.deepEqual(mainWindow.calls, ["show", "focus"]);

  activate(harness, "second-instance");
  assert.deepEqual(harness.channels, ["stable"]);
});

test("a new main window takes over the updater's state pushes", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /import \{[^}]*\bretargetUpdater\b[^}]*\} from "\.\/updater\.mjs";/);
  assert.match(main, /function createWindow\(\) \{[\s\S]*?mainWindow = win;\s*retargetUpdater\(win\);/);
  const updater = readFileSync(new URL("./updater.mjs", import.meta.url), "utf8");
  assert.match(updater, /export function retargetUpdater\(mainWindow\) \{\s*win = mainWindow;\s*\}/);
});
