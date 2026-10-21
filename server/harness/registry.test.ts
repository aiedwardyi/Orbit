// The registry's contract is forward/backward compatibility: a config
// written by a newer or differently-built app must load as an
// unavailable shadow, never crash the fleet. These tests pin that.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { findCliCandidates, refreshPathCache, resetPathCacheForTests } from "../env-path.ts";
import * as procs from "../procs.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { MuseAgentDriver } from "../drivers/acp/muse.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { setWslGateForTests } from "../wsl-gate.ts";

/** A fake driver whose snapshot() and refreshModels() stand in for CLI launches. */
function countingDriver() {
  const fake = makeFakeDriver();
  const originalCreate = fake.driver.create.bind(fake.driver);
  const counts = { snapshots: 0, refreshes: 0 };
  let gate: Promise<void> | null = null;
  fake.driver.create = async (input) => {
    const instance = await originalCreate(input);
    const snapshot = instance.snapshot;
    Object.assign(instance, {
      snapshot: async (opts?: { rescan?: boolean }) => {
        const probe = ++counts.snapshots;
        await gate;
        return { ...(await snapshot(opts)), version: `probe ${probe}` };
      },
      refreshModels: async () => { counts.refreshes += 1; },
    });
    return instance;
  };
  const hold = () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    return () => {
      gate = null;
      release();
    };
  };
  return { driver: fake.driver, counts, hold };
}

const versions = (rows: { instanceId: string; snapshot: { version?: string | null } }[]) =>
  Object.fromEntries(rows.map((row) => [row.instanceId, row.snapshot.version]));

