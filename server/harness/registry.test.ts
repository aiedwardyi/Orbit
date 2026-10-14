// The registry's contract is forward/backward compatibility: a config
// written by a newer or differently-built app must load as an
// unavailable shadow, never crash the fleet. These tests pin that.
import { describe, expect, it, vi } from "vitest";

import * as procs from "../procs.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";

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
