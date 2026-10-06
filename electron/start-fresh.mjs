import fs from "node:fs";
import path from "node:path";

const DESKTOP_FILES = [
  "credentials.bin", "locale-preference.json", "skin-preference.json", "window-state.json", "companion-settings.json",
  "cua-local-control.json",
];
const DELAYS = [100, 200, 400, 800];

export function resetMarkerPath(dataDir) {
  return `${path.resolve(dataDir)}-reset.json`;
}

function unusedPath(base) {
  let candidate = base;
  for (let suffix = 1; fs.existsSync(candidate); suffix++) candidate = `${base}-${suffix}`;
  return candidate;
}

// Startup reads unreadable sync settings as defaults; a reset must not trip on them either.
function syncFolderOf(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "profile-sync.json"), "utf8"))?.folder;
  } catch {
    return undefined;
  }
}

function contains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function requestStartFresh({ dataDir, now = new Date() }) {
  const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("")
    + "-" + [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
  const backup = unusedPath(`${path.resolve(dataDir)}-backup-${stamp}`);
  const desktopState = path.basename(unusedPath(path.join(dataDir, "desktop-state")));
  fs.writeFileSync(resetMarkerPath(dataDir), JSON.stringify({ backup, desktopState }), { flag: "wx", mode: 0o600 });
}

export async function applyStartFresh({
  dataDir, userData, clearUiState,
  rename = fs.renameSync,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const marker = resetMarkerPath(dataDir);
  if (!fs.existsSync(marker)) return { status: "none" };
  const plan = JSON.parse(fs.readFileSync(marker, "utf8"));
  const { backup, desktopState } = plan;
  if (!backup.startsWith(`${path.resolve(dataDir)}-backup-`) || path.dirname(backup) !== path.dirname(path.resolve(dataDir))
    || path.basename(desktopState) !== desktopState) throw new Error("Invalid reset marker");
  const staged = path.join(dataDir, desktopState);
  const userDataInside = contains(dataDir, userData);
  const retryRename = async (from, to) => {
    for (let attempt = 0; ; attempt++) {
      try { rename(from, to); return; } catch (error) {
        if (attempt === DELAYS.length) throw error;
        await sleep(DELAYS[attempt]);
      }
    }
  };
  const restore = async () => {
    if (!userDataInside && fs.existsSync(staged)) {
      for (const name of DESKTOP_FILES) {
        const saved = path.join(staged, name);
        if (!fs.existsSync(saved)) continue;
        const original = path.join(userData, name);
        if (fs.existsSync(original)) throw new Error("Cannot overwrite desktop state during reset recovery");
        await retryRename(saved, original);
      }
      fs.rmdirSync(staged);
    }
    fs.unlinkSync(marker);
  };
  if (plan.restoring) {
    await restore();
    return { status: "failed" };
  }
  // A crash after the folder rename resumes UI cleanup, never a second reset.
  if (fs.existsSync(dataDir) || !fs.existsSync(backup)) {
    try {
      if (fs.existsSync(backup)) throw new Error("Reset backup already exists");
      if (fs.existsSync(dataDir) && fs.lstatSync(dataDir).isSymbolicLink()) throw new Error("Cannot reset a linked data folder");
      const folder = syncFolderOf(dataDir);
      if (folder && fs.existsSync(folder)) {
        const syncFolder = fs.realpathSync(folder);
        const dataFolder = fs.realpathSync(dataDir);
        if (contains(dataFolder, syncFolder) || contains(syncFolder, dataFolder)) throw new Error("Data and sync folders overlap");
      }
      fs.mkdirSync(dataDir, { recursive: true });
      if (!userDataInside) {
        fs.mkdirSync(staged, { recursive: true });
        for (const name of DESKTOP_FILES) {
          const original = path.join(userData, name);
          if (!fs.existsSync(original)) continue;
          const saved = path.join(staged, name);
          if (fs.existsSync(saved)) throw new Error("Desktop backup already exists");
          await retryRename(original, saved);
        }
      }
      await retryRename(dataDir, backup);
    } catch (error) {
      fs.writeFileSync(marker, JSON.stringify({ ...plan, restoring: true }), { mode: 0o600 });
      await restore();
      return { status: "failed", error: String(error) };
    }
  }
  await clearUiState();
  fs.unlinkSync(marker);
  return { status: "reset", backup };
}
