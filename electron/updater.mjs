// In-app auto-updater (electron-updater). Downloads are user-driven; macOS
// stages the downloaded ZIP immediately and the explicit restart applies it.
// One state object is broadcast on every transition.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, dialog, ipcMain } from "electron";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { callQuitAndInstall } from "./app-quit.mjs";
import { channelPath, createChannelUpdater, isDevBuild, readUpdateChannel, registerChannelIpc, writeUpdateChannel } from "./update-channel.mjs";
import { ERROR_SITES } from "../shared/error-report.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | downloaded | installing | error
let state = { status: "idle" };
let updaterCoordinator = null;
let pendingUpdateInstall = false;
let stateListener = null;
// stable | dev; only Windows reads update-channel.json
let channel = "stable";
let checkTimer = null;
let leavingDev = null;
let nativeText = null;
let pendingChannel = null;
let errorReport = () => {};

export function onUpdaterFailure(capture) {
  errorReport = capture;
}

export function consumePendingUpdateInstall() {
  const pending = pendingUpdateInstall;
  pendingUpdateInstall = false;
  return pending;
}

export function applyPendingUpdateInstall() {
  if (!autoUpdater) throw new Error("updater unavailable");
  return callQuitAndInstall(autoUpdater);
}

function updaterLogger() {
  const directory = app.getPath("logs");
  const file = join(directory, "updater.log");
  const write = (level, values) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const message = values
        .map((value) => (value instanceof Error ? value.stack ?? value.message : String(value)))
        .join(" ");
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`, { mode: 0o600 });
    } catch {
      // Logging must never make updating unavailable.
    }
  };
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...values) => write(level, values)]));
}

function setState(patch) {
  state = { ...state, ...patch };
  try {
    win?.webContents?.send("update:state", state);
  } catch {
    /* window gone */
  }
  try {
    stateListener?.(updaterBridge.state());
  } catch {
    /* server gone */
  }
}

export function onUpdaterState(listener) {
  stateListener = listener;
}

/** The updater as the loopback bridge serves it to remote clients. */
export const updaterBridge = {
  state: () => ({ ...state, appVersion: app.getVersion() }),
  check: () => updaterCoordinator?.check(true),
  download: () => updaterCoordinator?.download(),
  install: () => updaterCoordinator?.install(),
};

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:check", () => updaterCoordinator?.check(true));
  ipcMain.handle("update:download", () => updaterCoordinator?.download());
  ipcMain.handle("update:install", () => updaterCoordinator?.install());
  registerChannelIpc(ipcMain, { channel: () => channel, backToStable: () => switchUpdateChannel("stable") });
}

export function retargetUpdater(mainWindow) {
  win = mainWindow;
}

/** Moves this PC to a channel. Leaving dev stages the latest stable and asks before restarting. */
export async function switchUpdateChannel(next) {
  if (process.platform !== "win32") return;
  // A jump list click can land while the app is still starting; startUpdater applies it.
  if (!updaterCoordinator) {
    pendingChannel = next;
    return;
  }
  try {
    channel = writeUpdateChannel(app.getPath("userData"), next);
    scheduleChecks();
    syncJumpList();
    if (channel === "dev") {
      await updaterCoordinator.check(true, true);
      return;
    }
    // A second click while one is staging joins it instead of stacking prompts.
    leavingDev ??= stageStable().finally(() => {
      leavingDev = null;
    });
    await leavingDev;
  } catch (error) {
    errorReport({ process: "main", code: "UPDATE_FAILED", site: ERROR_SITES.updaterChannel });
    autoUpdater.logger.error(`update channel switch failed: ${error?.stack ?? error}`);
  }
}

async function stageStable() {
  // reset refuses mid-download, so a download in flight lands first and is then dropped.
  if (state.status === "downloading") await updaterCoordinator.download();
  // Still refused means an install is under way; the jump list task can be clicked again.
  if (!updaterCoordinator.reset()) return;
  await updaterCoordinator.download();
  if (state.status !== "downloaded") return;
  const parent = win && !win.isDestroyed() ? win : undefined;
  const { response } = await dialog.showMessageBox(parent, {
    type: "none",
    message: nativeText("update.ready", { version: state.version }),
    detail: nativeText("update.restartDetail"),
    buttons: [nativeText("update.restartNow"), nativeText("update.later")],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) await updaterCoordinator.install();
}

// The renderer may be what broke, so the way back lives in the taskbar jump list.
function syncJumpList() {
  const title = nativeText("update.backToStable");
  const wanted = channel === "dev" || isDevBuild(app.getVersion());
  app.setUserTasks(wanted ? [{ program: process.execPath, arguments: "--update-channel=stable", iconPath: process.execPath, iconIndex: 0, title, description: title }] : []);
}

function scheduleChecks() {
  clearInterval(checkTimer);
  // Dev builds land after every green merge; stable releases a few times a day.
  checkTimer = setInterval(() => void updaterCoordinator?.check(), (channel === "dev" ? 10 : 60) * 60 * 1000);
  checkTimer.unref?.();
}

function probeFeed(choice) {
  const { NsisUpdater } = require("./vendor/electron-updater.cjs");
  const probe = new NsisUpdater(choice.feed);
  // Defaults to true, and a probe only reads the feed's newest version.
  probe.autoDownload = false;
  probe.logger = null;
  probe.channel = choice.channel;
  probe.allowPrerelease = choice.allowPrerelease;
  return probe.checkForUpdates().then((result) => result?.updateInfo?.version);
}

export function startUpdater(mainWindow, text) {
  win = mainWindow;
  nativeText = text;
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!app.isPackaged) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    errorReport({ process: "main", code: "UPDATE_UNAVAILABLE", site: ERROR_SITES.updaterUnavailable });
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = false; // button-driven download
  // Squirrel.Mac has a second, native staging pass after the ZIP download.
  // Start it immediately so "Restart to update" never has to begin that slow
  // pass and wait indefinitely. Windows keeps the explicit installer click.
  autoUpdater.autoInstallOnAppQuit = process.platform === "darwin";
  autoUpdater.logger = updaterLogger();

  const userData = app.getPath("userData");
  if (process.platform === "win32") channel = readUpdateChannel(userData);
  const updater = createChannelUpdater(autoUpdater, {
    platform: process.platform,
    running: app.getVersion(),
    channel: () => channel,
    probe: probeFeed,
  });
  updaterCoordinator = createUpdaterCoordinator(updater, setState, {
    onFailure: () => errorReport({ process: "main", code: "UPDATE_FAILED", site: ERROR_SITES.updaterFailure }),
    quitForInstall: () => {
      pendingUpdateInstall = true;
      app.quit();
    },
  });
  // A PC that never chose a channel and runs a stable build leaves the jump list alone.
  if (process.platform === "win32" && (isDevBuild(app.getVersion()) || existsSync(channelPath(userData)))) syncJumpList();

  // first check ~15s after launch (let the app settle), then on the channel's
  // interval - both silent on failure, hence the arrow: a bare `check` would
  // receive the timer's argument as `manual` and start reporting errors again.
  setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
  scheduleChecks();
  if (pendingChannel) {
    const next = pendingChannel;
    pendingChannel = null;
    void switchUpdateChannel(next);
  }
}
