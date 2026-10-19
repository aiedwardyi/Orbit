import fs from "node:fs";
import path from "node:path";
import { isNewerVersion } from "./updater-coordinator.mjs";

const FILE = "update-channel.json";
const CHANNELS = ["stable", "dev"];
// The same feed electron-builder.yml writes into app-update.yml. Channel says
// "latest" because the updater's channel can never return to null once set.
const STABLE = Object.freeze({
  feed: Object.freeze({ provider: "github", owner: "aiedwardyi", repo: "orbit-releases" }),
  channel: "latest",
  allowPrerelease: false,
  allowDowngrade: false,
});
const DEV = Object.freeze({
  feed: Object.freeze({ provider: "github", owner: "aiedwardyi", repo: "Orbit" }),
  channel: "dev",
  allowPrerelease: true,
  allowDowngrade: false,
});

export function channelPath(userDataDir) {
  return path.join(userDataDir, FILE);
}

export function readUpdateChannel(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(channelPath(userDataDir), "utf8"));
    if (CHANNELS.includes(parsed?.channel)) return parsed.channel;
  } catch {
    /* missing or unreadable - stable */
  }
  return "stable";
}

export function writeUpdateChannel(userDataDir, channel) {
  if (!CHANNELS.includes(channel)) return readUpdateChannel(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(channelPath(userDataDir), `${JSON.stringify({ channel })}\n`, "utf8");
  return channel;
}

export function channelFromCommandLine(argv) {
  for (const value of argv) {
    const match = /^--update-channel=(dev|stable)$/.exec(value);
    if (match) return match[1];
  }
  return null;
}

// electron-updater allows prereleases for any prerelease build, so all of them count.
export function isDevBuild(version) {
  return /^\d+\.\d+\.\d+-/.test(String(version));
}

/** The feed for the next check, or null to leave the updater as app-update.yml set it. */
export function pickFeed({ platform, channel, running, stable, dev }) {
  if (platform !== "win32") return null;
  if (channel !== "dev") return isDevBuild(running) ? { ...STABLE, allowDowngrade: true } : null;
  if (stable && isNewerVersion(stable, running) && (!dev || isNewerVersion(stable, dev))) return STABLE;
  return DEV;
}

export function applyFeed(updater, choice) {
  updater.setFeedURL(choice.feed);
  updater.channel = choice.channel;
  updater.allowPrerelease = choice.allowPrerelease;
  // After channel: its setter turns allowDowngrade on.
  updater.allowDowngrade = choice.allowDowngrade;
}

/** Stands in for the updater the coordinator drives, so each check follows this PC's channel. */
export function createChannelUpdater(updater, { platform, running, channel, probe }) {
  let switched = false;
  let settled = Promise.resolve();
  let offered = null;
  const versionOf = (choice) => Promise.resolve().then(() => probe(choice)).catch(() => null);

  async function switchedCheck() {
    switched = true;
    const current = channel();
    const [stable, dev] = current === "dev" ? await Promise.all([versionOf(STABLE), versionOf(DEV)]) : [];
    // Once switched there is no untouched updater to go back to, so stable is set explicitly.
    applyFeed(updater, pickFeed({ platform, channel: current, running, stable, dev }) ?? STABLE);
    const result = await updater.checkForUpdates();
    if (result?.isUpdateAvailable) offered = result.updateInfo?.version;
    return result;
  }

  return {
    on: (event, listener) => updater.on(event, listener),
    downloadUpdate() {
      // After a failed check electron-updater still downloads its last offer, maybe a dev build from before the switch.
      if (channel() !== "dev" && isDevBuild(offered)) return Promise.reject(new Error("Couldn't check the stable release. Try again."));
      return updater.downloadUpdate();
    },
    checkForUpdates() {
      const result = switched || pickFeed({ platform, channel: channel(), running })
        ? settled.then(switchedCheck)
        : updater.checkForUpdates();
      // A check during another one gets that one's promise, so a switch waits for it to settle.
      settled = Promise.resolve(result).catch(() => {});
      return result;
    },
  };
}

export function registerChannelIpc(ipcMain, { channel, backToStable }) {
  ipcMain.handle("update:get-channel", () => channel());
  ipcMain.handle("update:set-channel", (_event, next) => {
    // Joining dev takes a launch flag, so no page can opt a PC in.
    if (next !== "stable") throw new Error("Only the stable channel can be set from the app");
    return backToStable();
  });
}
