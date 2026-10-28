import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import {
  applyFeed,
  channelFromCommandLine,
  createChannelUpdater,
  isDevBuild,
  pickFeed,
  readUpdateChannel,
  registerChannelIpc,
  writeUpdateChannel,
} from "./update-channel.mjs";

const STABLE_FEED = { provider: "github", owner: "aiedwardyi", repo: "orbit-releases" };
const DEV_FEED = { provider: "github", owner: "aiedwardyi", repo: "Wink" };
const toStable = (allowDowngrade) => ({ feed: STABLE_FEED, channel: "latest", allowPrerelease: false, allowDowngrade });
const toDev = { feed: DEV_FEED, channel: "dev", allowPrerelease: true, allowDowngrade: false };
const onDev = { repo: "Wink", channel: "dev", allowPrerelease: true, allowDowngrade: false };
const onStable = { repo: "orbit-releases", channel: "latest", allowPrerelease: false, allowDowngrade: false };

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

function userData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-channel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Like the vendored AppUpdater, setting channel turns allowDowngrade on (vendor:14085-14095).
class FakeUpdater extends EventEmitter {
  feeds = [];
  checks = [];
  answers = [];
  allowPrerelease = false;
  allowDowngrade = false;
  #channel = null;

  get channel() {
    return this.#channel;
  }

  set channel(value) {
    this.#channel = value;
    this.allowDowngrade = true;
  }

  setFeedURL(options) {
    this.feeds.push(options);
  }

  checkForUpdates() {
    const { channel, allowPrerelease, allowDowngrade } = this;
    this.checks.push({ repo: this.feeds.at(-1)?.repo, channel, allowPrerelease, allowDowngrade });
    return this.answers.shift() ?? Promise.resolve({ isUpdateAvailable: false });
  }
}

function channelUpdater(updater, { running = "1.0.193-dev.45", channel = () => "dev", versions = {}, probe } = {}) {
  return createChannelUpdater(updater, {
    platform: "win32",
    running,
    channel,
    probe: probe ?? (async (choice) => versions[choice.feed.repo]),
  });
}

test("a missing or unreadable channel file reads stable", (t) => {
  const dir = userData(t);
  assert.equal(readUpdateChannel(dir), "stable");
  for (const body of ["", "{", "null", '"dev"', '{"channel":"beta"}', '{"channel":["dev"]}']) {
    fs.writeFileSync(path.join(dir, "update-channel.json"), body);
    assert.equal(readUpdateChannel(dir), "stable", body);
  }
});

test("the channel file keeps dev or stable and ignores anything else", (t) => {
  const dir = path.join(userData(t), "userData");
  writeUpdateChannel(dir, "dev");
  assert.equal(readUpdateChannel(dir), "dev");
  writeUpdateChannel(dir, "beta");
  assert.equal(readUpdateChannel(dir), "dev");
  writeUpdateChannel(dir, "stable");
  assert.equal(readUpdateChannel(dir), "stable");
});

test("a write that dies midway leaves the old channel file intact", (t) => {
  const dir = userData(t);
  writeUpdateChannel(dir, "dev");
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file) => {
    write(file, "{");
    throw new Error("disk full");
  });
  assert.throws(() => writeUpdateChannel(dir, "stable"), /disk full/);
  t.mock.restoreAll();
  assert.equal(readUpdateChannel(dir), "dev");
});

test("only --update-channel=dev or =stable picks a channel from the command line", () => {
  assert.equal(channelFromCommandLine(["Orbit.exe", "--update-channel=dev"]), "dev");
  assert.equal(channelFromCommandLine(["Orbit.exe", "--allow-file-access-from-files", "--update-channel=stable"]), "stable");
  for (const value of ["--update-channel=beta", "--update-channel=", "--update-channel", "--update-channel=Dev", "--update-channel=stable ", "-update-channel=dev", "orbit://update-channel=dev"]) {
    assert.equal(channelFromCommandLine(["Orbit.exe", value]), null, value);
  }
  assert.equal(channelFromCommandLine(["Orbit.exe", "--update-channel", "dev"]), null);
  assert.equal(channelFromCommandLine(["Orbit.exe"]), null);
});

test("any prerelease version is a dev build", () => {
  assert.equal(isDevBuild("1.0.193-dev.45"), true);
  assert.equal(isDevBuild("1.0.193-beta.1"), true);
  assert.equal(isDevBuild("1.0.192"), false);
  assert.equal(isDevBuild("1.0.192+build.5"), false);
  assert.equal(isDevBuild(""), false);
  assert.equal(isDevBuild(undefined), false);
});

test("a stable PC on a stable build gets no feed, so the updater runs as before", () => {
  assert.equal(pickFeed({ platform: "win32", channel: "stable", running: "1.0.192" }), null);
});

