import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(options = {}) {
  const updater = new EventEmitter();
  // electron-updater has its own error listener; model that without routing it.
  updater.on("error", () => {});
  let state = { status: "idle" };
  const states = [];
  const coordinator = createUpdaterCoordinator(updater, (patch) => {
    state = { ...state, ...patch };
    states.push({ ...state });
  }, options);
  return { updater, coordinator, states, getState: () => state };
}

function errorStates(states) {
  return states.filter((entry) => entry.status === "error");
}

test("automatic check rejection is handled and returns to idle", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("offline"));

  await assert.doesNotReject(coordinator.check());

  assert.equal(getState().status, "idle");
});

test("manual check rejection is handled as a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("feed failed"));

  await assert.doesNotReject(coordinator.check(true));

  assert.deepEqual(getState(), { status: "error", message: "feed failed" });
});

test("download rejection is handled as a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.downloadUpdate = () => Promise.reject(new Error("download failed"));

  await assert.doesNotReject(coordinator.download());

  assert.deepEqual(getState(), { status: "error", message: "download failed" });
});

test("synchronous check and download throws are handled", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => {
    throw new Error("check threw");
  };

  await assert.doesNotReject(coordinator.check(true));
  assert.deepEqual(getState(), { status: "error", message: "check threw" });

  updater.downloadUpdate = () => {
    throw new Error("download threw");
  };

  await assert.doesNotReject(coordinator.download());
  assert.deepEqual(getState(), { status: "error", message: "download threw" });
});

test("a concurrent background check cannot downgrade a manual check", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  let calls = 0;
  updater.checkForUpdates = () => {
    calls += 1;
    return pending.promise;
  };

  const manual = coordinator.check(true);
  const background = coordinator.check();
  assert.strictEqual(background, manual);
  assert.equal(calls, 1);

  pending.reject(new Error("manual failure"));
  await manual;

  assert.deepEqual(getState(), { status: "error", message: "manual failure" });
});

test("a manual request during a background check preserves user-visible errors", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  let calls = 0;
  updater.checkForUpdates = () => {
    calls += 1;
    return pending.promise;
  };

  const background = coordinator.check();
  const manual = coordinator.check(true);
  assert.strictEqual(manual, background);
  assert.equal(calls, 1);

  pending.reject(new Error("background request failed"));
  await background;

  assert.deepEqual(getState(), { status: "error", message: "background request failed" });
});

test("download reports downloading before the first progress event", async () => {
  const { updater, coordinator, getState, states } = harness();
  const pending = deferred();
  // a real transfer stays silent until bytes arrive; the button must not wait
  updater.downloadUpdate = () => pending.promise;

  const download = coordinator.download();
  assert.deepEqual(getState(), { status: "downloading" });
  assert.equal(states[0].status, "downloading");

  updater.emit("download-progress", { percent: 12 });
  assert.deepEqual(getState(), { status: "downloading", percent: 12 });

  pending.resolve();
  await download;
});

test("downloaded waits for native staging to finish before becoming actionable", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  updater.downloadUpdate = () => pending.promise;

  const download = coordinator.download();
  updater.emit("update-downloaded", { version: "2.0.0" });
  assert.deepEqual(getState(), { status: "downloading" });

  pending.resolve(["update.zip"]);
  await download;
  assert.deepEqual(getState(), { status: "downloaded", version: "2.0.0" });
});

test("an asynchronous native install error escapes the restarting spinner", async () => {
  const { updater, coordinator, getState, states } = harness();
  const error = new Error("native staging failed");
  updater.quitAndInstall = () => updater.emit("error", error);

  await coordinator.install();

  assert.deepEqual(getState(), { status: "error", message: "native staging failed" });
  assert.equal(errorStates(states).length, 1);
});

test("a synchronous install failure becomes a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.quitAndInstall = () => {
    throw new Error("install threw");
  };

  await coordinator.install();

  assert.deepEqual(getState(), { status: "error", message: "install threw" });
});

