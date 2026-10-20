import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { callQuitAndInstall } from "./app-quit.mjs";
import { translate } from "./i18n.mjs";
import * as updateChannel from "./update-channel.mjs";
import { createUpdaterCoordinator, isNewerVersion } from "./updater-coordinator.mjs";

const EXE = "C:\\Wink\\Orbit.exe";
const TASK = {
  program: EXE,
  arguments: "--update-channel=stable",
  iconPath: EXE,
  iconIndex: 0,
  title: "Back to stable release",
  description: "Back to stable release",
};

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The newest version a feed answers with, under the vendored GitHub provider's rules.
function feedVersion(versions, repo, allowPrerelease) {
  const version = versions[repo];
  if (version instanceof Error) throw version;
  // Prereleases on the stable feed look for dev tags it never has (vendor:12564-12614).
  if (repo === "orbit-releases" && allowPrerelease) throw new Error("No published versions on GitHub");
  // Without prereleases the dev feed asks for a latest release it never has (vendor:12657-12669).
  if (repo === "Orbit" && !allowPrerelease) throw new Error("Unable to find latest version on GitHub");
  return version;
}

// Like the vendored AppUpdater: a check caches what it offers, and a download fetches that cache (vendor:14370-14409).
// Underscored fields are internal, so the recording proxy leaves them out.
class FakeElectronUpdater extends EventEmitter {
  _repo = "orbit-releases";
  _offer = null;
  _channel = null;
  hold = null;
  checkHold = null;
  downloads = [];
  allowDowngrade = false;

  constructor(running, versions, log) {
    super();
    this._running = running;
    this._versions = versions;
    this._log = log;
    this.allowPrerelease = updateChannel.isDevBuild(running);
  }

  get channel() {
    return this._channel;
  }

  set channel(value) {
    this._channel = value;
    this.allowDowngrade = true;
  }

  on(event, listener) {
    this._log.push(`on ${event}`);
    return super.on(event, listener);
  }

  setFeedURL(options) {
    this._log.push("setFeedURL");
    this._repo = options.repo;
  }