describe("ProviderRegistry", () => {
  it("rejects logout success while the refreshed engine remains authenticated", async () => {
    const fake = makeFakeDriver({ kind: "museAgent" });
    const registry = new ProviderRegistry([{ ...fake.driver, defaultConfig: () => ({ cli: "fake" }), install: { logout: ["logout"] } }]);
    try {
      await registry.load({ a: { driver: "museAgent", environment: { META_API_KEY: "review-meta" } } });
      registry.get("a")!.snapshot = async () => ({ state: "available", authenticated: true });
      await registry.describe();
      vi.spyOn(registry.logins, "start").mockResolvedValue({});
      vi.spyOn(registry.logins, "state").mockReturnValue("complete");
      expect(await registry.signOut("a")).toBe(false);
      expect(registry.describeSaved()[0].snapshot.authenticated).toBe(true);
      expect(registry.logins.needsRefresh("a")).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await registry.disposeAll();
    }
  });

  it.each([
    ["claudeAgent", []], ["codex", ["GH_TOKEN"]], ["grokAgent", []], ["museAgent", ["META_API_KEY"]],
  ])("filters the %s login environment through its runtime policy", async (kind, allowed) => {
    const driver = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === kind)!;
    const registry = new ProviderRegistry([driver]);
    const credentials = { ANTHROPIC_API_KEY: "review-anthropic", OPENAI_API_KEY: "review-openai", META_API_KEY: "review-meta", OMB_COMMS_TOKEN: "review-comms", GH_TOKEN: "review-github", FUTURE_PROVIDER_SECRET: "review-future" };
    try {
      await registry.load({ a: { driver: kind, config: { cli: "missing-review-cli" }, environment: { ...credentials, CLAUDE_CONFIG_DIR: homedir(), CODEX_HOME: homedir() } } });
      const start = vi.spyOn(registry.logins, "start").mockResolvedValue({});
      await registry.startSignIn("a");
      const env = start.mock.calls[0][3]!;
      expect(Object.fromEntries(Object.keys(credentials).filter((key) => env[key] !== undefined).map((key) => [key, env[key]])))
        .toEqual(Object.fromEntries(Object.entries(credentials).filter(([key]) => allowed.includes(key))));
      expect(env.CLAUDE_CONFIG_DIR).toBe(homedir());
      expect(env.CODEX_HOME).toBe(homedir());
    } finally { await registry.disposeAll(); }
  });

  it("isolates login jobs and cancellation for two Claude config directories", async () => {
    const dir = mkdtempSync(join(homedir(), "login-instances-"));
    const script = join(dir, "cli.cjs");
    writeFileSync(script, `
      require('node:fs').writeFileSync(process.env.CLAUDE_CONFIG_DIR, 'started');
      process.stdout.write('https://auth.example/device\\nCode: ABCD-EFGH\\n');
      setInterval(() => {}, 1000);
    `);
    const fake = makeFakeDriver({ kind: "claudeAgent" });
    const registry = new ProviderRegistry([{ ...fake.driver,
      defaultConfig: () => ({ cli: `"${process.execPath}" "${script}"` }),
      install: { login: { args: ["login"], deviceArgs: ["login"] } },
    }]);
    const first = join(dir, "first");
    const second = join(dir, "second");
    try {
      await registry.load({
        a: { driver: "claudeAgent", environment: { CLAUDE_CONFIG_DIR: first } },
        b: { driver: "claudeAgent", environment: { CLAUDE_CONFIG_DIR: second } },
      });
      await Promise.all([registry.startSignIn("a"), registry.startSignIn("b")]);
      expect([existsSync(first), existsSync(second)]).toEqual([true, true]);
      await registry.cancelSignIn("a");
      const rows = await registry.describe();
      expect(rows.find((row) => row.instanceId === "a")?.loginState).toBe("cancelled");
      expect(rows.find((row) => row.instanceId === "b")?.loginState).toBe("pending");
      expect(rows.find((row) => row.instanceId === "b")?.loginCapture).toEqual({ url: "https://auth.example/device", code: "ABCD-EFGH" });
    } finally {
      await registry.disposeAll();
      await removeTempDir(dir);
    }
  });

  it.each(["replace", "remove"])("cancels and clears the login process tree on instance %s", async (action) => {
    const dir = mkdtempSync(join(homedir(), "login-replace-"));
    const script = join(dir, "cli.cjs");
    writeFileSync(script, `
      const fs = require('node:fs');
      const file = process.argv[2];
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      fs.writeFileSync(file, JSON.stringify([process.pid, child.pid]));
      process.stdout.write('https://auth.example/device\\nCode: ABCD-EFGH\\n');
      setInterval(() => {}, 1000);
    `);
    const first = join(dir, "first");
    const second = join(dir, "second");
    const cli = (file: string) => `"${process.execPath}" "${script}" "${file}"`;
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([{ ...fake.driver, install: { login: { args: ["login"], deviceArgs: ["login"] } } }]);
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    try {
      await registry.load({ a: { driver: "fake", config: { cli: cli(first) } } });
      await registry.startSignIn("a");
      const pids: number[] = JSON.parse(readFileSync(first, "utf8"));
      expect(pids.map(alive)).toEqual([true, true]);
      if (action === "replace") await registry.load({ a: { driver: "fake", config: { cli: cli(second) } } });
      else registry.remove("a");
      await expect.poll(() => pids.map(alive), { timeout: 5000 }).toEqual([false, false]);
      expect(registry.logins.state("a")).toBeUndefined();
      expect(registry.logins.capture("a")).toEqual({});
      if (action === "remove") await registry.load({ a: { driver: "fake", config: { cli: cli(second) } } });
      await registry.startSignIn("a");
      expect(existsSync(second)).toBe(true);
      expect(registry.logins.state("a")).toBe("pending");
      expect(JSON.parse(readFileSync(second, "utf8"))[0]).not.toBe(pids[0]);
    } finally {
      await registry.disposeAll();
      await removeTempDir(dir);
    }
  });

  it.skipIf(process.platform !== "win32")("uses the resolved Muse CLI for login and logout", async () => {
    const registry = new ProviderRegistry([BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "museAgent")!]);
    setWslGateForTests({ env: {}, listRunning: () => "test-distro" });
    vi.spyOn(procs, "execCli").mockImplementation((cli, _args, _opts, callback) => {
      callback(cli === "muse" ? new Error("missing") : null, cli === "muse" ? "" : "1.0.0");
    });
    try {
      await registry.load({ muse: { driver: "museAgent", config: { cli: "muse" }, environment: { META_API_KEY: "review-meta" } } });
      expect((await registry.get("muse")!.snapshot({ rescan: true })).state).toBe("available");
      const start = vi.spyOn(registry.logins, "start").mockResolvedValue({});
      vi.spyOn(registry.logins, "state").mockReturnValue("complete");
      await registry.startSignIn("muse");
      await registry.signOut("muse");
      expect(start.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        ["wsl muse", ["login"]], ["wsl muse", ["logout"]],
      ]);
    } finally {
      await registry.disposeAll();
      setWslGateForTests(null);
      vi.restoreAllMocks();
    }
  });

  it("finishes sign-out after the instance is removed", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([{ ...fake.driver, defaultConfig: () => ({ cli: "fake" }), install: { logout: ["logout"] } }]);
    try {
      await registry.load({ a: { driver: "fake" } });
      await registry.describe();
      vi.spyOn(registry.logins, "start").mockImplementation(async () => { registry.remove("a"); return {}; });
      vi.spyOn(registry.logins, "state").mockReturnValue("complete");
      await expect(registry.signOut("a")).resolves.toBe(true);
      expect(registry.describeSaved()).toEqual([]);
    } finally { await registry.disposeAll(); }
  });

  it("hides captured login details throughout sign-out", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([{ ...fake.driver, defaultConfig: () => ({ cli: "fake" }),
      install: { login: { args: ["login"], deviceArgs: ["login"] }, logout: ["logout"] },
    }]);
    let release!: () => void;
    try {
      await registry.load({ a: { driver: "fake" } });
      await registry.describe();
      vi.spyOn(registry.logins, "capture").mockReturnValue({ url: "https://auth.example/device", code: "ABCD-EFGH" });
      vi.spyOn(registry.logins, "cancel").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
      vi.spyOn(registry.logins, "start").mockResolvedValue({});
      const logout = registry.signOut("a");
      const capture = registry.describeSaved()[0].loginCapture;
      release();
      await logout;
      expect(capture).toEqual({});
    } finally {
      vi.restoreAllMocks();
      await registry.disposeAll();
    }
  });

  it("connects and signs out through a fake CLI without persisting captured output", async () => {
    const dir = mkdtempSync(join(homedir(), "login-registry-"));
    const script = join(dir, "cli.cjs");
    const marker = join(dir, "signed-in");
    writeFileSync(script, `
      const fs = require('node:fs');
      const [marker, mode] = process.argv.slice(2);
      if (mode === 'login') {
        if (process.env.MUSE_LOGIN !== '0') process.exit(1);
        fs.writeFileSync(marker, 'yes');
        process.stderr.write('https://auth.example/device\\nCode: ABCD-EFGH\\n');
      } else if (mode === 'logout') fs.unlinkSync(marker);
      else process.exit(1);
    `);
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([{ ...fake.driver,
      defaultConfig: () => ({ cli: `"${process.execPath}" "${script}" "${marker}"` }),
      install: { login: { args: ["login"], deviceArgs: ["login"], env: { MUSE_LOGIN: "0" } }, logout: ["logout"] },
    }], { cacheDir: dir });
    try {
      await registry.load({ a: { driver: "fake" } });
      registry.get("a")!.snapshot = async () => ({ state: "available", authenticated: existsSync(marker) });
      await registry.describe();
      expect(await registry.startSignIn("a", true)).toEqual({ url: "https://auth.example/device", code: "ABCD-EFGH" });
      expect((await registry.describeCached())[0].snapshot.authenticated).toBe(true);
      const persisted = readFileSync(join(dir, "provider-probes.json"), "utf8");
      expect(persisted).not.toContain("auth.example");
      expect(persisted).not.toContain("ABCD-EFGH");
      expect(await registry.signOut("a")).toBe(true);
      expect((await registry.describeCached())[0].snapshot.authenticated).toBe(false);
    } finally {
      await registry.disposeAll();
      await removeTempDir(dir);
    }
  });

  it.each([
    ["claudeAgent", ["auth", "login"], undefined, ["auth", "logout"]],
    ["codex", ["login"], ["login", "--device-auth"], ["logout"]],
    ["grokAgent", ["login"], ["login", "--device-auth"], ["logout"]],
    ["museAgent", ["login"], ["login"], ["logout"]],
    ["antigravityAgent", undefined, undefined, undefined],
  ])("exposes fixed login and logout commands for %s", async (kind, args, deviceArgs, logout) => {
    const driver = BUILT_IN_DRIVERS.find((entry) => entry.driverKind === kind)!;
    const fake = makeFakeDriver({ kind: kind as string });
    const registry = new ProviderRegistry([{ ...fake.driver, install: driver.install }]);
    await registry.load({ engine: { driver: kind as string } });
    const [row] = await registry.describe();
    expect(row.install?.login?.args).toEqual(args);
    expect(row.install?.login?.deviceArgs).toEqual(deviceArgs);
    expect(row.install?.logout).toEqual(logout);
    if (kind === "museAgent") {
      expect(row.install?.login?.env).toEqual({ MUSE_LOGIN: "0" });
      expect(MuseAgentDriver.install).toEqual(row.install);
    }
    await registry.disposeAll();
  });

  it("runs only registered argv with the configured CLI and environment", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([{ ...fake.driver, install: {
      login: { args: ["login"], deviceArgs: ["device"], env: { MUSE_LOGIN: "0" } }, logout: ["logout"],
    }, defaultConfig: () => ({ cli: "default-cli" }) }]);
    await registry.load({ a: { driver: "fake", config: { cli: "custom-cli", login: { args: ["untrusted"] } }, environment: { TEST_ENV: "yes" } } });
    const start = vi.spyOn(registry.logins, "start").mockResolvedValue({ url: "https://example.com/login" });
    await registry.startSignIn("a", true);
    expect(start).toHaveBeenCalledExactlyOnceWith("a", "custom-cli", ["device"], expect.objectContaining({ TEST_ENV: "yes", MUSE_LOGIN: "0" }));
    expect(await registry.startSignIn("missing")).toBeNull();
    await registry.disposeAll();
  });

  it("refreshes auth without refreshing models while an external login waits", async () => {
    const fake = countingDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    await registry.describe();
    const refreshes = fake.counts.refreshes;
    registry.get("a")!.snapshot = vi.fn(async () => ({ state: "available" as const, authenticated: true }));
    registry.logins.waitExternal("a");
    expect((await registry.describeCached())[0].snapshot.authenticated).toBe(true);
    expect(registry.logins.state("a")).toBe("complete");
    await registry.describeCached();
    expect(registry.get("a")!.snapshot).toHaveBeenCalledTimes(1);
    expect(fake.counts.refreshes).toBe(refreshes);
    await registry.disposeAll();
  });

  it("never relays a Claude paste-back code", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([{ ...fake.driver, defaultConfig: () => ({ cli: "fake" }), install: { login: { args: ["auth", "login"] } } }]);
    await registry.load({ a: { driver: "fake" } });
    vi.spyOn(registry.logins, "start").mockResolvedValue({ url: "https://example.com/login", code: "ABCD-EFGH" });
    expect(await registry.startSignIn("a")).toEqual({ url: "https://example.com/login" });
    expect(await registry.startSignIn("a", true)).toBeNull();
    await registry.disposeAll();
  });

  it("discards an old auth probe after a login is replaced", async () => {
    const fake = countingDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    registry.get("a")!.snapshot = async () => ({ state: "available", authenticated: false });
    await registry.describe();
    registry.logins.waitExternal("a");
    let release!: () => void;
    registry.get("a")!.snapshot = () => new Promise((resolve) => { release = () => resolve({ state: "available", authenticated: true }); });
    const refresh = registry.refreshLogins();
    await registry.logins.cancel("a");
    registry.logins.waitExternal("a");
    release();
    await refresh;
    expect(registry.logins.state("a")).toBe("pending");
    expect(registry.describeSaved()[0].snapshot.authenticated).toBe(false);
    await registry.disposeAll();
  });

  it("cancels login before fixed logout and excludes competing starts", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([{ ...fake.driver, defaultConfig: () => ({ cli: "fake-cli" }), install: { login: { args: ["login"] }, logout: ["logout"] } }]);
    await registry.load({ a: { driver: "fake" } });
    await registry.describe();
    registry.get("a")!.snapshot = async () => ({ state: "available", authenticated: false });
    const cancel = vi.spyOn(registry.logins, "cancel").mockResolvedValue();
    let finish!: () => void;
    const start = vi.spyOn(registry.logins, "start").mockImplementation(() => new Promise((resolve) => { finish = () => resolve({}); }));
    vi.spyOn(registry.logins, "state").mockReturnValue("complete");
    const logout = registry.signOut("a");
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledWith("a");
    expect(start).toHaveBeenCalledWith("a", "fake-cli", ["logout"], expect.any(Object));
    expect(await registry.startSignIn("a")).toBeNull();
    expect(await registry.signOut("a")).toBe(false);
    finish();
    expect(await logout).toBe(true);
    expect((await registry.describeCached())[0].snapshot.authenticated).toBe(false);
    expect(await registry.signOut("missing")).toBeNull();
    await registry.disposeAll();
  });
  it("answers from the persisted boot probe while its replacement is pending", async () => {
    const cacheDir = mkdtempSync(join(homedir(), "probe-cache-"));
    const configs = { a: { driver: "fake" } };
    const first = countingDriver();
    const previous = new ProviderRegistry([first.driver], { cacheDir });
    await previous.load(configs);
    Object.assign(previous.get("a")!, { models: { default: "discovered", options: [{ id: "discovered", label: "Discovered" }] } });
    const saved = await previous.describe();
    await previous.disposeAll();

    const next = countingDriver();
    const registry = new ProviderRegistry([next.driver], { cacheDir });
    await registry.load(configs);
    const release = next.hold();
    const boot = registry.describe({ refresh: true });
    let cached: Awaited<ReturnType<typeof registry.describeCached>> | undefined;
    const read = registry.describeCached().then((rows) => { cached = rows; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(cached).toEqual(saved);
      expect(cached![0].models.default).toBe("discovered");
    } finally {
      release();
      await Promise.all([boot, read]);
    }
    expect((await registry.describeCached())[0].models.default).toBe("fake-1");
    expect(next.counts.snapshots).toBe(1);

    registry.get("a")!.snapshot = async () => ({ state: "unavailable", reason: "removed since launch" });
    await registry.describe({ refresh: true });
    expect((await registry.describeCached())[0].snapshot).toEqual({ state: "unavailable", reason: "removed since launch" });
    registry.get("a")!.snapshot = async () => ({ state: "available", version: "newly installed" });
    await registry.describe({ refresh: true });
    expect((await registry.describeCached())[0].snapshot.version).toBe("newly installed");
    await registry.disposeAll();

    const changed = new ProviderRegistry([makeFakeDriver().driver], { cacheDir });
    await changed.load({ a: { driver: "fake", config: { changed: true } } });
    expect((await changed.describeCached())[0].snapshot.version).toBe("0.0.0-fake");
    await changed.disposeAll();
    writeFileSync(join(cacheDir, "provider-probes.json"), "{broken");
    const recovered = new ProviderRegistry([makeFakeDriver().driver], { cacheDir });
    await recovered.load(configs);
    expect((await recovered.describeCached())[0].snapshot.version).toBe("0.0.0-fake");
    await recovered.disposeAll();
  });

  it("reads saved probe rows without probing", async () => {
    const cacheDir = mkdtempSync(join(homedir(), "probe-cache-"));
    try {
      const configs = { a: { driver: "fake" }, b: { driver: "fake" } };
      const previous = new ProviderRegistry([makeFakeDriver().driver], { cacheDir });
      await previous.load({ a: configs.a });
      previous.get("a")!.snapshot = async () => ({ state: "unavailable", reason: "signed out" });
      await previous.describe();
      await previous.disposeAll();

      const next = countingDriver();
      const registry = new ProviderRegistry([next.driver], { cacheDir });
      await registry.load(configs);
      expect(registry.describeSaved().map((row) => [row.instanceId, row.snapshot.state])).toEqual([["a", "unavailable"]]);
      expect(next.counts.snapshots).toBe(0);
      await registry.disposeAll();
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("resolves sign-in only from the registered driver", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([{ ...fake.driver, install: { signInCommand: "official login" } }]);
    await registry.load({ a: { driver: "fake", config: { signInCommand: "untrusted", cli: "untrusted" } } });
    expect(registry.signIn("a")).toEqual({ driverKind: "fake", command: "official login" });
    expect(registry.signIn("official login")).toBeNull();
    expect(registry.signIn("missing")).toBeNull();
  });

  it("creates live instances for known drivers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake", displayName: "Bot A" } });

    const live = registry.get("a");
    expect(live).not.toBeNull();
    expect(live!.driverKind).toBe("fake");
    expect(live!.displayName).toBe("Bot A");
    expect(registry.instances()).toHaveLength(1);
  });

  it("creates independent instances concurrently", async () => {
    const fake = makeFakeDriver();
    const originalCreate = fake.driver.create.bind(fake.driver);
    let active = 0;
    let peak = 0;
    const gate = new Promise((resolve) => setTimeout(resolve, 25));
    fake.driver.create = async (input) => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return originalCreate(input);
    };
    const registry = new ProviderRegistry([fake.driver]);

    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    expect(peak).toBe(2);
    expect(registry.instances()).toHaveLength(2);
  });

  it("avoids duplicate model discovery until the refresh window expires", async () => {
    const fake = makeFakeDriver();
    const originalCreate = fake.driver.create.bind(fake.driver);
    let refreshes = 0;
    let now = 1_000;
    fake.driver.create = async (input) => {
      const instance = await originalCreate(input);
      const refreshModels = async () => { refreshes += 1; };
      await refreshModels();
      Object.assign(instance, { refreshModels });
      return instance;
    };
    const registry = new ProviderRegistry([fake.driver], { now: () => now, modelRefreshTtlMs: 100 });

    await registry.load({ a: { driver: "fake" } });
    expect(refreshes).toBe(1);

    await registry.describe();
    expect(refreshes).toBe(1);

    now += 101;
    await registry.describe();
    expect(refreshes).toBe(2);
  });

  it("rediscovers models once a refresh repairs a stale cached CLI path", async () => {
    const cacheDir = mkdtempSync(join(homedir(), "probe-cache-"));
    const [moved, installed] = ["moved-bin-", "installed-bin-"].map((dir) => mkdtempSync(join(homedir(), dir)));
    const name = "stale-shim-cli";
    const shim = (dir: string) => join(dir, name + (process.platform === "win32" ? ".cmd" : ""));
    process.env.OMB_EXTRA_PATH = [moved, installed].join(delimiter);
    try {
      writeFileSync(shim(moved), "fixture");
      resetPathCacheForTests();
      await refreshPathCache([name]);
      rmSync(shim(moved));
      writeFileSync(shim(installed), "fixture");
      resetPathCacheForTests();
      const fake = makeFakeDriver();
      const originalCreate = fake.driver.create.bind(fake.driver);
      fake.driver.create = async (input) => {
        const instance = await originalCreate(input);
        const refreshModels = async () => {
          const found = existsSync(findCliCandidates(name)[0] ?? "");
          Object.assign(instance, {
            models: found ? { default: "real", options: [{ id: "real", label: "Real" }] } : fake.driver.models,
          });
        };
        await refreshModels();
        Object.assign(instance, { refreshModels });
        return instance;
      };
      const registry = new ProviderRegistry([fake.driver], { cacheDir });
      await registry.load({ a: { driver: "fake", config: { cli: name } } });
      expect(registry.get("a")!.models.default).toBe("fake-1");
      expect((await registry.describe({ refresh: true }))[0].models.default).toBe("real");
      expect((await registry.describeCached())[0].models.default).toBe("real");
      await registry.disposeAll();
    } finally {
      delete process.env.OMB_EXTRA_PATH;
      resetPathCacheForTests();
    }
  });

  it("coalesces concurrent model discovery refreshes", async () => {
    const fake = makeFakeDriver();
    const originalCreate = fake.driver.create.bind(fake.driver);
    let refreshes = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    fake.driver.create = async (input) => {
      const instance = await originalCreate(input);
      Object.assign(instance, {
        refreshModels: async () => {
          refreshes += 1;
          await gate;
        },
      });
      return instance;
    };
    let now = 1_000;
    const registry = new ProviderRegistry([fake.driver], { now: () => now, modelRefreshTtlMs: 100 });
    await registry.load({ a: { driver: "fake" } });
    now += 101;

    const descriptions = Promise.all([registry.describe(), registry.describe()]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(refreshes).toBe(1);
    release!();
    await descriptions;
  });

  it("waits for background model discovery before describing an instance", async () => {
    const fake = makeFakeDriver();
    const originalCreate = fake.driver.create.bind(fake.driver);
    let release!: () => void;
    let ready = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.driver.create = async (input) => {
      const instance = await originalCreate(input);
      Object.assign(instance, { modelsReady: gate.then(() => { ready = true; }) });
      return instance;
    };
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    let described = false;
    const description = registry.describe().finally(() => { described = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ready).toBe(false);
    expect(described).toBe(false);
    release();
    await description;
    expect(ready).toBe(true);
    expect(described).toBe(true);
  });

  it("answers a cached describe from the last probe without probing or refreshing models", async () => {
    const { driver, counts } = countingDriver();
    let now = 1_000;
    const registry = new ProviderRegistry([driver], { now: () => now, modelRefreshTtlMs: 100 });
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });
    await registry.describe();
    expect(counts).toEqual({ snapshots: 2, refreshes: 0 });

    now += 600_000;
    for (let i = 0; i < 3; i++) {
      expect(versions(await registry.describeCached())).toEqual({ a: "probe 1", b: "probe 2" });
    }
    expect(counts).toEqual({ snapshots: 2, refreshes: 0 });

    await registry.describe();
    expect(counts).toEqual({ snapshots: 4, refreshes: 2 });
  });

  it("waits on the boot probe instead of starting a second one", async () => {
    const { driver, counts, hold } = countingDriver();
    const registry = new ProviderRegistry([driver]);
    await registry.load({ a: { driver: "fake" } });
    const release = hold();
    const boot = registry.describe();
    const reads = Promise.all([registry.describeCached(), registry.describeCached()]);
    release();
    await boot;
    expect((await reads).map(versions)).toEqual([{ a: "probe 1" }, { a: "probe 1" }]);
    expect(counts.snapshots).toBe(1);
  });

  it("keeps answering from the last probe while a refresh is in flight", async () => {
    const { driver, hold } = countingDriver();
    const registry = new ProviderRegistry([driver]);
    await registry.load({ a: { driver: "fake" } });
    await registry.describe();
    const release = hold();
    const refresh = registry.describe();
    expect(versions(await registry.describeCached())).toEqual({ a: "probe 1" });
    release();
    expect(versions(await refresh)).toEqual({ a: "probe 2" });
    expect(versions(await registry.describeCached())).toEqual({ a: "probe 2" });
  });

  it("keeps the newest probe when an older one finishes after it", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    let release!: () => void;
    let calls = 0;
    const held = new Promise<void>((resolve) => { release = resolve; });
    fake.created.get("a")!.instance.snapshot = async () => {
      if (++calls === 1) {
        await held;
        return { state: "unavailable", reason: "before install" };
      }
      return { state: "available", version: "after install" };
    };
    const older = registry.describe();
    expect((await registry.describe({ rescan: true }))[0].snapshot.state).toBe("available");
    release();
    await older;
    expect((await registry.describeCached())[0].snapshot.state).toBe("available");
  });

  it("clears the version cache on a rescan only", async () => {
    const clear = vi.spyOn(procs, "clearVersionCache");
    try {
      const { driver } = countingDriver();
      const registry = new ProviderRegistry([driver]);
      await registry.load({ a: { driver: "fake" } });
      await registry.describeCached();
      await registry.describe();
      await registry.describe({ refresh: true });
      expect(clear).not.toHaveBeenCalled();
      await registry.describe({ rescan: true });
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      clear.mockRestore();
    }
  });

  it("probes only the instances a config change added or edited, and drops removed ones", async () => {
    const { driver, counts } = countingDriver();
    const registry = new ProviderRegistry([driver]);
    await registry.load({ a: { driver: "fake" } });
    await registry.describeCached();
    expect(counts.snapshots).toBe(1);

    await registry.load({ b: { driver: "fake" } });
    expect(versions(await registry.describeCached())).toEqual({ a: "probe 1", b: "probe 2" });
    await registry.load({ a: { driver: "fake", config: { cli: "edited" } } });
    const edited = await registry.describeCached();
    expect(versions(edited)).toEqual({ a: "probe 3", b: "probe 2" });
    expect(edited.find((row) => row.instanceId === "a")?.cli).toBe("edited");
    registry.remove("b");
    expect(versions(await registry.describeCached())).toEqual({ a: "probe 3" });
    expect(counts.snapshots).toBe(3);
  });

  it("uses defaultConfig when the entry has no config", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    // decodeConfig must NOT have been called — defaultConfig() is used verbatim
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
  });

  it("reports cli as overridden only when the raw config sets it", async () => {
    // Regression: override detection used to read the DECODED config, whose
    // cli field is always filled in with the driver default — every instance
    // then showed as "custom" though nothing was touched.
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      untouched: { driver: "fake", config: { other: true } },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
      bare: { driver: "fake" },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.untouched.cli).toBeUndefined();
    expect(described.bare.cli).toBeUndefined();
    expect(described.overridden.cli).toBe("/opt/fake/custom-bin");
    expect(described.untouched.cliDefault).toBe("fakebin");
    expect(described.untouched.access).toBe("subscription");
  });

  it("publishes custom-only access from driver metadata", async () => {
    const fake = makeFakeDriver();
    Object.assign(fake.driver.metadata, { access: "custom" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ local: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.access).toBe("custom");
  });

  it("keeps an unknown driver as an unavailable shadow instead of failing", async () => {
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ mystery: { driver: "from-the-future", displayName: "Tomorrow" } });

    expect(registry.get("mystery")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.snapshot.reason).toContain("from-the-future");
    expect(described.displayName).toBe("Tomorrow");
    expect(described.models.options).toHaveLength(0);
  });

  it("downgrades a config-decode failure to a shadow with the error as reason", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ broken: { driver: "fake", config: { bad: true } } });

    expect(registry.get("broken")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "fake: bad config" });
  });

  it("downgrades a create() rejection to a shadow without touching siblings", async () => {
    const good = makeFakeDriver({ kind: "good" });
    const flaky = makeFakeDriver({ kind: "flaky", failCreate: "boom at create" });
    const registry = new ProviderRegistry([good.driver, flaky.driver]);
    await registry.load({
      g: { driver: "good" },
      f: { driver: "flaky" },
    });

    expect(registry.get("g")).not.toBeNull();
    expect(registry.get("f")).toBeNull();
    const described = await registry.describe();
    const f = described.find((d) => d.instanceId === "f")!;
    expect(f.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("forwards a live instance's declared effort levels in describe()", async () => {
    const fake = makeFakeDriver({ effortLevels: ["low", "high"] });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toEqual(["low", "high"]);
  });

  it("omits effortLevels from describe() when the driver declares none", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("says which instances can ask before an edit, keeping the chip for drivers that never say", async () => {
    const never = makeFakeDriver({ kind: "never-asks", askApproval: false });
    const silent = makeFakeDriver({ kind: "silent" });
    const registry = new ProviderRegistry([never.driver, silent.driver]);
    await registry.load({ a: { driver: "never-asks" }, b: { driver: "silent" } });

    const described = await registry.describe();
    expect(described.find((d) => d.instanceId === "a")?.capabilities.askApproval).toBe(false);
    expect(described.find((d) => d.instanceId === "b")?.capabilities.askApproval).toBe(true);
  });

  it("reports whether an instance supports isolated approval review", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    expect((await registry.describe())[0].capabilities.approvalReview).toBe(false);
    Object.assign(registry.get("a")!, { reviewPermission: async () => "ok" });
    expect((await registry.describe())[0].capabilities.approvalReview).toBe(true);
  });

  it("disposeAll disposes every live instance and empties the registry", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    await registry.disposeAll();
    expect(fake.disposed.sort()).toEqual(["a", "b"]);
    expect(registry.entries()).toHaveLength(0);
    expect(registry.get("a")).toBeNull();
  });
});