test("install quits for cleanup instead of racing quitAndInstall", async () => {
  let quitCalls = 0;
  const { updater, coordinator, getState } = harness({
    quitForInstall: () => {
      quitCalls += 1;
    },
  });
  let installCalls = 0;
  updater.quitAndInstall = () => {
    installCalls += 1;
  };

  await coordinator.install();

  assert.equal(quitCalls, 1);
  assert.equal(installCalls, 0);
  assert.equal(getState().status, "installing");
});

test("an active download state survives a later background check failure", async () => {
  const { updater, coordinator, getState } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 42 });
    return downloadPending.promise;
  };

  const download = coordinator.download();
  await flush();
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  updater.checkForUpdates = () => {
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "2.1.0" });
    updater.emit("update-not-available");
    return checkPending.promise;
  };

  const background = coordinator.check();
  checkPending.reject(new Error("background check failed"));
  await background;
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  downloadPending.resolve();
  await download;
});

test("a download error remains authoritative after a later background failure", async () => {
  const { updater, coordinator, getState } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 75 });
    return downloadPending.promise;
  };

  const download = coordinator.download();
  await flush();
  updater.checkForUpdates = () => checkPending.promise;
  const background = coordinator.check();

  const downloadError = new Error("download failed first");
  downloadPending.reject(downloadError);
  await download;
  assert.deepEqual(getState(), {
    status: "error",
    percent: 75,
    message: "download failed first",
  });

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "2.1.0" });
  updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed later"));
  await background;

  assert.deepEqual(getState(), {
    status: "error",
    percent: 75,
    message: "download failed first",
  });
});

test("a background failure stays silent before a later download failure", async () => {
  const { updater, coordinator, getState, states } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.checkForUpdates = () => checkPending.promise;
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 18 });
    return downloadPending.promise;
  };

  const background = coordinator.check();
  const download = coordinator.download();

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "2.1.0" });
  updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed first"));
  await background;
  await flush();
  assert.deepEqual(getState(), { status: "downloading", percent: 18 });
  assert.equal(errorStates(states).length, 0);

  const downloadError = new Error("download failed later");
  downloadPending.reject(downloadError);
  await download;

  assert.deepEqual(getState(), {
    status: "error",
    percent: 18,
    message: "download failed later",
  });
});

test("available, not-available, progress, and downloaded events preserve success behavior", async () => {
  const available = harness();
  available.updater.checkForUpdates = () => {
    available.updater.emit("checking-for-update");
    queueMicrotask(() => available.updater.emit("update-available", { version: "2.0.0" }));
    return Promise.resolve({ isUpdateAvailable: true });
  };
  await available.coordinator.check(true);
  assert.equal(available.getState().status, "available");
  assert.equal(available.getState().version, "2.0.0");

  available.updater.downloadUpdate = () => {
    available.updater.emit("download-progress", { percent: 42.4 });
    return Promise.resolve().then(() => {
      available.updater.emit("update-downloaded", { version: "2.0.0" });
      return ["update.zip"];
    });
  };
  await available.coordinator.download();
  assert.deepEqual(available.getState(), {
    status: "downloaded",
    version: "2.0.0",
    message: undefined,
    percent: 42,
  });

  const notAvailable = harness();
  notAvailable.updater.checkForUpdates = () => {
    notAvailable.updater.emit("checking-for-update");
    notAvailable.updater.emit("update-not-available");
    return Promise.resolve({ isUpdateAvailable: false });
  };
  await notAvailable.coordinator.check();
  assert.equal(notAvailable.getState().status, "idle");
});

