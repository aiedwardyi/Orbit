// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { findCliCandidates } from "../env-path.ts";
import type {
  AnyProviderDriver,
  InstanceConfigMap,
  InstanceId,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  /** Raw `config.cli` from disk — an override exists only if this is set. */
  cli: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

const MODEL_REFRESH_TTL_MS = 5_000;

export interface ProviderRegistryOptions {
  now?: () => number;
  modelRefreshTtlMs?: number;
}

/** The `cli` field off a driver's default config, when it has one — the
 * placeholder an override input shows when nothing is set. */
function cliDefaultOf(driver: AnyProviderDriver | undefined): string | undefined {
  if (!driver) return undefined;
  try {
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return typeof cfg?.cli === "string" ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

/** Raw `config.cli` straight from disk — shadow snapshots can't decode, so
 * this is the only faithful way to echo back what was configured. */
function cliOfRaw(raw: unknown): string | undefined {
  const cli = (raw as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
}

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  /** decoded per-instance `cli` overrides, for describe() — drivers spawn
   * from their own config; this map only reports what was configured */
  private cliByInstance = new Map<InstanceId, string>();
  private modelRefreshAt = new Map<InstanceId, number>();
  private modelRefreshInFlight = new Map<InstanceId, Promise<void>>();
  private driversByKind: Map<string, AnyProviderDriver>;
  private readonly now: () => number;
  private readonly modelRefreshTtlMs: number;

  constructor(drivers: readonly AnyProviderDriver[], options: ProviderRegistryOptions = {}) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
    this.now = options.now ?? Date.now;
    this.modelRefreshTtlMs = options.modelRefreshTtlMs ?? MODEL_REFRESH_TTL_MS;
  }

  async load(configs: InstanceConfigMap) {
    const loaded = await Promise.all(Object.entries(configs).map(async ([instanceId, entry]) => {
      const driver = this.driversByKind.get(entry.driver);
      if (!driver) {
        return {
          entry: {
            instanceId,
            shadow: {
              instanceId,
              driverKind: entry.driver,
              displayName: entry.displayName,
              cli: cliOfRaw(entry.config),
              shadow: true,
              reason: `unknown driver "${entry.driver}" — kept as configured, unavailable here`,
            },
          },
        } satisfies { entry: RegistryEntry; rawCli?: string };
      }
      const rawCli = cliOfRaw(entry.config);
      try {
        const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
        // Override detection is on the RAW config, never the decoded one:
        // decodeConfig fills in the driver default ("claude", "codex", …),
        // so reading `cli` there would flag every instance as overridden.
        const live = await driver.create({
          instanceId,
          displayName: entry.displayName ?? driver.metadata.displayName,
          environment: entry.environment ?? {},
          enabled: entry.enabled ?? true,
          config,
        });
        return { entry: { instanceId, live }, rawCli } satisfies { entry: RegistryEntry; rawCli?: string };
      } catch (e) {
        return {
          entry: {
            instanceId,
            shadow: {
              instanceId,
              driverKind: entry.driver,
              displayName: entry.displayName ?? driver.metadata.displayName,
              cli: cliOfRaw(entry.config),
              shadow: true,
              reason: e instanceof Error ? e.message : String(e),
            },
          },
          rawCli,
        } satisfies { entry: RegistryEntry; rawCli?: string };
      }
    }));
    for (const result of loaded) {
      if (result.rawCli) this.cliByInstance.set(result.entry.instanceId, result.rawCli);
      else this.cliByInstance.delete(result.entry.instanceId);
      this.byId.set(result.entry.instanceId, result.entry);
      const live = result.entry.live;
      if (live?.modelsReady) {
        const ready = live.modelsReady
          .then(() => {
            this.modelRefreshAt.set(result.entry.instanceId, this.now());
          })
          .catch(() => {
            this.modelRefreshAt.set(result.entry.instanceId, this.now());
          })
          .finally(() => {
            if (this.modelRefreshInFlight.get(result.entry.instanceId) === ready) {
              this.modelRefreshInFlight.delete(result.entry.instanceId);
            }
          });
        this.modelRefreshAt.delete(result.entry.instanceId);
        this.modelRefreshInFlight.set(result.entry.instanceId, ready);
      } else if (live?.refreshModels) this.modelRefreshAt.set(result.entry.instanceId, this.now());
      else {
        this.modelRefreshAt.delete(result.entry.instanceId);
        this.modelRefreshInFlight.delete(result.entry.instanceId);
      }
    }
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  /** instance snapshots for the model picker: id, driver, models, health */
  async describe() {
    // Multiple instances may share a driver. Scan each default binary once
    // per response instead of repeating filesystem work for every row.
    const candidatesByName = new Map<string, string[]>();
    const candidatesFor = (driver: AnyProviderDriver | undefined): string[] => {
      const name = cliDefaultOf(driver);
      if (!name) return [];
      const cached = candidatesByName.get(name);
      if (cached) return cached;
      const found = findCliCandidates(name);
      candidatesByName.set(name, found);
      return found;
    };
    return Promise.all(
      this.entries().map(async (entry) => {
        const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
        if (entry.shadow) {
          return {
            instanceId: entry.instanceId,
            driverKind: entry.shadow.driverKind,
            displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
            snapshot: { state: "unavailable", reason: entry.shadow.reason } satisfies ProviderSnapshot,
            models: { default: "", options: [] },
            capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
            // an unknown driver has no driver record, hence no install path
            access: driver?.metadata.access ?? "subscription",
            install: driver?.install,
            cli: entry.shadow.cli,
            cliDefault: cliDefaultOf(driver),
            // a shadow is exactly the "your CLI is broken, pick another"
            // case where the detected-path dropdown matters most
            cliCandidates: candidatesFor(driver),
          };
        }
        const inst = entry.live;
        let snapshot: ProviderSnapshot;
        try {
          const lastRefresh = this.modelRefreshAt.get(inst.instanceId) ?? 0;
          if (inst.refreshModels && this.now() - lastRefresh >= this.modelRefreshTtlMs) {
            const inFlight = this.modelRefreshInFlight.get(inst.instanceId);
            if (inFlight) await inFlight;
            else {
              const refresh = (async () => {
                try {
                  await inst.refreshModels!();
                } finally {
                  this.modelRefreshAt.set(inst.instanceId, this.now());
                }
              })();
              this.modelRefreshInFlight.set(inst.instanceId, refresh);
              try {
                await refresh;
              } finally {
                if (this.modelRefreshInFlight.get(inst.instanceId) === refresh) this.modelRefreshInFlight.delete(inst.instanceId);
              }
            }
          }
          snapshot = await inst.snapshot();
        } catch (e) {
          snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
        }
        return {
          instanceId: inst.instanceId,
          driverKind: inst.driverKind,
          displayName: inst.displayName ?? inst.driverKind,
          snapshot,
          models: inst.models,
          capabilities: {
            computerMcp: inst.adapter.capabilities.computerMcp === true,
            agentsMcp: inst.adapter.capabilities.agentsMcp === true,
            composioMcp: inst.adapter.capabilities.composioMcp === true,
            phoneMcp: inst.adapter.capabilities.phoneMcp === true,
            browserMcp: inst.adapter.capabilities.browserMcp === true,
            images: inst.adapter.capabilities.images === true,
            effortLevels: inst.adapter.capabilities.effortLevels,
            queueing: inst.adapter.capabilities.queueing === true,
            localComputerMcp: inst.adapter.capabilities.localComputerMcp === true,
            askApproval: inst.adapter.capabilities.askApproval !== false,
            approvalReview: inst.reviewPermission !== undefined,
            rateLimits: inst.adapter.capabilities.rateLimits === true,
          },
          access: driver?.metadata.access ?? "subscription",
          install: driver?.install,
          cli: this.cliByInstance.get(inst.instanceId),
          cliDefault: cliDefaultOf(driver),
          // every copy of the driver's default binary on the augmented PATH —
          // the dropdown's "detected" entries. Snapshotted per describe() so a
          // newly installed CLI shows up on the next refresh.
          cliCandidates: candidatesFor(driver),
        };
      }),
    );
  }

  async disposeAll() {
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
    this.modelRefreshAt.clear();
    this.modelRefreshInFlight.clear();
  }
}