test("pickFeed covers every row of the channel table", () => {
  const rows = [
    // Stable channel on a dev build: the latest stable, as a downgrade.
    [{ channel: "stable", running: "1.0.193-dev.45" }, toStable(true)],
    [{ channel: "stable", running: "1.0.193-dev.45", stable: "1.0.193", dev: "1.0.194-dev.1" }, toStable(true)],
    // Dev channel with a stable release newer than this build and every dev build.
    [{ channel: "dev", running: "1.0.193-dev.45", stable: "1.0.193", dev: "1.0.193-dev.46" }, toStable(false)],
    [{ channel: "dev", running: "1.0.192", stable: "1.0.193", dev: "1.0.193-dev.46" }, toStable(false)],
    [{ channel: "dev", running: "1.0.193-dev.45", stable: "1.0.193", dev: null }, toStable(false)],
    // Dev channel otherwise.
    [{ channel: "dev", running: "1.0.193-dev.45", stable: "1.0.192", dev: "1.0.193-dev.46" }, toDev],
    [{ channel: "dev", running: "1.0.192", stable: "1.0.192", dev: "1.0.193-dev.46" }, toDev],
    [{ channel: "dev", running: "1.0.193", stable: "1.0.193", dev: "1.0.193-dev.46" }, toDev],
    [{ channel: "dev", running: "1.0.192", stable: "1.0.193", dev: "1.0.194-dev.1" }, toDev],
    [{ channel: "dev", running: "1.0.193-dev.45", stable: null, dev: "1.0.193-dev.46" }, toDev],
    [{ channel: "dev", running: "1.0.193-dev.45", stable: "1.0.192", dev: null }, toDev],
    [{ channel: "dev", running: "1.0.193-dev.45", stable: null, dev: null }, toDev],
  ];
  for (const [row, want] of rows) assert.deepEqual(pickFeed({ platform: "win32", ...row }), want, JSON.stringify(row));
  for (const platform of ["darwin", "linux"]) {
    assert.equal(pickFeed({ platform, channel: "stable", running: "1.0.193-dev.45" }), null, platform);
    assert.equal(pickFeed({ platform, channel: "dev", running: "1.0.192", stable: "1.0.193", dev: "1.0.194-dev.1" }), null, platform);
  }
});

test("the stable feed is the one electron-builder publishes releases to", () => {
  const builder = fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const [, provider, owner, repo] = builder.match(/^publish:\n  - provider: (\S+)\n    owner: (\S+)\n    repo: (\S+)$/m) ?? [];
  assert.deepEqual(pickFeed({ platform: "win32", channel: "stable", running: "1.0.193-dev.45" }).feed, { provider, owner, repo });
});

test("applyFeed points the updater at the dev feed with downgrades still off", () => {
  const updater = new FakeUpdater();
  applyFeed(updater, pickFeed({ platform: "win32", channel: "dev", running: "1.0.193-dev.45" }));
  assert.deepEqual(updater.feeds, [{ provider: "github", owner: "aiedwardyi", repo: "Wink" }]);
  assert.equal(updater.channel, "dev");
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
});

test("applyFeed takes a dev build back to the stable feed without prereleases", () => {
  const updater = new FakeUpdater();
  // A dev build starts with prereleases allowed (vendor:14196).
  updater.allowPrerelease = true;
  applyFeed(updater, pickFeed({ platform: "win32", channel: "stable", running: "1.0.193-dev.45" }));
  assert.deepEqual(updater.feeds, [{ provider: "github", owner: "aiedwardyi", repo: "orbit-releases" }]);
  assert.equal(updater.channel, "latest");
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, true);
});

// Records every property read and write the coordinator makes on the updater.
function recordingUpdater() {
  const calls = [];
  const updater = new EventEmitter();
  updater.checkForUpdates = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "1.0.193" } });
  updater.downloadUpdate = () => {
    updater.emit("update-downloaded", { version: "1.0.193" });
    return Promise.resolve([]);
  };
  const recorded = new Proxy(updater, {
    get(target, key) {
      calls.push(`get ${String(key)}`);
      return target[key];
    },
    set(target, key, value) {
      calls.push(`set ${String(key)}`);
      target[key] = value;
      return true;
    },
  });
  return { updater: recorded, calls };
}

