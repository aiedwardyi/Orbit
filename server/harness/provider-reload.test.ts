import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { makeFakeDriver } from "../testing/fake-driver.ts";
import { EventBus } from "./bus.ts";
import { ProviderReload } from "./provider-reload.ts";
import { ProviderRegistry } from "./registry.ts";

describe("provider settings reload", () => {
  it("keeps a Claude turn running when Muse settings change", async () => {
    const claude = makeFakeDriver({ kind: "claudeAgent" });
    const muse = makeFakeDriver({ kind: "museAgent" });
    const registry = new ProviderRegistry([claude.driver, muse.driver]);
    const initial = {
      claude: { driver: "claudeAgent" },
      muse: { driver: "museAgent" },
    };
    await registry.load(initial);
    const bus = new EventBus(() => {});
    bus.attach(registry.instances());
    const reload = new ProviderReload(registry, bus, initial);
    const runningClaude = registry.get("claude");
    reload.started("claude-thread", "claude");

    await reload.reload({
      ...initial,
      muse: { driver: "museAgent", config: { cli: "muse-preset" } },
    });

    expect(registry.get("claude")).toBe(runningClaude);
    expect(claude.disposed).toEqual([]);
    expect(muse.disposed).toEqual(["muse"]);
    expect((await registry.describe()).find((entry) => entry.instanceId === "muse")?.cli).toBe("muse-preset");
    reload.settled("claude-thread");
  });

  it("applies a changed provider after its running turn settles", async () => {
    const muse = makeFakeDriver({ kind: "museAgent" });
    const registry = new ProviderRegistry([muse.driver]);
    const initial = { muse: { driver: "museAgent" } };
    await registry.load(initial);
    const bus = new EventBus(() => {});
    bus.attach(registry.instances());
    const reload = new ProviderReload(registry, bus, initial);
    const runningMuse = registry.get("muse");
    reload.started("muse-thread", "muse");

    await reload.reload({ muse: { driver: "museAgent", config: { cli: "muse-preset" } } });
    let ready = false;
    void reload.wait("muse").then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(registry.get("muse")).toBe(runningMuse);
    expect(muse.disposed).toEqual([]);

    reload.settled("muse-thread");
    await reload.wait("muse");
    expect(registry.get("muse")).not.toBe(runningMuse);
    expect(muse.disposed).toEqual(["muse"]);
    expect((await registry.describe())[0].cli).toBe("muse-preset");
  });

  it("dispatches onto the replacement when a reload lands before dispatch", async () => {
    const muse = makeFakeDriver({ kind: "museAgent" });
    const registry = new ProviderRegistry([muse.driver]);
    const initial = { muse: { driver: "museAgent" } };
    await registry.load(initial);
    const bus = new EventBus(() => {});
    bus.attach(registry.instances());
    const reload = new ProviderReload(registry, bus, initial);
    const captured = registry.get("muse");

    await reload.reload({ muse: { driver: "museAgent", config: { cli: "muse-preset" } } });

    const live = reload.started("muse-thread", "muse");
    expect(live).not.toBe(captured);
    expect(live).toBe(registry.get("muse"));
    reload.settled("muse-thread");
  });
});

describe("reload wait at dispatch", () => {
  const indexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../index.ts"), "utf8");

  it("skips the wait for a nested turn whose caller still holds the instance", () => {
    // ask_bot: the caller's turn stays active on the instance until the reply
    // lands, so a pending reload never resolves while the callee waits on it.
    expect(indexSource).toContain('if (opts?.runOn !== "cloud" && !commsDepth) await providerReload.wait(selection.instanceId);');
    expect(indexSource).not.toContain('if (opts?.runOn !== "cloud") await providerReload.wait(');
  });
});
