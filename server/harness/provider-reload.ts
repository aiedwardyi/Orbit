import type { InstanceConfigMap, ProviderInstance } from "../contracts.ts";
import { EventBus } from "./bus.ts";
import { ProviderRegistry } from "./registry.ts";

export class ProviderReload {
  private loaded = new Map<string, string>();
  private desired: InstanceConfigMap;
  private active = new Map<string, string>();
  private pending = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private queue: Promise<void> = Promise.resolve();
  private registry: ProviderRegistry;
  private bus: EventBus;

  constructor(registry: ProviderRegistry, bus: EventBus, configs: InstanceConfigMap) {
    this.registry = registry;
    this.bus = bus;
    this.desired = configs;
    for (const [id, config] of Object.entries(configs)) this.loaded.set(id, JSON.stringify(config));
  }

  /** Current instance for a dispatch; one captured before an await may already be disposed. */
  started(threadId: string, instanceId: string): ProviderInstance | null {
    const live = this.registry.get(instanceId);
    if (live) this.active.set(threadId, instanceId);
    return live;
  }

  settled(threadId: string) {
    const instanceId = this.active.get(threadId);
    this.active.delete(threadId);
    if (instanceId && this.pending.has(instanceId)) void this.reload(this.desired).catch(console.error);
  }

  wait(instanceId: string): Promise<void> {
    return this.pending.get(instanceId)?.promise ?? Promise.resolve();
  }

  reload(configs: InstanceConfigMap): Promise<void> {
    this.desired = configs;
    for (const id of new Set([...this.loaded.keys(), ...Object.keys(configs)])) {
      if (this.loaded.get(id) === (configs[id] ? JSON.stringify(configs[id]) : undefined)) continue;
      if (this.pending.has(id)) continue;
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      this.pending.set(id, { promise, resolve });
    }
    const next = this.queue.then(() => this.apply());
    this.queue = next.catch(() => {});
    return next;
  }

  private async apply() {
    const configs = this.desired;
    const changed = [...this.pending.keys()].filter((id) => ![...this.active.values()].includes(id));
    const replacements: InstanceConfigMap = {};
    const previous = changed.flatMap((id) => {
      const live = this.registry.get(id);
      if (configs[id] && this.loaded.get(id) !== JSON.stringify(configs[id])) replacements[id] = configs[id];
      return live ? [live] : [];
    });
    if (Object.keys(replacements).length) await this.registry.load(replacements);
    for (const id of changed) {
      if (!configs[id]) this.registry.remove(id);
    }
    const replaced = changed.filter((id) => this.loaded.get(id) !== (configs[id] ? JSON.stringify(configs[id]) : undefined));
    if (replaced.length) {
      this.bus.detachAll();
      this.bus.attach(this.registry.instances());
      await Promise.allSettled(previous.filter((instance) => replaced.includes(instance.instanceId)).map((instance) => instance.dispose()));
    }
    for (const id of changed) {
      const config = configs[id];
      if (config) this.loaded.set(id, JSON.stringify(config));
      else this.loaded.delete(id);
      if (this.loaded.get(id) !== (this.desired[id] ? JSON.stringify(this.desired[id]) : undefined)) continue;
      this.pending.get(id)?.resolve();
      this.pending.delete(id);
    }
  }
}
