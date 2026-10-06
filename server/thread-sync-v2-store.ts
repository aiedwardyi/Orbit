import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { lastMessageAt, withMessageTransaction } from "./message-db.ts";
import { publishThreadPictures } from "./picture-sync.ts";
import type { Message, Store } from "./store.ts";
import { CONFLICT_NOTICE, CONFLICT_NOTICE_V2, isConflictNotice, shared, THREAD_SYNC_POLL_MS } from "./thread-sync.ts";
import { createSyncEngine } from "./thread-sync-v2-engine.ts";
import { initializeMigration, registerMigration, type MigrationProgress } from "./thread-sync-v2-migration.ts";
import { ThreadSyncV2, type SyncChange, type SyncMutation, type SyncOptions, type SyncScope } from "./thread-sync-v2.ts";

const FLUSH_DELAY_MS = 3_000;

interface Target {
  botId: string;
  botSyncId: string;
}

const storedTaskSchema = z.object({
  threadId: z.string(), botId: z.string(), botSyncId: z.string(), title: z.string(),
  createdAt: z.number(), deleted: z.number(), eligible: z.number(), cursor: z.number(),
});
type StoredTask = z.infer<typeof storedTaskSchema>;

export interface SyncStoreHost {
  store: Store;
  dataDir: string;
  deviceId: string;
  folder(): string | null;
  enabled(): boolean;
  target(threadId: string): Target | null;
  bots(): Target[];
  running(threadId: string): boolean;
  project(message: Message): Message;
  imported(botId: string): void;
  maintenance(): void;
}

