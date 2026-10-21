// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { findCliCandidates, refreshPathCache, splitCliString } from "../env-path.ts";
import { clearVersionCache } from "../procs.ts";
import { EngineLogin } from "../engine-login.ts";
import { withWslProbeSnapshot } from "../wsl-gate.ts";
import type {
  AnyProviderDriver,
  InstanceConfigMap,
  InstanceId,
  ModelCatalog,
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

/** The part of a describe() row that costs process launches. */
interface Probe {
  snapshot: ProviderSnapshot;
  cliCandidates: string[];
  models?: ModelCatalog;
}

const savedProbeSchema = z.object({
  key: z.string(),
  snapshot: z.object({
    state: z.enum(["available", "unavailable"]), reason: z.string().optional(),
    authenticated: z.boolean().optional(), version: z.string().nullable().optional(),
    billing: z.enum(["metered", "subscription"]).optional(),
  }),
  cliCandidates: z.array(z.string()),
  models: z.object({
    default: z.string(),
    options: z.array(z.object({
      id: z.string(), label: z.string(), custom: z.boolean().optional(),
      loaded: z.boolean().optional(), contextWindow: z.number().optional(),
    })),
  }),
});

export interface ProviderRegistryOptions {
  now?: () => number;
  modelRefreshTtlMs?: number;
  cacheDir?: string;
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
  readonly logins = new EngineLogin();
  private signingOut = new Set<string>();
  private environmentByInstance = new Map<InstanceId, Record<string, string>>();
  private byId = new Map<InstanceId, RegistryEntry>();
  /** decoded per-instance `cli` overrides, for describe() — drivers spawn
   * from their own config; this map only reports what was configured */
  private cliByInstance = new Map<InstanceId, string>();
  private modelRefreshAt = new Map<InstanceId, number>();
  private modelRefreshInFlight = new Map<InstanceId, Promise<void>>();
  private probed = new Map<InstanceId, Probe>();
  private probing = new Map<InstanceId, Promise<Probe>>();
  private driversByKind: Map<string, AnyProviderDriver>;
  private readonly now: () => number;
  private readonly modelRefreshTtlMs: number;
  private readonly cacheDir: string | undefined;
  private cacheKeys = new Map<InstanceId, string>();
  private probeVersion = 0;
  private savedVersion = 0;

  constructor(drivers: readonly AnyProviderDriver[], options: ProviderRegistryOptions = {}) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
    this.now = options.now ?? Date.now;
    this.modelRefreshTtlMs = options.modelRefreshTtlMs ?? MODEL_REFRESH_TTL_MS;
    this.cacheDir = options.cacheDir;
  }

  async load(configs: InstanceConfigMap) {
    let saved: Record<string, unknown> = {};
    if (this.cacheDir) {
      try { saved = JSON.parse(readFileSync(join(this.cacheDir, "provider-probes.json"), "utf8")); } catch {}
    }
    const loaded = await Promise.all(Object.entries(configs).map(async ([instanceId, entry]) => {
      this.environmentByInstance.set(instanceId, entry.environment ?? {});
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
      this.forget(result.entry.instanceId);
      if (result.rawCli) this.cliByInstance.set(result.entry.instanceId, result.rawCli);
      else this.cliByInstance.delete(result.entry.instanceId);
      this.byId.set(result.entry.instanceId, result.entry);
      const live = result.entry.live;
      const driver = live && this.driversByKind.get(live.driverKind);
      if (driver && this.cacheDir) {
        const key = createHash("sha256").update(JSON.stringify([
          process.platform, configs[result.entry.instanceId], driver.defaultConfig(), driver.models,
        ])).digest("hex");
        this.cacheKeys.set(result.entry.instanceId, key);
        const probe = savedProbeSchema.safeParse(saved?.[result.entry.instanceId]);
        if (probe.success && probe.data.key === key) this.probed.set(result.entry.instanceId, probe.data);
      }
      if (live?.modelsReady) {
        const ready = live.modelsReady
          .then(() => {
            if (this.byId.get(result.entry.instanceId)?.live === live) {
              this.modelRefreshAt.set(result.entry.instanceId, this.now());
            }
          })
          .catch(() => {
            if (this.byId.get(result.entry.instanceId)?.live === live) {
              this.modelRefreshAt.set(result.entry.instanceId, this.now());
            }
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
    if (this.cacheDir) this.savedVersion = this.probeVersion;
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  signIn(instanceId: InstanceId) {
    const entry = this.byId.get(instanceId);
    const kind = entry?.live?.driverKind ?? entry?.shadow?.driverKind;
    const driver = kind ? this.driversByKind.get(kind) : undefined;
    const command = driver?.install?.signInCommand;
    return command ? { driverKind: driver!.driverKind, command } : null;
  }

  private loginConfig(instanceId: InstanceId) {
    const live = this.get(instanceId);
    const driver = live && this.driversByKind.get(live.driverKind);
    const cli = this.cliByInstance.get(instanceId) ?? cliDefaultOf(driver || undefined);
    return live && driver && cli ? {
      engine: driver.driverKind, cli, install: driver.install,
      env: { ...this.environmentByInstance.get(instanceId), ...driver.install?.login?.env },
    } : null;
  }

  async startSignIn(instanceId: InstanceId, device = false) {
    const config = this.loginConfig(instanceId);
    if (!config || this.signingOut.has(config.engine)) return null;
    if (config.engine === "antigravityAgent" && !device) return this.logins.waitExternal(config.engine);
    const login = config.install?.login;
    const args = device ? login?.deviceArgs : login?.args;
    if (!args) return null;
    const capture = await this.logins.start(config.engine, config.cli, args, config.env);
    return login?.deviceArgs ? capture : capture.url ? { url: capture.url } : {};
  }

  async cancelSignIn(instanceId: InstanceId) {
    const config = this.loginConfig(instanceId);
    if (!config) return false;
    if (this.signingOut.has(config.engine)) return true;
    await this.logins.cancel(config.engine);
    return true;
  }

  async signOut(instanceId: InstanceId) {
    const config = this.loginConfig(instanceId);
    if (!config?.install?.logout) return null;
    if (this.signingOut.has(config.engine)) return false;
    this.signingOut.add(config.engine);
    try {
      await this.logins.cancel(config.engine);
      await this.logins.start(config.engine, config.cli, config.install.logout, config.env);
      await this.logins.wait(config.engine);
      const success = this.logins.state(config.engine) === "complete";
      if (success) {
        this.logins.clear(config.engine);
        const previous = this.probed.get(instanceId);
        const snapshot = await this.get(instanceId)!.snapshot({ refresh: true });
        if (previous) this.probed.set(instanceId, { ...previous, snapshot });
        this.probeVersion += 1;
      }
      return success;
    } finally {
      this.signingOut.delete(config.engine);
    }
  }

  async refreshLogins() {
    await Promise.all(this.entries().map(async (entry) => {
      const live = entry.live;
      if (!live || this.signingOut.has(live.driverKind) || !this.logins.needsRefresh(live.driverKind)) return;
      const previous = this.probed.get(entry.instanceId);
      if (!previous) return;
      const generation = this.logins.generation(live.driverKind);
      const snapshot = await live.snapshot({ refresh: true });
      if (this.signingOut.has(live.driverKind) || this.logins.generation(live.driverKind) !== generation || !this.logins.needsRefresh(live.driverKind)) return;
      this.probed.set(entry.instanceId, { ...previous, snapshot });
      this.probeVersion += 1;
      if (snapshot.authenticated) this.logins.complete(live.driverKind);
      this.logins.acknowledge(live.driverKind, snapshot.authenticated === true);
    }));
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  remove(instanceId: InstanceId): ProviderInstance | null {
    const live = this.get(instanceId);
    this.byId.delete(instanceId);
    this.cliByInstance.delete(instanceId);
    this.environmentByInstance.delete(instanceId);
    this.modelRefreshAt.delete(instanceId);
    this.modelRefreshInFlight.delete(instanceId);
    this.forget(instanceId);
    return live;
  }

  /** instance snapshots for the model picker: id, driver, models, health */
  async describe(opts?: { rescan?: boolean; refresh?: boolean }) {
    if (opts?.rescan) clearVersionCache();
    const candidatesFor = this.candidateScan();
    const probe = async () => {
      const pending = [];
      for (const entry of this.entries()) {
        if (this.cacheDir) await new Promise<void>((resolve) => setImmediate(resolve));
        pending.push(this.startProbe(entry, candidatesFor, opts).then((probe) => this.row(entry, probe)));
      }
      const rows = await Promise.all(pending);
      this.saveProbes();
      return rows;
    };
    return this.prepareProbes(probe);
  }

  /** describe() rows from the last completed probe; only instances added or changed since are probed. */
  async describeCached() {
    await this.refreshLogins();
    const read = async () => {
      const candidatesFor = this.candidateScan();
      const rows = await Promise.all(
        this.entries().map(async (entry) => this.row(entry, this.probed.get(entry.instanceId) ??
          await (this.probing.get(entry.instanceId) ?? this.startProbe(entry, candidatesFor)))),
      );
      this.saveProbes();
      return rows;
    };
    return this.entries().some((entry) => !this.probed.has(entry.instanceId) && !this.probing.has(entry.instanceId))
      ? this.prepareProbes(read) : read();
  }

  /** describe() rows for instances with a saved probe; probes nothing. */
  describeSaved() {
    return this.entries().flatMap((entry) => {
      const probe = this.probed.get(entry.instanceId);
      return probe ? [this.row(entry, probe)] : [];
    });
  }

  private async prepareProbes<T>(probe: () => Promise<T>): Promise<T> {
    const names = this.entries().flatMap((entry) => {
      const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
      return [cliDefaultOf(driver), this.cliByInstance.get(entry.instanceId)].flatMap((cli) => cli ? [splitCliString(cli)[0]] : []);
    });
    if (this.cacheDir && names.length) {
      await refreshPathCache([...names, "node.exe", "wsl"]);
      return withWslProbeSnapshot(probe);
    }
    return probe();
  }

  private saveProbes() {
    if (!this.cacheDir || this.savedVersion === this.probeVersion) return;
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const saved = Object.fromEntries([...this.probed].flatMap(([id, probe]) => {
        const key = this.cacheKeys.get(id);
        return key && probe.models ? [[id, { key, ...probe }]] : [];
      }));
      writeFileAtomic(join(this.cacheDir, "provider-probes.json"), JSON.stringify(saved), { mode: 0o600 });
      this.savedVersion = this.probeVersion;
    } catch {}
  }

  // Multiple instances may share a driver. Scan each default binary once
  // per response instead of repeating filesystem work for every row.
  private candidateScan() {
    const candidatesByName = new Map<string, string[]>();
    return (driver: AnyProviderDriver | undefined): string[] => {
      const name = cliDefaultOf(driver);
      if (!name) return [];
      const cached = candidatesByName.get(name);
      if (cached) return cached;
      const found = findCliCandidates(name);
      candidatesByName.set(name, found);
      return found;
    };
  }

  private startProbe(
    entry: RegistryEntry,
    candidatesFor: (driver: AnyProviderDriver | undefined) => string[],
    opts?: { rescan?: boolean; refresh?: boolean },
  ): Promise<Probe> {
    const id = entry.instanceId;
    const pending = this.probe(entry, candidatesFor, opts);
    this.probing.set(id, pending);
    void pending.then((probe) => {
      if (this.byId.get(id) === entry && this.probing.get(id) === pending) {
        this.probed.set(id, probe);
        this.probing.delete(id);
        this.probeVersion += 1;
      }
    });
    return pending;
  }

  private forget(instanceId: InstanceId) {
    this.probed.delete(instanceId);
    this.probing.delete(instanceId);
    this.cacheKeys.delete(instanceId);
    this.probeVersion += 1;
  }

  private async probe(
    entry: RegistryEntry,
    candidatesFor: (driver: AnyProviderDriver | undefined) => string[],
    opts?: { rescan?: boolean; refresh?: boolean },
  ): Promise<Probe> {
    const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
    if (entry.shadow) {
      return {
        snapshot: { state: "unavailable", reason: entry.shadow.reason },
        // a shadow is exactly the "your CLI is broken, pick another"
        // case where the detected-path dropdown matters most
        cliCandidates: candidatesFor(driver),
      };
    }
    const inst = entry.live;
    let snapshot: ProviderSnapshot;
    try {
      const discovery = this.modelRefreshInFlight.get(inst.instanceId);
      if (discovery) await discovery;
      const lastRefresh = this.modelRefreshAt.get(inst.instanceId) ?? 0;
      // Creation may have resolved a stale cached CLI path; this probe runs after a fresh PATH scan.
      const freshPath = opts?.refresh || opts?.rescan;
      if (inst.refreshModels && (freshPath || this.now() - lastRefresh >= this.modelRefreshTtlMs)) {
        const inFlight = this.modelRefreshInFlight.get(inst.instanceId);
        if (inFlight) await inFlight;
        else {
          const refresh = (async () => {
            try {
              await inst.refreshModels!();
            } finally {
              if (this.byId.get(inst.instanceId)?.live === inst) {
                this.modelRefreshAt.set(inst.instanceId, this.now());
              }
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
      snapshot = await inst.snapshot(opts);
    } catch (e) {
      snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
    }
    return {
      snapshot,
      // every copy of the driver's default binary on the augmented PATH -
      // the dropdown's "detected" entries. Snapshotted per probe so a
      // newly installed CLI shows up on the next refresh.
      cliCandidates: candidatesFor(driver),
      models: this.cacheDir ? structuredClone(inst.models) : undefined,
    };
  }

  private row(entry: RegistryEntry, probe: Probe) {
    const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
    if (entry.shadow) {
      return {
        instanceId: entry.instanceId,
        driverKind: entry.shadow.driverKind,
        displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
        snapshot: probe.snapshot,
        models: { default: "", options: [] },
        capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
        // an unknown driver has no driver record, hence no install path
        access: driver?.metadata.access ?? "subscription",
        install: driver?.install,
        cli: entry.shadow.cli,
        cliDefault: cliDefaultOf(driver),
        cliCandidates: probe.cliCandidates,
      };
    }
    const inst = entry.live;
    return {
      instanceId: inst.instanceId,
      loginState: this.signingOut.has(inst.driverKind) ? "cancelled" : this.logins.state(inst.driverKind),
      loginCapture: driver?.install?.login?.deviceArgs ? this.logins.capture(inst.driverKind)
        : { url: this.logins.capture(inst.driverKind).url },
      driverKind: inst.driverKind,
      displayName: inst.displayName ?? inst.driverKind,
      snapshot: probe.snapshot,
      models: probe.models ?? inst.models,
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
      cliCandidates: probe.cliCandidates,
    };
  }

  async disposeAll() {
    await this.logins.dispose();
    this.environmentByInstance.clear();
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
    this.modelRefreshAt.clear();
    this.modelRefreshInFlight.clear();
    this.probed.clear();
    this.probing.clear();
    this.cacheKeys.clear();
  }
}
