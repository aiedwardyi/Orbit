import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import type { Message } from "./store.ts";
import type { ThreadRowPage } from "./message-db.ts";
import type { MigrationCrash, MigrationProgress } from "./thread-sync-v2-migration.ts";

export const THREAD_SYNC_V2_HEAD_BYTES = 512 * 1024;
export type SyncSeen = Record<string, number>;
export type SyncKind = "row" | "metadata" | "head" | "delete";
export type SealCrash = "before-publish" | "after-publish" | "after-journal" | "after-trim";

export interface SyncScope {
  botSyncId: string;
  threadId: string;
}

export interface SyncVersion {
  seq: number;
  seen: SyncSeen;
  kind: SyncKind;
  rowId: string;
  baseStamp: string | null;
  value: unknown;
  origin?: string;
  legacy?: { sourceHash: string; stamp?: string };
}

export interface SyncFragment extends Omit<SyncVersion, "kind" | "value"> {
  kind: "fragment";
  value: { firstSeq: number; index: number; count: number; hash: string; data: string };
}

export type SyncPacket = SyncVersion | SyncFragment;

export interface SyncHead {
  v: 2;
  threadId: string;
  writerId: string;
  generation: number;
  sealedThrough: number;
  firstSeq: number;
  lastSeq: number;
  seen: SyncSeen;
  versions: SyncPacket[];
}

export type SyncMutation =
  | { kind: "row"; value: Message; origin?: string }
  | { kind: "metadata"; value: { title: string; createdAt: number } }
  | { kind: "head"; value: string | null }
  | { kind: "delete"; value: { deletedAt: number } };

export type SyncRecovery = SyncMutation & { legacy: { sourceHash: string; stamp?: string } };

export interface SyncOptions {
  folder: string;
  dataDir: string;
  deviceId: string;
  headBytes?: number;
  staged?: boolean;
}

export interface SyncApplyResult {
  applied: number;
  rowsTouched: number;
  sqlRowsTouched: number;
  conflicts: number;
  quarantined: number;
  rejected: number;
}

export interface SyncFlushResult {
  bytesWritten: number;
  headBytes: number;
  segments: number;
  sealedThrough: number;
}

export interface SyncVariant {
  writerId: string;
  version: SyncVersion;
}

export interface SyncState {
  writerId: string;
  seen: SyncSeen;
  deleted: boolean;
  deleteConflicts: number;
  quarantined: number;
  outbox: number;
}

export interface SyncChange {
  cursor: number;
  kind: SyncKind;
  rowId: string;
  value: unknown;
  conflict: boolean;
}

export type SyncRequest =
  | { method: "commit"; args: [SyncScope, SyncMutation[], ("before-commit" | "after-commit")?] }
  | { method: "recover"; args: [SyncScope, SyncRecovery[], ("before-commit" | "after-commit")?] }
  | { method: "flush"; args: [SyncScope, SealCrash?, number?] }
  | { method: "pull" | "state"; args: [SyncScope] }
  | { method: "scan"; args: [string, number, number] }
  | { method: "variants"; args: [SyncScope, SyncKind, string] }
  | { method: "changes"; args: [SyncScope, number, number] }
  | { method: "threads"; args: [string] }
  | { method: "legacyThreads"; args: [string] }
  | { method: "migrate"; args: [SyncScope, MigrationCrash?, boolean?] }
  | { method: "close"; args: [] };

type SyncResponse = SyncApplyResult | SyncFlushResult | ThreadRowPage | SyncVariant[] | SyncState | SyncChange[] | MigrationProgress | string[] | undefined;

export class ThreadSyncV2 {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: SyncResponse) => void; reject: (error: Error) => void }>();
  private failure: Error | null = null;
  private exited: Promise<void>;

  constructor(options: SyncOptions) {
    const source = new URL("./thread-sync-v2-worker.ts", import.meta.url);
    const worker = existsSync(source) ? source : new URL("./thread-sync-v2-worker.js", import.meta.url);
    this.worker = new Worker(worker, {
      workerData: options,
      env: { ...process.env, OMB_DATA_DIR: options.dataDir },
      execArgv: worker.pathname.endsWith(".ts") ? ["--experimental-strip-types"] : [],
      resourceLimits: { maxYoungGenerationSizeMb: 4 },
    });
    this.worker.on("message", ({ id, value, error }: { id: number; value: SyncResponse; error?: string }) => {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (error) pending?.reject(new Error(error));
      else pending?.resolve(value);
    });
    this.worker.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    this.exited = new Promise((resolve) => this.worker.on("exit", (code) => {
      this.fail(new Error(`Sync worker exited (${code})`));
      resolve();
    }));
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request<T extends SyncResponse>(request: SyncRequest): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      // SAFETY: The private callers pair each worker method with its response type.
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ id, ...request });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  commit(scope: SyncScope, mutations: SyncMutation[], crash?: "before-commit" | "after-commit"): Promise<SyncApplyResult> {
    if (mutations.length > 128) return Promise.reject(new Error("Sync batches are limited to 128 changes"));
    return this.request({ method: "commit", args: [scope, mutations, crash] });
  }

  flush(scope: SyncScope, crash?: SealCrash, through?: number): Promise<SyncFlushResult> {
    return this.request({ method: "flush", args: [scope, crash, through] });
  }

  recover(scope: SyncScope, mutations: SyncRecovery[], crash?: "before-commit" | "after-commit"): Promise<SyncApplyResult> {
    return this.request({ method: "recover", args: [scope, mutations, crash] });
  }

  pull(scope: SyncScope): Promise<SyncApplyResult> {
    return this.request({ method: "pull", args: [scope] });
  }

  scan(threadId: string, after = 0, limit = 256): Promise<ThreadRowPage> {
    return this.request({ method: "scan", args: [threadId, after, limit] });
  }

  variants(scope: SyncScope, kind: SyncKind, rowId = ""): Promise<SyncVariant[]> {
    return this.request({ method: "variants", args: [scope, kind, rowId] });
  }

  state(scope: SyncScope): Promise<SyncState> {
    return this.request({ method: "state", args: [scope] });
  }

  changes(scope: SyncScope, after = 0, limit = 128): Promise<SyncChange[]> {
    return this.request({ method: "changes", args: [scope, after, limit] });
  }

  threads(botSyncId: string): Promise<string[]> {
    return this.request({ method: "threads", args: [botSyncId] });
  }

  legacyThreads(botSyncId: string): Promise<string[]> {
    return this.request({ method: "legacyThreads", args: [botSyncId] });
  }

  migrate(scope: SyncScope, crash?: MigrationCrash, deferUnreadable = false): Promise<MigrationProgress> {
    return this.request({ method: "migrate", args: [scope, crash, deferUnreadable] });
  }

  async close(): Promise<void> {
    if (!this.failure) await this.request({ method: "close", args: [] });
    await this.exited;
  }
}