test("a PC that never leaves stable makes exactly today's updater calls", async () => {
  const run = async (wrap) => {
    const { updater, calls } = recordingUpdater();
    const coordinator = createUpdaterCoordinator(wrap(updater), () => {}, { quitForInstall: () => {} });
    await coordinator.check(true);
    await coordinator.download();
    await coordinator.install();
    return calls;
  };
  const today = await run((updater) => updater);
  assert.ok(today.includes("get checkForUpdates"));
  assert.ok(today.includes("get downloadUpdate"));
  for (const [platform, channel, running] of [["win32", "stable", "1.0.192"], ["darwin", "dev", "1.0.192"], ["linux", "stable", "1.0.193-dev.45"]]) {
    const probes = [];
    const calls = await run((updater) => createChannelUpdater(updater, { platform, running, channel: () => channel, probe: (choice) => probes.push(choice) }));
    assert.deepEqual(calls, today, platform);
    assert.deepEqual(probes, [], platform);
  }
});

test("a dev PC probes both feeds and checks the dev feed when a dev build is newest", async () => {
  const updater = new FakeUpdater();
  const probed = [];
  const versions = { "orbit-releases": "1.0.192", Wink: "1.0.193-dev.46" };
  await channelUpdater(updater, {
    probe: async (choice) => {
      probed.push(choice);
      return versions[choice.feed.repo];
    },
  }).checkForUpdates();
  assert.deepEqual(probed, [toStable(false), toDev]);
  assert.deepEqual(updater.checks, [onDev]);
});

test("a dev PC takes a stable release newer than every dev build", async () => {
  const updater = new FakeUpdater();
  await channelUpdater(updater, { versions: { "orbit-releases": "1.0.193", Wink: "1.0.193-dev.46" } }).checkForUpdates();
  assert.deepEqual(updater.checks, [onStable]);
});

test("a failed probe counts as unknown and the check still runs", async () => {
  const offline = () => {
    throw new Error("offline");
  };
  for (const [stable, want] of [[offline, onDev], [async () => "1.0.193", onStable]]) {
    const updater = new FakeUpdater();
    await channelUpdater(updater, {
      probe: (choice) => (choice.feed.repo === "Wink" ? Promise.reject(new Error("rate limited")) : stable()),
    }).checkForUpdates();
    assert.deepEqual(updater.checks, [want]);
  }
});

test("leaving dev on a stable build points the updater back at the stable feed", async () => {
  let channel = "dev";
  const updater = new FakeUpdater();
  const adapter = channelUpdater(updater, {
    running: "1.0.193",
    channel: () => channel,
    versions: { "orbit-releases": "1.0.193", Wink: "1.0.194-dev.1" },
  });
  await adapter.checkForUpdates();
  channel = "stable";
  await adapter.checkForUpdates();
  assert.deepEqual(updater.checks, [onDev, onStable]);
});

test("a channel switch waits for the check already in flight", async () => {
  let channel = "stable";
  const updater = new FakeUpdater();
  const first = deferred();
  updater.answers.push(first.promise);
  const adapter = channelUpdater(updater, { running: "1.0.192", channel: () => channel });

  const before = adapter.checkForUpdates();
  channel = "dev";
  const after = adapter.checkForUpdates();
  await flush();
  assert.equal(updater.checks.length, 1);
  assert.deepEqual(updater.feeds, []);

  first.reject(new Error("offline"));
  await assert.rejects(before);
  await after;
  assert.deepEqual(updater.checks, [{ repo: undefined, channel: null, allowPrerelease: false, allowDowngrade: false }, onDev]);
});

test("on the stable channel a failed check never falls back to the dev build offered before", async () => {
  let channel = "dev";
  const updater = new FakeUpdater();
  const downloads = [];
  updater.downloadUpdate = () => {
    downloads.push("download");
    return Promise.resolve([]);
  };
  const adapter = channelUpdater(updater, { channel: () => channel, versions: { "orbit-releases": "1.0.192", Wink: "1.0.193-dev.47" } });
  updater.answers.push(Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "1.0.193-dev.47" } }));
  const coordinator = createUpdaterCoordinator(adapter, () => {});
  await coordinator.check(true);

  channel = "stable";
  updater.answers.push(Promise.reject(new Error("offline")));
  assert.equal(coordinator.reset(), true);
  await coordinator.download();
  assert.deepEqual(downloads, []);

  channel = "dev";
  await adapter.downloadUpdate();
  assert.deepEqual(downloads, ["download"]);
});

test("the renderer can leave the dev channel but never join it", async () => {
  const handlers = new Map();
  const switched = [];
  registerChannelIpc(
    { handle: (name, handler) => handlers.set(name, handler) },
    { channel: () => "dev", backToStable: () => switched.push("stable") },
  );
  assert.equal(await handlers.get("update:get-channel")({}), "dev");
  for (const value of ["dev", "beta", undefined, { channel: "stable" }]) {
    await assert.rejects(async () => handlers.get("update:set-channel")({}, value));
  }
  assert.deepEqual(switched, []);
  await handlers.get("update:set-channel")({}, "stable");
  assert.deepEqual(switched, ["stable"]);
});
