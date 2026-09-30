function versionParts(version) {
  const [core, pre = ""] = String(version ?? "").split(/-(.*)/s);
  return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
}

/** True when `candidate` is a later release than `current`; a prerelease sorts before its release. */
export function isNewerVersion(candidate, current) {
  if (!current) return true;
  const a = versionParts(candidate);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i += 1) {
    const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (diff) return diff > 0;
  }
  if (a.pre === b.pre) return false;
  if (!a.pre || !b.pre) return !a.pre;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

export function createUpdaterCoordinator(updater, setState, { quitForInstall } = {}) {
  let checkOperation = null;
  let downloadOperation = null;
  let installOperation = null;
  let downloadedVersion = null;
  let rechecks = 0;
  const routedErrors = new WeakSet();

  const routeError = (manual, error) => {
    if (error instanceof Error) routedErrors.add(error);
    if (downloadOperation) downloadOperation.failed = true;
    if (checkOperation) checkOperation.failed = true;
    if (installOperation) {
      installOperation.failed = true;
      clearTimeout(installOperation.timer);
      installOperation = null;
    }
    if (!manual) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "error", message: String(error?.message ?? error) });
  };

  function handleRejectedOperation(manual, error) {
    if (error instanceof Error && routedErrors.has(error)) return;
    routeError(manual, error);
  }

  function checkOwnsState() {
    return !rechecks && !downloadOperation && !checkOperation?.supersededByDownload;
  }

  updater.on("checking-for-update", () => {
    if (checkOwnsState()) setState({ status: "checking" });
  });
  updater.on("update-available", (info) => {
    if (checkOwnsState()) {
      setState({ status: "available", version: info?.version, message: undefined });
    }
  });
  updater.on("update-not-available", () => {
    if (checkOwnsState()) setState({ status: "idle" });
  });
  // downloadUpdate/checkForUpdates reject after most updater errors, but the
  // macOS native staging pass used by quitAndInstall is event-only. Without
  // this listener a Squirrel.Mac failure leaves the renderer on "Restarting"
  // forever because quitAndInstall itself returns void.
  updater.on("error", (error) => {
    // A failed re-check falls back to the known release instead of failing the click.
    if (rechecks) return;
    const manual = Boolean(installOperation || downloadOperation || checkOperation?.manual);
    routeError(manual, error);
  });
  updater.on("download-progress", (progress) =>
    setState({ status: "downloading", percent: Math.round(progress?.percent ?? 0) }),
  );
  updater.on("update-downloaded", (info) => {
    downloadedVersion = info?.version;
    // On macOS electron-updater emits this before Squirrel.Mac has finished
    // staging the ZIP. Keep the UI in downloading until downloadUpdate's
    // promise resolves, which is the point the native updater is ready.
    if (downloadOperation) {
      downloadOperation.downloadedInfo = info;
      return;
    }
    setState({ status: "downloaded", version: info?.version });
  });

  function check(manual = false) {
    if (checkOperation) {
      // A manual caller upgrades the shared operation; a timer never downgrades it.
      if (manual) checkOperation.manual = true;
      return checkOperation.promise;
    }

    const operation = { manual, supersededByDownload: Boolean(downloadOperation), failed: false, promise: null };
    checkOperation = operation;
    try {
      operation.promise = Promise.resolve(updater.checkForUpdates())
        .catch((error) => {
          if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
        })
        .finally(() => {
          if (checkOperation === operation) checkOperation = null;
        });
    } catch (error) {
      if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
      checkOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  // downloadUpdate acts on the last check's result, which can be an hour stale.
  // Resolves null when the re-check failed, so callers fall back to the known release.
  function recheck() {
    if (checkOperation) checkOperation.supersededByDownload = true;
    rechecks += 1;
    let promise;
    try {
      promise = Promise.resolve(updater.checkForUpdates());
    } catch {
      promise = Promise.resolve(null);
    }
    return promise
      .catch(() => null)
      .finally(() => {
        rechecks -= 1;
      });
  }

  function download() {
    if (checkOperation) checkOperation.supersededByDownload = true;
    if (downloadOperation) return downloadOperation.promise;

    const operation = { downloadedInfo: null, failed: false, promise: null };
    downloadOperation = operation;
    // Own the state before the request goes out: the first "download-progress"
    // can be seconds away (connection setup, redirects), and until then the
    // renderer would still show an untouched "Download" button. No percent yet
    // — the UI reads a missing percent as "starting".
    setState({ status: "downloading" });
    operation.promise = recheck()
      .then((check) => {
        if (check && !check.isUpdateAvailable) {
          // The feed withdrew the release: the updater's cached metadata must not be downloaded.
          setState({ status: "idle" });
          return undefined;
        }
        const latest = check?.updateInfo?.version;
        if (downloadedVersion && latest && !isNewerVersion(latest, downloadedVersion)) {
          setState({ status: "downloaded", version: downloadedVersion });
          return undefined;
        }
        return updater.downloadUpdate();
      })
      .then((result) => {
        if (!operation.failed && operation.downloadedInfo) {
          setState({ status: "downloaded", version: operation.downloadedInfo?.version });
        }
        return result;
      })
      .catch((error) => handleRejectedOperation(true, error))
      .finally(() => {
        if (downloadOperation === operation) downloadOperation = null;
      });
    return operation.promise;
  }

  function install() {
    if (installOperation) return installOperation.promise;
    const operation = { failed: false, timer: null, promise: null };
    installOperation = operation;
    setState({ status: "installing" });
    operation.promise = recheck().then((result) => {
      if (installOperation !== operation) return;
      if (result && !result.isUpdateAvailable) {
        installOperation = null;
        setState({ status: "idle" });
        return;
      }
      const latest = result?.isUpdateAvailable ? result.updateInfo?.version : undefined;
      if (!latest || !isNewerVersion(latest, downloadedVersion)) return quit(operation);
      // A newer release went live after this one downloaded: fetch it, then install that.
      installOperation = null;
      return download().then(() => {
        if (downloadedVersion === latest) return install();
      });
    });
    return operation.promise;
  }

  function quit(operation) {
    try {
      // Windows NSIS (and any before-quit preventDefault cleanup) must run
      // *before* quitAndInstall spawns the installer. The app quit path
      // calls quitAndInstall only after that cleanup settles.
      if (typeof quitForInstall === "function") quitForInstall();
      else updater.quitAndInstall(true, true);
    } catch (error) {
      routeError(true, error);
      return;
    }
    // quitAndInstall is void. If neither a quit nor an updater error arrives,
    // recover the UI instead of spinning for the lifetime of the process.
    if (installOperation === operation) {
      operation.timer = setTimeout(() => {
        if (installOperation !== operation) return;
        installOperation = null;
        setState({ status: "error", message: "The update could not be staged. Quit the app and try again." });
      }, 2 * 60 * 1000);
      operation.timer.unref?.();
    }
  }

  return { check, download, install };
}
