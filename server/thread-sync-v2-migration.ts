import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { messageDatabase, withMessageTransaction } from "./message-db.ts";
import { redactBotAuthored, type Message } from "./store.ts";
import { CONFLICT_NOTICE, fileSchema, shared } from "./thread-sync.ts";
import { createSyncEngine, syncContentHash } from "./thread-sync-v2-engine.ts";
import { readLegacyFields } from "./thread-sync-v2-json.ts";
import type { LegacyField } from "./thread-sync-v2-json.ts";
import type { SyncOptions, SyncRecovery, SyncScope } from "./thread-sync-v2.ts";

export type MigrationCrash = "snapshot" | "source" | "pull" | "outbox" | "complete";
export interface MigrationProgress {
  phase: "snapshot" | "legacy" | "pull" | "recover" | "done";
  rows: number;
  published: number;
  sources: number;
  pending: number;
  localReady: boolean;
  error: string | null;
  heapBytes: number;
  baselineHeapBytes: number;
}

interface LegacyProvenance { stamps?: Record<string, string>; origins?: Record<string, string> }

export function initializeMigration(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_v2_migration (thread TEXT PRIMARY KEY, bot TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'snapshot', cursor INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL, head TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, error TEXT,
      local_state INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sync_v2_snapshot (thread TEXT NOT NULL, row_id TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY(thread, row_id));
    CREATE TABLE IF NOT EXISTS sync_v2_sources (id INTEGER PRIMARY KEY, thread TEXT NOT NULL, path TEXT NOT NULL,
      hash TEXT, cursor INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, UNIQUE(thread, path));
    CREATE TABLE IF NOT EXISTS sync_v2_source_fields (source INTEGER NOT NULL, key TEXT NOT NULL, child TEXT NOT NULL,
      json TEXT NOT NULL, PRIMARY KEY(source, key, child));
    CREATE TABLE IF NOT EXISTS sync_v2_legacy_bots (bot TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sync_v2_legacy_files (bot TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(bot, name));
    CREATE TABLE IF NOT EXISTS sync_v2_pictures (id INTEGER PRIMARY KEY, thread TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS sync_v2_snapshot_update BEFORE UPDATE ON messages
    WHEN EXISTS (SELECT 1 FROM sync_v2_migration WHERE thread = OLD.thread_id AND phase = 'snapshot') BEGIN
      INSERT OR IGNORE INTO sync_v2_snapshot VALUES (OLD.thread_id, OLD.id, OLD.json);
    END;
    CREATE TRIGGER IF NOT EXISTS sync_v2_snapshot_delete BEFORE DELETE ON messages
    WHEN EXISTS (SELECT 1 FROM sync_v2_migration WHERE thread = OLD.thread_id AND phase = 'snapshot') BEGIN
      INSERT OR IGNORE INTO sync_v2_snapshot VALUES (OLD.thread_id, OLD.id, OLD.json);
    END;
  `);
}

export function registerMigration(db: DatabaseSync, scope: SyncScope, title: string, createdAt: number): void {
  db.prepare(`INSERT OR IGNORE INTO sync_v2_migration(thread, bot, metadata, head)
    VALUES (?, ?, ?, ?)`)
    .run(scope.threadId, scope.botSyncId, JSON.stringify({ title, createdAt }),
      JSON.stringify(db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(scope.threadId)?.active_leaf_id ?? null));
}

export function createThreadMigration(options: SyncOptions, engine: ReturnType<typeof createSyncEngine>) {
  const db = messageDatabase();
  initializeMigration(db);
  const readers = new Map<string, AsyncGenerator<LegacyField, string>>();
  const deferred = new Map<string, Set<number>>();
  let provenanceThread = "";
  let provenance: LegacyProvenance = {};
  const baselineHeapBytes = process.memoryUsage().heapUsed;
  const taskSchema = z.object({ phase: z.enum(["snapshot", "legacy", "pull", "recover", "done"]), cursor: z.number(), metadata: z.string(), head: z.string(), published: z.number(), error: z.string().nullable() });
  const task = (scope: SyncScope) => taskSchema.parse(db.prepare("SELECT * FROM sync_v2_migration WHERE thread = ?").get(scope.threadId));
  const crashAt = (point: MigrationCrash, crash?: MigrationCrash) => { if (point === crash) process.exit(92); };

  function files(botSyncId: string): string[] {
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/).parse(botSyncId);
    if (!existsSync(options.folder)) throw new Error("Sync folder is unavailable");
    try { return readdirSync(join(options.folder, "threads", botSyncId)).filter((name) => /^([A-Za-z0-9_-]{1,96})(\.conflict-[^/\\]+|\.deleted)?\.json$/.test(name)).sort(); }
    catch (error) {
      // SAFETY: Filesystem failures expose Node's errno code.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  function discover(botSyncId: string): string[] {
    if (!db.prepare("SELECT 1 FROM sync_v2_legacy_bots WHERE bot = ?").get(botSyncId)) {
      const names = files(botSyncId);
      withMessageTransaction(() => {
        for (const name of names) db.prepare("INSERT OR IGNORE INTO sync_v2_legacy_files VALUES (?, ?)").run(botSyncId, name);
        db.prepare("INSERT INTO sync_v2_legacy_bots VALUES (?)").run(botSyncId);
      });
    }
    return [...new Set(db.prepare("SELECT name FROM sync_v2_legacy_files WHERE bot = ?").all(botSyncId).map((row) => String(row.name).split(".")[0]))];
  }

  function progress(scope: SyncScope): MigrationProgress {
    const current = task(scope);
    return {
      phase: current.phase, published: current.published, error: current.error,
      rows: Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_snapshot WHERE thread = ?").get(scope.threadId)!.n),
      sources: Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_sources WHERE thread = ? AND done = 1").get(scope.threadId)!.n),
      pending: Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_sources WHERE thread = ? AND done = 0").get(scope.threadId)!.n),
      localReady: current.phase === "done" || (current.phase === "recover"
        && !db.prepare("SELECT 1 FROM sync_v2_snapshot WHERE thread = ? AND rowid > ? LIMIT 1").get(scope.threadId, current.cursor)),
      heapBytes: process.memoryUsage().heapUsed,
      baselineHeapBytes,
    };
  }

  function project(scope: SyncScope, message: Message, source?: number): Message[] {
    const visited = new Set<string>();
    let parent = message.parentId;
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      const row = source === undefined
        ? db.prepare("SELECT json FROM sync_v2_snapshot WHERE thread = ? AND row_id = ?").get(scope.threadId, parent)
        : db.prepare("SELECT json FROM sync_v2_source_fields WHERE source = ? AND key = 'notice' AND child = ?").get(source, parent);
      if (!row) break;
      const prior: Message = JSON.parse(String(row.json));
      if (prior.kind !== "activity" || prior.tool?.name !== `error: ${CONFLICT_NOTICE}`) break;
      parent = prior.parentId;
    }
    const projected = redactBotAuthored({ ...message, parentId: parent });
    if (projected.kind === "screen" && projected.image) projected.hasImage = true;
    return shared({ title: "", createdAt: 0, messages: [projected], activeLeafId: null }).messages;
  }

  function recover(scope: SyncScope, mutations: SyncRecovery[]): void {
    const result = engine.recover(scope, mutations);
    for (const mutation of mutations) {
      if (mutation.kind === "row" && (mutation.value.image || mutation.value.text?.includes("<attached-image"))) {
        db.prepare("INSERT INTO sync_v2_pictures(thread, json) VALUES (?, ?)").run(scope.threadId, JSON.stringify(mutation.value));
      }
    }
    db.prepare("UPDATE sync_v2_migration SET published = published + ? WHERE thread = ?").run(result.applied, scope.threadId);
  }

  function head(scope: SyncScope, value: string | null, source?: number): string | null {
    return project(scope, { id: "head", at: 0, kind: "text", role: "user", parentId: value }, source)[0].parentId ?? null;
  }

  function localRecovery(scope: SyncScope, value: Message): SyncRecovery {
    if (provenanceThread !== scope.threadId) {
      provenanceThread = scope.threadId;
      const path = join(options.dataDir, "thread-sync-rows", `${scope.threadId}.json`);
      provenance = existsSync(path) ? z.object({ stamps: z.record(z.string(), z.string()).optional(), origins: z.record(z.string(), z.string()).optional() })
        .parse(JSON.parse(readFileSync(path, "utf8"))) : {};
    }
    const stamp = provenance.stamps?.[value.id];
    const legacy: SyncRecovery["legacy"] = { sourceHash: syncContentHash(value) };
    if (stamp) legacy.stamp = stamp;
    const origin = provenance.origins?.[value.id] ?? stamp?.slice(stamp.indexOf(":") + 1) ?? options.deviceId;
    return { kind: "row", value, origin, legacy };
  }

  async function snapshotFile(scope: SyncScope): Promise<boolean> {
    let state = Number(db.prepare("SELECT local_state FROM sync_v2_migration WHERE thread = ?").get(scope.threadId)!.local_state);
    let path = join(options.dataDir, `messages-${scope.threadId}.json`);
    if (!state) {
      state = !db.prepare("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1").get(scope.threadId) && existsSync(path) ? 1 : 2;
      db.prepare("UPDATE sync_v2_migration SET local_state = ? WHERE thread = ?").run(state, scope.threadId);
    }
    if (state === 2) return true;
    if (!existsSync(path) && existsSync(`${path}.imported`)) path += ".imported";
    const key = `local:${scope.threadId}`;
    let reader = readers.get(key);
    if (!reader) { reader = readLegacyFields(path); readers.set(key, reader); }
    const fields: LegacyField[] = [];
    let complete = false;
    for (let i = 0; i < 128; i++) {
      const next = await reader.next();
      if (next.done) { complete = true; break; }
      fields.push(next.value);
    }
    withMessageTransaction(() => {
      for (const field of fields) {
        if (field.key === "messages" && field.child !== undefined) {
          const row: Message = JSON.parse(field.json);
          db.prepare("INSERT OR IGNORE INTO sync_v2_snapshot VALUES (?, ?, ?)").run(scope.threadId, row.id, field.json);
        } else if (field.key === "activeLeafId") {
          db.prepare("UPDATE sync_v2_migration SET head = ? WHERE thread = ?").run(field.json, scope.threadId);
        }
      }
      if (complete) db.prepare("UPDATE sync_v2_migration SET local_state = 2 WHERE thread = ?").run(scope.threadId);
    });
    if (complete) readers.delete(key);
    return complete;
  }

  function unhashed(scope: SyncScope): Array<{ id: number; path: string }> {
    const skip = deferred.get(scope.threadId) ?? new Set<number>();
    // SAFETY: This projection selects the source id and path columns.
    return (db.prepare("SELECT id, path FROM sync_v2_sources WHERE thread = ? AND hash IS NULL ORDER BY id").all(scope.threadId) as Array<{ id: number | bigint; path: string }>)
      .map((row) => ({ id: Number(row.id), path: String(row.path) }))
      .filter((row) => !skip.has(row.id));
  }

  async function dropSourceRead(id: number): Promise<void> {
    const reader = readers.get(String(id));
    if (reader) { await reader.return(""); readers.delete(String(id)); }
    db.prepare("DELETE FROM sync_v2_source_fields WHERE source = ?").run(id);
  }

  async function ingest(scope: SyncScope, source: { id: number; path: string }): Promise<void> {
    const id = source.id;
    let reader = readers.get(String(id));
    if (!reader) {
      db.prepare("DELETE FROM sync_v2_source_fields WHERE source = ?").run(id);
      reader = readLegacyFields(source.path);
      readers.set(String(id), reader);
    }
    const fields: LegacyField[] = [];
    let hash: string | undefined;
    for (let i = 0; i < 128; i++) {
      const next = await reader.next();
      if (next.done) { hash = next.value; break; }
      fields.push(next.value);
    }
    withMessageTransaction(() => {
      for (const field of fields) {
        db.prepare("INSERT OR REPLACE INTO sync_v2_source_fields VALUES (?, ?, ?, ?)").run(id, field.key, field.child ?? "", field.json);
        if (field.key === "messages" && field.child !== undefined) {
          const row: Message = JSON.parse(field.json);
          if (row.kind === "activity" && row.tool?.name === `error: ${CONFLICT_NOTICE}`) {
            db.prepare("INSERT OR REPLACE INTO sync_v2_source_fields VALUES (?, 'notice', ?, ?)").run(id, row.id, field.json);
          }
        }
      }
      if (hash) {
        const envelope = Object.fromEntries(db.prepare("SELECT key, json FROM sync_v2_source_fields WHERE source = ? AND child = ''").all(id).map((row) => [String(row.key), JSON.parse(String(row.json))]));
        if (!source.path.endsWith(".deleted.json")) {
          const parsed = fileSchema.parse(envelope);
          if (parsed.task.threadId !== scope.threadId) throw new Error("Legacy thread identity mismatch");
        }
        db.prepare("UPDATE sync_v2_sources SET hash = ? WHERE id = ?").run(hash, id);
        readers.delete(String(id));
      }
    });
  }

  async function retryUnhashed(scope: SyncScope): Promise<void> {
    let failure: unknown;
    for (const source of unhashed(scope)) {
      try {
        await ingest(scope, source);
        return;
      } catch (error) {
        await dropSourceRead(source.id);
        failure = error;
      }
    }
    if (failure) throw failure;
  }

  async function step(scope: SyncScope, crash?: MigrationCrash, deferUnreadable = false): Promise<MigrationProgress> {
    const current = task(scope);
    try {
      if (current.phase === "snapshot") {
        if (!await snapshotFile(scope)) { crashAt("snapshot", crash); return progress(scope); }
        withMessageTransaction(() => {
          const page = db.prepare("SELECT rowid AS cursor, id, json FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT 128").all(scope.threadId, current.cursor);
          for (const row of page) db.prepare("INSERT OR IGNORE INTO sync_v2_snapshot VALUES (?, ?, ?)").run(scope.threadId, String(row.id), String(row.json));
          if (page.length) db.prepare("UPDATE sync_v2_migration SET cursor = ? WHERE thread = ?").run(Number(page.at(-1)!.cursor), scope.threadId);
          else {
            discover(scope.botSyncId);
            const names = db.prepare("SELECT name FROM sync_v2_legacy_files WHERE bot = ?").all(scope.botSyncId).map((row) => String(row.name));
            for (const name of names.filter((name) => name.split(".")[0] === scope.threadId)) {
              db.prepare("INSERT OR IGNORE INTO sync_v2_sources(thread, path) VALUES (?, ?)").run(scope.threadId, join(options.folder, "threads", scope.botSyncId, name));
            }
            db.prepare("UPDATE sync_v2_migration SET phase = 'legacy', cursor = 0 WHERE thread = ?").run(scope.threadId);
          }
        });
        crashAt("snapshot", crash);
      } else if (current.phase === "legacy") {
        for (;;) {
          const source = unhashed(scope)[0];
          if (!source) {
            db.prepare("UPDATE sync_v2_migration SET phase = 'pull' WHERE thread = ?").run(scope.threadId);
            deferred.delete(scope.threadId);
            break;
          }
          try {
            await ingest(scope, source);
            crashAt("source", crash);
            break;
          } catch (error) {
            if (!deferUnreadable) throw error;
            await dropSourceRead(source.id);
            const set = deferred.get(scope.threadId) ?? new Set<number>();
            set.add(source.id);
            deferred.set(scope.threadId, set);
          }
        }
      } else if (current.phase === "pull") {
        engine.pull(scope);
        db.prepare("UPDATE sync_v2_migration SET phase = 'recover', cursor = 0 WHERE thread = ?").run(scope.threadId);
        crashAt("pull", crash);
      } else if (current.phase === "recover") {
        const snapshotLeft = db.prepare("SELECT 1 FROM sync_v2_snapshot WHERE thread = ? AND rowid > ? LIMIT 1").get(scope.threadId, current.cursor);
        const hashedLeft = db.prepare("SELECT 1 FROM sync_v2_sources WHERE thread = ? AND done = 0 AND hash IS NOT NULL LIMIT 1").get(scope.threadId);
        if (!snapshotLeft && !hashedLeft && unhashed(scope).length) await retryUnhashed(scope);
        else {
          withMessageTransaction(() => {
            const page = db.prepare("SELECT rowid AS cursor, json FROM sync_v2_snapshot WHERE thread = ? AND rowid > ? ORDER BY rowid LIMIT 126").all(scope.threadId, current.cursor);
            const legacy = { sourceHash: syncContentHash({ device: options.deviceId, thread: scope.threadId }) };
            const mutations: SyncRecovery[] = page.flatMap((row) => project(scope, JSON.parse(String(row.json))).map((value) => localRecovery(scope, value)));
            if (!current.cursor && page.length) mutations.unshift(
              { kind: "metadata", value: JSON.parse(current.metadata), legacy },
              { kind: "head", value: head(scope, JSON.parse(current.head)), legacy },
            );
            recover(scope, mutations);
            if (page.length) db.prepare("UPDATE sync_v2_migration SET cursor = ? WHERE thread = ?").run(Number(page.at(-1)!.cursor), scope.threadId);
            else {
              const source = db.prepare("SELECT * FROM sync_v2_sources WHERE thread = ? AND done = 0 AND hash IS NOT NULL ORDER BY id LIMIT 1").get(scope.threadId);
              if (!source) {
                if (!unhashed(scope).length) db.prepare("UPDATE sync_v2_migration SET phase = 'done' WHERE thread = ?").run(scope.threadId);
              } else recoverSource(scope, source);
            }
            crashAt("outbox", crash);
          });
          if (task(scope).phase === "done") crashAt("complete", crash);
        }
      }
      db.prepare("UPDATE sync_v2_migration SET error = NULL WHERE thread = ?").run(scope.threadId);
    } catch (error) {
      for (const [id, reader] of readers) { await reader.return(""); readers.delete(id); }
      db.prepare("UPDATE sync_v2_migration SET error = ? WHERE thread = ?").run(error instanceof Error ? error.message : String(error), scope.threadId);
    }
    return progress(scope);
  }

  function recoverSource(scope: SyncScope, source: Record<string, string | number | bigint | Uint8Array | null>): void {
    const id = Number(source.id);
    const field = (key: string, child = "") => db.prepare("SELECT json FROM sync_v2_source_fields WHERE source = ? AND key = ? AND child = ?").get(id, key, child)?.json;
    const legacy = { sourceHash: String(source.hash) };
    if (String(source.path).endsWith(".deleted.json")) {
      recover(scope, [{ kind: "delete", value: { deletedAt: 0 }, legacy }]);
      db.prepare("UPDATE sync_v2_sources SET done = 1 WHERE id = ?").run(id);
      return;
    }
    const page = db.prepare("SELECT rowid AS cursor, json FROM sync_v2_source_fields WHERE source = ? AND key = 'messages' AND child != '' AND rowid > ? ORDER BY rowid LIMIT 126").all(id, Number(source.cursor));
    const mutations: SyncRecovery[] = [];
    for (const row of page) {
      for (const value of project(scope, JSON.parse(String(row.json)), id)) {
        const stamp = field("stamps", value.id);
        const origin = field("origins", value.id) ?? field("writerDeviceId");
        const provenance: SyncRecovery["legacy"] = { ...legacy };
        if (stamp) provenance.stamp = JSON.parse(String(stamp));
        mutations.push({ kind: "row", value, origin: JSON.parse(String(origin)), legacy: provenance });
      }
    }
    if (!Number(source.cursor)) {
      const metadata = z.object({ title: z.string(), createdAt: z.number() }).parse(JSON.parse(String(field("task"))));
      mutations.unshift({ kind: "metadata", value: metadata, legacy }, { kind: "head", value: head(scope, JSON.parse(String(field("activeLeafId"))), id), legacy });
    }
    recover(scope, mutations);
    db.prepare("UPDATE sync_v2_sources SET cursor = ?, done = ? WHERE id = ?").run(Number(page.at(-1)?.cursor ?? source.cursor), Number(page.length === 0), id);
  }

  return { step, progress, discover };
}