test("an updater error event and rejected promise produce one deterministic state", async () => {
  const check = harness();
  const checkError = new Error("check failed once");
  check.updater.checkForUpdates = () =>
    Promise.reject(checkError).catch((error) => {
      check.updater.emit("error", error);
      throw error;
    });

  await check.coordinator.check(true);
  assert.equal(errorStates(check.states).length, 1);
  assert.deepEqual(check.getState(), { status: "error", message: "check failed once" });

  const download = harness();
  const downloadError = new Error("download failed once");
  download.updater.downloadUpdate = () =>
    Promise.reject(downloadError).catch((error) => {
      download.updater.emit("error", error);
      throw error;
    });

  await download.coordinator.download();
  assert.equal(errorStates(download.states).length, 1);
  assert.deepEqual(download.getState(), { status: "error", message: "download failed once" });
});

function releaseFeed(updater, initialVersion) {
  const feed = { live: initialVersion, cached: null, checks: 0, downloads: 0 };
  updater.checkForUpdates = () => {
    feed.checks += 1;
    feed.cached = feed.live;
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: feed.live });
    return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: feed.live } });
  };
  updater.downloadUpdate = () => {
    feed.downloads += 1;
    updater.emit("update-downloaded", { version: feed.cached });
    return Promise.resolve([`${feed.cached}.exe`]);
  };
  return feed;
}

test("download re-checks so a stale check still gets the newest release", async () => {
  const { updater, coordinator, getState } = harness();
  const feed = releaseFeed(updater, "1.0.93");
  await coordinator.check(true);
  assert.deepEqual(getState(), { status: "available", version: "1.0.93", message: undefined });

  feed.live = "1.0.94";
  await coordinator.download();

  assert.equal(feed.checks, 2);
  assert.equal(getState().status, "downloaded");
  assert.equal(getState().version, "1.0.94");
});

test("download falls back to the cached release when the re-check fails", async () => {
  const { updater, coordinator, getState, states } = harness();
  const feed = releaseFeed(updater, "1.0.93");
  await coordinator.check(true);

  const checkError = new Error("feed offline");
  updater.checkForUpdates = () => {
    updater.emit("error", checkError);
    return Promise.reject(checkError);
  };
  await coordinator.download();

  assert.equal(errorStates(states).length, 0);
  assert.equal(feed.downloads, 1);
  assert.equal(getState().status, "downloaded");
  assert.equal(getState().version, "1.0.93");
});

test("install downloads and installs a newer release that went live", async () => {
  let quitCalls = 0;
  const { updater, coordinator, getState, states } = harness({
    quitForInstall: () => {
      quitCalls += 1;
    },
  });
  const feed = releaseFeed(updater, "1.0.93");
  await coordinator.check(true);
  await coordinator.download();
  assert.equal(getState().version, "1.0.93");

  feed.live = "1.0.94";
  await coordinator.install();

  assert.equal(feed.downloads, 2);
  assert.equal(quitCalls, 1);
  assert.deepEqual(getState(), { status: "installing", version: "1.0.94", message: undefined });
  assert.ok(states.some((entry) => entry.status === "downloaded" && entry.version === "1.0.94"));
});

test("install keeps the downloaded release when nothing newer is live", async () => {
  let quitCalls = 0;
  const { updater, coordinator } = harness({
    quitForInstall: () => {
      quitCalls += 1;
    },
  });
  const feed = releaseFeed(updater, "1.0.94");
  await coordinator.check(true);
  await coordinator.download();

  await coordinator.install();

  assert.equal(feed.downloads, 1);
  assert.equal(quitCalls, 1);
});

test("install falls back to the downloaded release when the re-check fails", async () => {
  let quitCalls = 0;
  const { updater, coordinator, getState, states } = harness({
    quitForInstall: () => {
      quitCalls += 1;
    },
  });
  releaseFeed(updater, "1.0.94");
  await coordinator.check(true);
  await coordinator.download();

  const checkError = new Error("feed offline");
  updater.checkForUpdates = () => {
    updater.emit("error", checkError);
    return Promise.reject(checkError);
  };
  await coordinator.install();

  assert.equal(quitCalls, 1);
  assert.equal(getState().status, "installing");
  assert.equal(errorStates(states).length, 0);
});