  async checkForUpdates() {
    this._log.push("checkForUpdates");
    this.emit("checking-for-update");
    await this.checkHold;
    let version;
    try {
      version = feedVersion(this._versions, this._repo, this.allowPrerelease);
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
    const isUpdateAvailable = isNewerVersion(version, this._running) || (this.allowDowngrade && isNewerVersion(this._running, version));
    if (isUpdateAvailable) this._offer = version;
    this.emit(isUpdateAvailable ? "update-available" : "update-not-available", { version });
    return { isUpdateAvailable, updateInfo: { version } };
  }

  downloadUpdate() {
    this._log.push("downloadUpdate");
    const version = this._offer;
    if (!version) return Promise.reject(new Error("Please check update first"));
    const land = () => {
      this.downloads.push(version);
      this.emit("update-downloaded", { version });
      return [`${version}.exe`];
    };
    return this.hold ? this.hold.then(land) : Promise.resolve().then(land);
  }
}

function launch(t, { platform = "win32", running = "1.0.192", channelFile, versions = {}, responses = [], early = [] } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "updater-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  if (channelFile) updateChannel.writeUpdateChannel(userData, channelFile);
  const log = [];
  const target = new FakeElectronUpdater(running, versions, log);
  const autoUpdater = new Proxy(target, {
    set(object, key, value) {
      if (!String(key).startsWith("_")) log.push(`set ${String(key)}`);
      object[key] = value;
      return true;
    },
  });
  const probes = [];
  class NsisUpdater {
    constructor(feed) {
      this.repo = feed.repo;
      this.autoDownload = true;
      this.allowPrerelease = updateChannel.isDevBuild(running);
      probes.push(feed.repo);
    }

    checkForUpdates() {
      if (this.autoDownload !== false) throw new Error("a probe would download");
      return Promise.resolve().then(() => ({ updateInfo: { version: feedVersion(versions, this.repo, this.allowPrerelease) } }));
    }
  }
  const h = { userData, log, updater: target, probes, timers: [], tasks: [], dialogs: [], quits: [] };
  const context = vm.createContext({
    app: {
      isPackaged: true,
      getVersion: () => running,
      getPath: (name) => (name === "logs" ? path.join(userData, "logs") : userData),
      quit: () => h.quits.push("quit"),
      setUserTasks: (tasks) => h.tasks.push(JSON.parse(JSON.stringify(tasks))),
    },
    dialog: {
      showMessageBox: async (_parent, { message, detail, buttons }) => {
        h.dialogs.push({ message, detail, buttons: [...buttons] });
        return { response: responses.shift() ?? 1 };
      },
    },
    ipcMain: { handle() {} },
    appendFileSync: fs.appendFileSync,
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    join: path.join,
    createUpdaterCoordinator,
    callQuitAndInstall,
    ...updateChannel,
    require: (id) => {
      assert.equal(id, "./vendor/electron-updater.cjs");
      return { autoUpdater, NsisUpdater };
    },
    process: { platform, execPath: EXE },
    setTimeout: (callback, ms) => {
      h.timers.push({ kind: "timeout", ms, callback });
      return { unref() {} };
    },
    setInterval: (callback, ms) => {
      h.timers.push({ kind: "interval", ms, callback });
      return { unref() {} };
    },
    clearInterval() {},
  });
  const source = fs.readFileSync(new URL("./updater.mjs", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace("const require = createRequire(import.meta.url);", "")
    .replace(/^export /gm, "");
  h.api = vm.runInContext(`${source}\n({ startUpdater, switchUpdateChannel, updaterBridge, consumePendingUpdateInstall })`, context);
  const win = { isDestroyed: () => false, webContents: { send() {} } };
  for (const next of early) h.api.switchUpdateChannel(next);
  h.api.startUpdater(win, (key, vars) => translate("en", key, vars));
  h.timerList = () => h.timers.map(({ kind, ms }) => `${kind} ${ms}`);
  h.status = () => h.api.updaterBridge.state().status;
  return h;
}

const STARTUP = [
  "set autoDownload",
  "set autoInstallOnAppQuit",
  "set logger",
  "on checking-for-update",
  "on update-available",
  "on update-not-available",
  "on error",
  "on download-progress",
  "on update-downloaded",
];

test("a Windows PC that never chose a channel starts and checks exactly as before", async (t) => {
  const h = launch(t, { versions: { "orbit-releases": "1.0.193" } });
  assert.deepEqual(h.log, STARTUP);
  assert.deepEqual(h.timerList(), ["timeout 15000", "interval 3600000"]);
  assert.deepEqual(h.tasks, []);
  assert.equal(fs.existsSync(path.join(h.userData, "update-channel.json")), false);

  h.timers[0].callback();
  await flush();
  h.timers[1].callback();
  await flush();
  assert.deepEqual(h.log.slice(STARTUP.length), ["checkForUpdates", "checkForUpdates"]);
  assert.deepEqual(h.probes, []);
  assert.equal(h.status(), "available");
});

test("a Mac ignores a channel file and never touches the jump list", async (t) => {
  const h = launch(t, { platform: "darwin", channelFile: "dev", versions: { "orbit-releases": "1.0.193" } });
  assert.deepEqual(h.timerList(), ["timeout 15000", "interval 3600000"]);
  await h.api.switchUpdateChannel("stable");
  h.timers[0].callback();
  await flush();
  assert.deepEqual(h.log, [...STARTUP, "checkForUpdates"]);
  assert.deepEqual(h.tasks, []);
  assert.deepEqual(h.dialogs, []);
  assert.equal(updateChannel.readUpdateChannel(h.userData), "dev");
});

test("joining dev adds the jump list task, checks every 10 minutes and offers the newest dev build", async (t) => {
  const h = launch(t, { versions: { "orbit-releases": "1.0.192", Orbit: "1.0.193-dev.46" } });
  await h.api.switchUpdateChannel("dev");
  assert.equal(updateChannel.readUpdateChannel(h.userData), "dev");
  assert.deepEqual(h.tasks, [[TASK]]);
  assert.equal(h.timerList().at(-1), "interval 600000");
  assert.deepEqual(h.probes, ["orbit-releases", "Orbit"]);
  assert.equal(h.status(), "available");
  assert.equal(h.api.updaterBridge.state().version, "1.0.193-dev.46");
  assert.deepEqual(h.updater.downloads, []);
});

test("a dev build on the dev channel is offered a stable release newer than every dev build", async (t) => {
  const h = launch(t, { running: "1.0.193-dev.45", channelFile: "dev", versions: { "orbit-releases": "1.0.193", Orbit: "1.0.193-dev.46" } });
  await h.api.updaterBridge.check();
  assert.equal(h.status(), "available");
  assert.equal(h.api.updaterBridge.state().version, "1.0.193");
});

test("back to stable from a dev build stages the latest stable, asks, and installs on Restart now", async (t) => {
  const h = launch(t, { running: "1.0.193-dev.45", channelFile: "dev", versions: { "orbit-releases": "1.0.192", Orbit: "1.0.193-dev.47" }, responses: [0] });
  assert.deepEqual(h.tasks, [[TASK]]);
  await h.api.updaterBridge.download();
  assert.deepEqual(h.updater.downloads, ["1.0.193-dev.47"]);

  await h.api.switchUpdateChannel("stable");
  assert.deepEqual(h.updater.downloads, ["1.0.193-dev.47", "1.0.192"]);
  assert.deepEqual(h.dialogs, [{ message: "Wink 1.0.192 is ready.", detail: "Restarting closes every pane.", buttons: ["Restart now", "Later"] }]);
  assert.deepEqual(h.quits, ["quit"]);
  assert.equal(h.api.consumePendingUpdateInstall(), true);
  assert.equal(updateChannel.readUpdateChannel(h.userData), "stable");
  // The task stays while the dev build runs, so Later or a failed install can try again.
  assert.deepEqual(h.tasks.at(-1), [TASK]);
});

test("back to stable while the stable feed is unreachable never offers the dev build seen before", async (t) => {
  const versions = { "orbit-releases": "1.0.192", Orbit: "1.0.193-dev.47" };
  const h = launch(t, { running: "1.0.193-dev.45", channelFile: "dev", versions, responses: [0] });
  await h.api.updaterBridge.check();
  assert.equal(h.status(), "available");

  versions["orbit-releases"] = new Error("offline");
  await h.api.switchUpdateChannel("stable");
  assert.deepEqual(h.updater.downloads, []);
  assert.deepEqual(h.dialogs, []);
  assert.deepEqual(h.quits, []);
});

test("back to stable during a dev download lets it land, then stages stable instead", async (t) => {
  const h = launch(t, { running: "1.0.193-dev.45", channelFile: "dev", versions: { "orbit-releases": "1.0.192", Orbit: "1.0.193-dev.47" }, responses: [0] });
  const transfer = deferred();
  h.updater.hold = transfer.promise;
  const download = h.api.updaterBridge.download();
  await flush();
  assert.equal(h.status(), "downloading");

  const back = h.api.switchUpdateChannel("stable");
  await flush();
  h.updater.hold = null;
  transfer.resolve();
  await Promise.all([download, back]);
  assert.deepEqual(h.updater.downloads, ["1.0.193-dev.47", "1.0.192"]);
  assert.equal(h.dialogs[0]?.message, "Wink 1.0.192 is ready.");
  assert.deepEqual(h.quits, ["quit"]);
});

test("the jump list task goes once a stable build runs on the stable channel", async (t) => {
  const onStable = launch(t, { running: "1.0.193", channelFile: "dev", versions: { "orbit-releases": "1.0.193", Orbit: "1.0.194-dev.1" } });
  assert.deepEqual(onStable.tasks, [[TASK]]);
  await onStable.api.switchUpdateChannel("stable");
  assert.deepEqual(onStable.tasks.at(-1), []);
  assert.deepEqual(onStable.dialogs, []);

  // The first launch after a rollback clears the task the dev build left behind.
  const afterRollback = launch(t, { channelFile: "stable", versions: { "orbit-releases": "1.0.192" } });
  assert.deepEqual(afterRollback.tasks, [[]]);
});

test("a channel flag that lands before the updater starts is applied once it does", async (t) => {
  const h = launch(t, { running: "1.0.193-dev.45", channelFile: "dev", versions: { "orbit-releases": "1.0.192", Orbit: "1.0.193-dev.47" }, responses: [0], early: ["dev", "stable"] });
  for (let i = 0; i < 10; i += 1) await flush();
  assert.equal(updateChannel.readUpdateChannel(h.userData), "stable");
  assert.deepEqual(h.updater.downloads, ["1.0.192"]);
  assert.equal(h.dialogs[0]?.message, "Wink 1.0.192 is ready.");
  assert.deepEqual(h.quits, ["quit"]);
});

test("joining dev during a stable check checks the dev feed once that check settles", async (t) => {
  const h = launch(t, { versions: { "orbit-releases": "1.0.192", Orbit: "1.0.193-dev.46" } });
  const stableCheck = deferred();
  h.updater.checkHold = stableCheck.promise;
  h.timers[0].callback();
  await flush();
  assert.equal(h.status(), "checking");

  const join = h.api.switchUpdateChannel("dev");
  await flush();
  h.updater.checkHold = null;
  stableCheck.resolve();
  await join;
  assert.deepEqual(h.probes, ["orbit-releases", "Orbit"]);
  assert.equal(h.status(), "available");
  assert.equal(h.api.updaterBridge.state().version, "1.0.193-dev.46");
});