export function createThreadSyncV2Store(host: SyncStoreHost, enabled = true) {
  if (!enabled) return null;
  const ownership = new DatabaseSync(join(host.dataDir, "thread-sync-v2-owner.db"));
  // the open exclusive transaction is the single-writer lock; a server still exiting gets a few seconds to let go
  ownership.exec("PRAGMA busy_timeout = 5000");
  try {
    ownership.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    ownership.close();
    throw new Error(`chat sync v2: another Wink server holds the sync lock in ${host.dataDir}`, { cause: error });
  }
  const options: SyncOptions = { dataDir: host.dataDir, deviceId: host.deviceId, folder: join(host.dataDir, "sync-v2-staging"), staged: true };
  const engine = createSyncEngine(options);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const retry = new Set<string>();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let worker: ThreadSyncV2 | undefined;
  let workerFolder: string | undefined;
  let queue = Promise.resolve();
  const migrationProgress = new Map<string, MigrationProgress>();
  let bytesPublished = 0;
  withMessageTransaction((db) => db.exec(`
    CREATE TABLE IF NOT EXISTS sync_v2_store (
      threadId TEXT PRIMARY KEY, botId TEXT NOT NULL, botSyncId TEXT NOT NULL,
      title TEXT NOT NULL, createdAt INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      eligible INTEGER NOT NULL, cursor INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sync_v2_pictures (id INTEGER PRIMARY KEY, thread TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_v2_migration_log (id INTEGER PRIMARY KEY, ended INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_v2_notices (thread TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sync_v2_conflict_changes ON sync_v2_changes(thread, cursor) WHERE conflict = 1;
    INSERT OR IGNORE INTO sync_v2_migration_log VALUES (1, 0);
  `));
  withMessageTransaction(initializeMigration);

  function stored(threadId: string): StoredTask | undefined {
    return withMessageTransaction((db) => storedTaskSchema.optional().parse(db.prepare("SELECT * FROM sync_v2_store WHERE threadId = ?").get(threadId)));
  }

  function register(threadId: string, target: Target, legacy = false): StoredTask {
    const task = host.store.taskByThread(target.botId, threadId);
    const existing = stored(threadId);
    if (!existing) withMessageTransaction((db) => db.prepare(
      "INSERT OR IGNORE INTO sync_v2_store(threadId, botId, botSyncId, title, createdAt, eligible) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(threadId, target.botId, target.botSyncId, task?.title ?? "New task", task?.createdAt ?? 0,
      Number(lastMessageAt(threadId) === null && !existsSync(join(host.dataDir, `messages-${threadId}.json`)))));
    const saved = existing ?? stored(threadId)!;
    if (legacy && !withMessageTransaction((db) => db.prepare("SELECT 1 FROM sync_v2_migration WHERE thread = ?").get(threadId))) {
      withMessageTransaction((db) => db.prepare("UPDATE sync_v2_store SET eligible = 0 WHERE threadId = ?").run(threadId));
      saved.eligible = 0;
    }
    if (!saved.eligible) withMessageTransaction((db) => registerMigration(db, { botSyncId: target.botSyncId, threadId }, saved.title, saved.createdAt));
    return saved;
  }

  function consume(task: StoredTask, limit = Infinity): boolean {
    const scope: SyncScope = { botSyncId: task.botSyncId, threadId: task.threadId };
    for (let count = 0; count < limit; count++) {
      const page = engine.changes(scope, task.cursor);
      if (!page.length) return false;
      const deleted = engine.state(scope).deleted;
      if (task.deleted && !deleted) restore(task);
      const changes = page.filter((change) => change.kind !== "delete" || deleted);
      withMessageTransaction((db) => {
        host.store.applySyncChanges(task.botId, task.threadId, changes);
        for (const change of changes) {
          if (change.kind === "metadata") {
            // SAFETY: The sync engine validates metadata before adding a change page.
            const metadata = change.value as { title: string; createdAt: number };
            db.prepare("UPDATE sync_v2_store SET title = ?, createdAt = ?, deleted = 0 WHERE threadId = ?")
              .run(metadata.title, metadata.createdAt, task.threadId);
          } else if (change.kind === "delete") {
            db.prepare("UPDATE sync_v2_store SET deleted = 1 WHERE threadId = ?").run(task.threadId);
            task.deleted = 1;
          }
        }
        task.cursor = page.at(-1)!.cursor;
        db.prepare("UPDATE sync_v2_store SET cursor = ? WHERE threadId = ?").run(task.cursor, task.threadId);
      });
    }
    return true;
  }

  function restore(task: StoredTask): void {
    const metadata = engine.variants(task, "metadata")[0]?.version.value ?? { title: task.title, createdAt: task.createdAt };
    host.store.applySyncChanges(task.botId, task.threadId, [{ cursor: 0, kind: "metadata", rowId: "", value: metadata, conflict: false }]);
    let after = "";
    for (;;) {
      const rows = engine.recoveryRows(task, after);
      if (!rows.length) break;
      host.store.applySyncChanges(task.botId, task.threadId, rows);
      after = rows.at(-1)!.rowId;
    }
    const head = engine.variants(task, "head")[0];
    if (head) host.store.applySyncChanges(task.botId, task.threadId, [{ cursor: 0, kind: "head", rowId: "", value: head.version.value, conflict: false }]);
    const restored = host.store.taskByThread(task.botId, task.threadId)!;
    withMessageTransaction((db) => db.prepare("UPDATE sync_v2_store SET title = ?, createdAt = ?, deleted = 0 WHERE threadId = ?")
      .run(restored.title, restored.createdAt, task.threadId));
    task.deleted = 0;
  }

  function notifyConflict(task: StoredTask): void {
    if (host.running(task.threadId)) return;
    withMessageTransaction((db) => {
      const conflict = db.prepare("SELECT cursor FROM sync_v2_changes WHERE thread = ? AND conflict = 1 AND cursor <= ? ORDER BY cursor DESC LIMIT 1")
        .get(task.threadId, task.cursor)?.cursor;
      if (conflict === undefined) return;
      const checked = db.prepare("SELECT cursor FROM sync_v2_notices WHERE thread = ?").get(task.threadId)?.cursor;
      if (checked === conflict) return;
      db.prepare("INSERT INTO sync_v2_notices VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET cursor = excluded.cursor")
        .run(task.threadId, conflict);
      if (!engine.conflicted(task)) return;
      const noticed = db.prepare(`WITH RECURSIVE path(id) AS (
        SELECT active_leaf_id FROM thread_state WHERE thread_id = ?
        UNION SELECT json_extract(m.json, '$.parentId') FROM messages m JOIN path ON m.id = path.id WHERE m.thread_id = ?
      ) SELECT 1 FROM path JOIN messages m ON m.id = path.id
        WHERE m.thread_id = ? AND json_extract(m.json, '$.tool.name') IN (?, ?) LIMIT 1`)
        .get(task.threadId, task.threadId, task.threadId, `error: ${CONFLICT_NOTICE}`, `error: ${CONFLICT_NOTICE_V2}`);
      if (noticed) return;
      const parent = db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(task.threadId)?.active_leaf_id;
      const message: Message = { id: randomUUID(), at: Date.now(), parentId: parent ? String(parent) : null, role: "bot", kind: "activity", tool: { name: `error: ${CONFLICT_NOTICE_V2}`, ok: false } };
      host.store.applySyncChanges(task.botId, task.threadId, [
        { cursor: 0, kind: "row", rowId: message.id, value: message, conflict: false },
        { cursor: 0, kind: "head", rowId: "", value: message.id, conflict: false },
      ]);
    });
  }

  function removeMigrationNotices(task: StoredTask): void {
    const path = join(host.dataDir, "thread-sync-v2-cutover.json");
    if (!existsSync(path) || host.running(task.threadId)) return;
    let cutoverAt: number;
    try {
      cutoverAt = z.object({ version: z.literal(2), cutoverAt: z.number().finite().nonnegative() }).parse(JSON.parse(readFileSync(path, "utf8"))).cutoverAt;
    } catch {
      return;
    }
    withMessageTransaction((db) => {
      if (!db.prepare("SELECT 1 FROM sync_v2_notices WHERE thread = ?").get(task.threadId)) return;
      const notices = db.prepare(`SELECT id FROM messages m WHERE thread_id = ? AND at >= ? AND kind = 'activity'
        AND json_extract(json, '$.tool.name') = ?
        AND NOT EXISTS (SELECT 1 FROM sync_v2_snapshot s WHERE s.thread = m.thread_id AND s.row_id = m.id)`)
        .all(task.threadId, cutoverAt, `error: ${CONFLICT_NOTICE}`);
      if (!notices.length || engine.hadNativeConflict(task)) return;
      host.store.removeSyncNotices(task.threadId, notices.map((row) => String(row.id)));
    });
  }

  for (const bot of host.store.bots) {
    for (const task of host.store.tasks(bot.id)) {
      const target = host.target(task.threadId);
      if (target) register(task.threadId, target);
    }
  }
  const saved = withMessageTransaction((db) => z.array(storedTaskSchema).parse(db.prepare("SELECT * FROM sync_v2_store").all()));
  for (const task of saved) {
    if (!host.store.bot(task.botId)) continue;
    removeMigrationNotices(task);
    const change: SyncChange = task.deleted
      ? { cursor: 0, kind: "delete", rowId: "", value: { deletedAt: 0 }, conflict: false }
      : { cursor: 0, kind: "metadata", rowId: "", value: { title: task.title, createdAt: task.createdAt }, conflict: false };
    const current = host.store.taskByThread(task.botId, task.threadId);
    if (task.deleted || !current || current.title !== task.title || current.createdAt !== task.createdAt) {
      host.store.applySyncChanges(task.botId, task.threadId, [change]);
    }
    if (task.eligible) {
      consume(task, 1);
      notifyConflict(task);
    }
  }

  function project(threadId: string, mutations: SyncMutation[]): SyncMutation[] {
    if (!mutations.some((mutation) => mutation.kind === "row" || mutation.kind === "head")) return mutations;
    const messages = host.store.messagesFor(threadId);
    const lift = (id: string | null) => {
      const visited = new Set<string>();
      while (id && !visited.has(id)) {
        visited.add(id);
        const parent = messages.find((message) => message.id === id);
        if (!parent || !isConflictNotice(parent)) break;
        id = parent.parentId ?? null;
      }
      return id;
    };
    return mutations.flatMap((mutation): SyncMutation[] => {
      if (mutation.kind === "head") return [{ kind: "head", value: lift(mutation.value) }];
      if (mutation.kind !== "row") return [mutation];
      const projected = host.project(mutation.value);
      const { messages: rows } = shared({ title: "", createdAt: 0, messages: [projected], activeLeafId: null });
      return rows.map((row) => ({ kind: "row", value: { ...row, parentId: lift(row.parentId ?? null) } }));
    });
  }

  host.store.setSyncWriter((threadId, mutations, write) => {
    if (host.store.importingSync) {
      withMessageTransaction((db) => {
        write();
        if (mutations.some((mutation) => mutation.kind === "delete")) {
          db.prepare("UPDATE sync_v2_store SET deleted = 1 WHERE threadId = ?").run(threadId);
        }
      });
      return;
    }
    const target = host.target(threadId) ?? (mutations.some((mutation) => mutation.kind === "delete") ? stored(threadId) : null);
    if (!target) return write();
    const changed = withMessageTransaction(() => {
      const task = register(threadId, target);
      const outgoing = project(threadId, mutations).filter((mutation) => {
        const rowId = mutation.kind === "row" ? mutation.value.id : "";
        const variants = engine.variants(task, mutation.kind, rowId);
        return variants.length !== 1 || JSON.stringify(variants[0].version.value) !== JSON.stringify(mutation.value);
      });
      const metadata = host.store.taskByThread(target.botId, threadId);
      if (metadata && !outgoing.some((mutation) => mutation.kind === "metadata" || mutation.kind === "delete")) {
        if (!engine.variants(task, "metadata").length || task.title !== metadata.title || task.createdAt !== metadata.createdAt) {
          outgoing.unshift({ kind: "metadata", value: { title: metadata.title, createdAt: metadata.createdAt } });
        }
      }
      engine.commit(task, outgoing, undefined, (db) => {
        write();
        for (const mutation of outgoing) {
          if (mutation.kind === "metadata") {
            db.prepare("UPDATE sync_v2_store SET title = ?, createdAt = ?, deleted = 0 WHERE threadId = ?")
              .run(mutation.value.title, mutation.value.createdAt, threadId);
          } else if (mutation.kind === "delete") {
            db.prepare("UPDATE sync_v2_store SET deleted = 1 WHERE threadId = ?").run(threadId);
          } else if (mutation.kind === "row" && (mutation.value.image || mutation.value.text?.includes("<attached-image"))) {
            db.prepare("INSERT INTO sync_v2_pictures(thread, json) VALUES (?, ?)").run(threadId, JSON.stringify(mutation.value));
          }
        }
      });
      return outgoing.length > 0;
    });
    if (changed) schedule(threadId);
  });

  async function client(): Promise<ThreadSyncV2 | null> {
    const folder = host.folder();
    if (!host.enabled() || !folder) return null;
    if (worker && (workerFolder !== folder || worker.failed)) {
      await worker.close();
      worker = undefined;
    }
    if (!worker) {
      worker = new ThreadSyncV2({ ...options, folder });
      workerFolder = folder;
    }
    return worker;
  }

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.then(() => {}, (error) => console.warn("chat sync v2:", error));
    return next;
  }

  async function flush(threadId: string): Promise<"running" | "written" | "skipped"> {
    if (host.running(threadId)) return "running";
    const task = stored(threadId);
    if (!task?.eligible) return "skipped";
    const transport = await client();
    if (!transport) return "skipped";
    if (host.running(threadId)) return "running";
    for (;;) {
      const pictures = withMessageTransaction((db) => z.array(z.object({ id: z.number(), json: z.string() })).parse(
        db.prepare("SELECT id, json FROM sync_v2_pictures WHERE thread = ? ORDER BY id LIMIT 128").all(threadId)));
      if (!pictures.length) break;
      publishThreadPictures({ folder: workerFolder!, dataDir: host.dataDir, messages: pictures.map((row): Message => JSON.parse(row.json)) });
      withMessageTransaction((db) => db.prepare("DELETE FROM sync_v2_pictures WHERE thread = ? AND id <= ?").run(threadId, pictures.at(-1)!.id));
    }
    const state = engine.state(task);
    bytesPublished += (await transport.flush(task, undefined, state.seen[state.writerId] ?? 0)).bytesWritten;
    return "written";
  }

  function schedule(threadId: string): void {
    if (timers.has(threadId)) return;
    const timer = setTimeout(() => {
      timers.delete(threadId);
      void serial(() => flush(threadId)).then((result) => {
        if (result === "running") schedule(threadId);
        else if (result === "written") retry.delete(threadId);
      }).catch(() => { retry.add(threadId); });
    }, FLUSH_DELAY_MS);
    timer.unref?.();
    timers.set(threadId, timer);
  }

  async function pull(threadId: string, target = host.target(threadId)): Promise<void> {
    if (!host.enabled() || !target || host.running(threadId)) return;
    const task = register(threadId, target);
    if (!task.eligible) return;
    const transport = await client();
    if (!transport || host.running(threadId)) return;
    await transport.pull(task);
    if (!host.enabled() || host.folder() !== workerFolder || host.running(threadId)) return;
    const cursor = task.cursor;
    await adopt(task);
    notifyConflict(task);
    if (task.cursor !== cursor) host.store.applySyncImport(() => host.imported(target.botId));
  }

  async function adopt(task: StoredTask): Promise<void> {
    while (host.enabled() && host.folder() === workerFolder && !host.running(task.threadId)) {
      const more = consume(task, 1);
      const result = more ? null : engine.applyPending(task);
      if (!more) consume(task, 1);
      if (!more && !result?.applied) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  function unfinished(threadId: string): number {
    return withMessageTransaction((db) => Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_sources WHERE thread = ? AND done = 0").get(threadId)?.n ?? 0));
  }

  function markReady(task: StoredTask): void {
    if (task.eligible) return;
    withMessageTransaction((db) => db.prepare("UPDATE sync_v2_store SET eligible = 1 WHERE threadId = ?").run(task.threadId));
    task.eligible = 1;
    schedule(task.threadId);
  }

  async function migrate(task: StoredTask, snapshotOnly = false): Promise<void> {
    const transport = await client();
    if (!transport || (task.eligible && !unfinished(task.threadId))) return;
    let defer = false;
    while (host.enabled() && host.folder() === workerFolder && !host.running(task.threadId)) {
      const phase = withMessageTransaction((db) => db.prepare("SELECT phase FROM sync_v2_migration WHERE thread = ?").get(task.threadId)?.phase);
      if (snapshotOnly && phase !== "snapshot") return;
      if (phase === "recover" || phase === "done") await adopt(task);
      if (host.running(task.threadId)) return;
      const progress = await transport.migrate(task, undefined, defer);
      migrationProgress.set(task.threadId, progress);
      if ((progress.localReady || progress.phase === "done") && !task.eligible) {
        markReady(task);
        await adopt(task);
        notifyConflict(task);
      }
      if (progress.error) {
        if (progress.phase === "legacy" && !defer) { defer = true; continue; }
        return;
      }
      defer = false;
      if (progress.phase === "done") {
        notifyConflict(task);
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  function migrationStatus() {
    return withMessageTransaction((db) => ({
      threads: Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_migration").get()!.n),
      completed: Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_migration WHERE phase = 'done'").get()!.n),
      rows: Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_snapshot").get()!.n),
      published: Number(db.prepare("SELECT COALESCE(SUM(published), 0) AS n FROM sync_v2_migration").get()!.n),
      pendingSources: Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_sources WHERE done = 0").get()!.n),
      errors: db.prepare("SELECT thread, error FROM sync_v2_migration WHERE error IS NOT NULL").all().map((row) => ({ threadId: String(row.thread), error: String(row.error) })),
      workerHeapBytes: Math.max(0, ...[...migrationProgress.values()].map((item) => item.heapBytes)),
      workerBaselineHeapBytes: Math.max(0, ...[...migrationProgress.values()].map((item) => item.baselineHeapBytes)),
      bytesPublished,
    }));
  }

  async function poll(): Promise<void> {
    const transport = await client();
    if (!transport) return;
    for (const threadId of retry) schedule(threadId);
    host.maintenance();
    const tasks: StoredTask[] = [];
    for (const target of host.bots()) {
      for (const local of host.store.tasks(target.botId)) {
        if (host.target(local.threadId)) register(local.threadId, target);
      }
      for (const threadId of await transport.legacyThreads(target.botSyncId)) register(threadId, target, true);
    }
    tasks.push(...withMessageTransaction((db) => z.array(storedTaskSchema).parse(db.prepare("SELECT * FROM sync_v2_store WHERE eligible = 0").all())));
    for (const task of tasks) await migrate(task, true);
    if (withMessageTransaction((db) => db.prepare("SELECT 1 FROM sync_v2_migration WHERE phase = 'snapshot' AND error IS NULL LIMIT 1").get())) return;
    for (const task of tasks) await migrate(task);
    const seen = new Set(tasks.map((task) => task.threadId));
    const pendingTasks = withMessageTransaction((db) => z.array(storedTaskSchema).parse(db.prepare(
      `SELECT s.* FROM sync_v2_store s WHERE s.eligible = 1 AND EXISTS (
        SELECT 1 FROM sync_v2_sources u WHERE u.thread = s.threadId AND u.done = 0)`).all()));
    for (const task of pendingTasks) if (!seen.has(task.threadId)) await migrate(task);
    if (!withMessageTransaction((db) => db.prepare("SELECT ended FROM sync_v2_migration_log WHERE id = 1").get()!.ended)) {
      const status = migrationStatus();
      if (status.threads && status.threads === status.completed) {
        withMessageTransaction((db) => db.prepare("UPDATE sync_v2_migration_log SET ended = 1 WHERE id = 1").run());
        console.log(`chat sync v2: migration complete (${status.threads} threads, ${status.rows} local rows, ${status.published} versions)`);
      }
    }
    for (const target of host.bots()) {
      for (const threadId of await transport.threads(target.botSyncId)) await pull(threadId, target);
    }
  }

  return {
    schedule,
    migrationStatus,
    flush: (threadId: string) => serial(() => flush(threadId)),
    pull: (threadId: string) => serial(() => pull(threadId)),
    poll: () => serial(poll),
    messageWriter(threadId: string, messageId: string): string | null {
      const task = stored(threadId);
      return task ? engine.variants(task, "row", messageId)[0]?.version.origin ?? null : null;
    },
    start(): void {
      void serial(poll).catch(() => {});
      if (!pollTimer) {
        pollTimer = setInterval(() => void serial(poll).catch(() => {}), THREAD_SYNC_POLL_MS);
        pollTimer.unref?.();
      }
      const tasks = withMessageTransaction((db) => z.array(z.object({ threadId: z.string() })).parse(db.prepare("SELECT threadId FROM sync_v2_store").all()));
      for (const task of tasks) schedule(task.threadId);
    },
    stop(): void {
      clearInterval(pollTimer);
      pollTimer = undefined;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    async close(): Promise<void> {
      this.stop();
      host.store.setSyncWriter(undefined);
      await queue;
      await worker?.close();
      ownership.close();
    },
  };
}
