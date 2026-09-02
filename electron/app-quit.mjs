/** Finish Electron's deferred quit. `quitAndInstall` must not run until
 * `before-quit` cleanup has completed: NSIS otherwise races the still-running
 * exe, and `preventDefault` would drop the install if we called it first. */
export function completeQuitAfterCleanup({ pendingUpdateInstall, quitAndInstall, quit }) {
  if (pendingUpdateInstall) {
    try {
      const started = quitAndInstall();
      if (started === false) {
        quit();
        return "quit";
      }
      return "install";
    } catch {
      quit();
      return "quit";
    }
  }
  quit();
  return "quit";
}

/** Vendored `BaseUpdater.quitAndInstall` reports install() failures by
 * emitting `error` and returning, without throwing. */
export function callQuitAndInstall(updater) {
  let failed = false;
  const onError = () => {
    failed = true;
  };
  updater.once("error", onError);
  try {
    updater.quitAndInstall(true, true);
  } finally {
    updater.removeListener("error", onError);
  }
  return !failed;
}
