import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";

import { applySyncedRows, messageDatabase, withMessageTransaction } from "./message-db.ts";
import type { Message } from "./store.ts";
import { THREAD_SYNC_V2_HEAD_BYTES } from "./thread-sync-v2.ts";
import type { SealCrash, SyncApplyResult, SyncChange, SyncFlushResult, SyncFragment, SyncHead, SyncKind, SyncMutation, SyncOptions, SyncPacket, SyncRecovery, SyncScope, SyncSeen, SyncState, SyncVariant, SyncVersion } from "./thread-sync-v2.ts";

const idSchema = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const threadIdSchema = z.string().min(1).max(96).regex(/^[A-Za-z0-9_-]+$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const seenSchema = z.record(idSchema, integer);
const stampSchema = z.string().regex(/^[1-9]\d*:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/).nullable();
const rowSchema = z.object({ id: z.string().min(1).max(200), at: z.number().finite(), role: z.enum(["user", "bot"]), kind: z.string().min(1).max(40) }).passthrough();
const metadataSchema = z.object({ title: z.string().max(200), createdAt: integer }).strict();
const deleteSchema = z.object({ deletedAt: integer }).strict();
const versionSchema = z.object({
  seq: integer.positive(), seen: seenSchema, kind: z.enum(["row", "metadata", "head", "delete"]),
  rowId: z.string().max(200), baseStamp: stampSchema, value: z.unknown(), origin: idSchema.optional(),
  legacy: z.object({ sourceHash: z.string().regex(/^[a-f0-9]{64}$/), stamp: z.string().optional() }).strict().optional(),
}).strict();
const fragmentSchema = versionSchema.extend({
  kind: z.literal("fragment"),
  value: z.object({
    firstSeq: integer.positive(), index: integer, count: integer.positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/), data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }).strict(),
});
const headSchema = z.object({
  v: z.literal(2), threadId: threadIdSchema, writerId: idSchema, generation: integer.positive(),
  sealedThrough: integer, firstSeq: integer.positive(), lastSeq: integer, seen: seenSchema,
  versions: z.array(z.union([versionSchema, fragmentSchema])),
}).strict();

export const syncOptionsSchema = z.object({ folder: z.string().min(1), dataDir: z.string().min(1), deviceId: idSchema, headBytes: integer.optional(), staged: z.boolean().optional() });

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- Canonical hashing accepts validated sync values with arbitrary future row fields. */
export function syncContentHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof */

export function createSyncEngine(input: SyncOptions) {
  const options = syncOptionsSchema.parse(input);
  if (!options.dataDir || !options.folder || resolve(options.dataDir) === resolve(options.folder)) throw new Error("Separate local and sync directories are required");
  const headBytes = options.headBytes ?? THREAD_SYNC_V2_HEAD_BYTES;
  if (!Number.isSafeInteger(headBytes) || headBytes < 4096 || headBytes > THREAD_SYNC_V2_HEAD_BYTES) throw new Error("Invalid head size");
  mkdirSync(options.dataDir, { recursive: true });
  const database = messageDatabase();
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA synchronous = FULL");
  withMessageTransaction((db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_v2_identity (id INTEGER PRIMARY KEY CHECK (id = 1), device TEXT NOT NULL, writer TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_v2_threads (thread TEXT PRIMARY KEY, bot TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1,
        cut INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, head TEXT);
      CREATE TABLE IF NOT EXISTS sync_v2_packets (thread TEXT NOT NULL, writer TEXT NOT NULL, seq INTEGER NOT NULL,
        json TEXT NOT NULL, hash TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(thread, writer, seq));
      CREATE INDEX IF NOT EXISTS sync_v2_pending ON sync_v2_packets(thread, applied, writer, seq);
      CREATE TABLE IF NOT EXISTS sync_v2_progress (thread TEXT NOT NULL, writer TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(thread, writer));
      CREATE TABLE IF NOT EXISTS sync_v2_frontier (thread TEXT NOT NULL, kind TEXT NOT NULL, row_id TEXT NOT NULL,
        writer TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(thread, kind, row_id, writer, seq));
      CREATE TABLE IF NOT EXISTS sync_v2_heads (thread TEXT NOT NULL, writer TEXT NOT NULL, generation INTEGER NOT NULL,
        cut INTEGER NOT NULL, last_seq INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(thread, writer));
      CREATE TABLE IF NOT EXISTS sync_v2_seals (thread TEXT NOT NULL, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL,
        json TEXT NOT NULL, journaled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(thread, first_seq));
      CREATE TABLE IF NOT EXISTS sync_v2_files (thread TEXT NOT NULL, writer TEXT NOT NULL, name TEXT NOT NULL,
        PRIMARY KEY(thread, writer, name));
      CREATE TABLE IF NOT EXISTS sync_v2_quarantine (thread TEXT NOT NULL, writer TEXT NOT NULL, hash TEXT NOT NULL,
        reason TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(thread, writer, hash));
      CREATE TABLE IF NOT EXISTS sync_v2_changes (cursor INTEGER PRIMARY KEY, thread TEXT NOT NULL, kind TEXT NOT NULL,
        row_id TEXT NOT NULL, json TEXT NOT NULL, conflict INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sync_v2_changes_thread ON sync_v2_changes(thread, cursor);
      CREATE TABLE IF NOT EXISTS sync_v2_content (thread TEXT NOT NULL, kind TEXT NOT NULL, row_id TEXT NOT NULL,
        hash TEXT NOT NULL, PRIMARY KEY(thread, kind, row_id, hash));
      CREATE TABLE IF NOT EXISTS sync_v2_selection (thread TEXT NOT NULL, kind TEXT NOT NULL, row_id TEXT NOT NULL,
        writer TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(thread, kind, row_id));
    `);
    db.prepare("INSERT OR IGNORE INTO sync_v2_identity VALUES (1, ?, ?)").run(options.deviceId, randomUUID());
  });
  const statements = new Map<string, StatementSync>();
  const sql = (text: string): StatementSync => {
    let statement = statements.get(text);
    if (!statement) {
      statement = database!.prepare(text);
      statements.set(text, statement);
    }
    return statement;
  };
  function get<S extends z.ZodType>(schema: S, query: string, ...params: SQLInputValue[]): z.infer<S> {
    return schema.parse(sql(query).get(...params));
  }

  function all<S extends z.ZodType>(schema: S, query: string, ...params: SQLInputValue[]): z.infer<S>[] {
    return z.array(schema).parse(sql(query).all(...params));
  }

  const countSchema = z.object({ n: integer });
  const jsonSchema = z.object({ json: z.string() });
  const writerSeqSchema = z.object({ writer: idSchema, seq: integer });
  const writerSchema = z.object({ writer: idSchema });
  const writerJsonSchema = jsonSchema.extend({ writer: idSchema });
  const seqJsonSchema = jsonSchema.extend({ seq: integer });
  const botSchema = z.object({ bot: idSchema }).optional();
  const hashSchema = z.object({ hash: z.string() }).optional();
  const nextSeqSchema = z.object({ next_seq: integer });
  const sealSchema = jsonSchema.extend({ first_seq: integer, last_seq: integer });
  const localHeadSchema = z.object({ cut: integer, generation: integer, head: z.string().nullable() });
  const peerHeadSchema = z.object({ generation: integer, cut: integer, last_seq: integer, hash: z.string() });
  const identity = get(z.object({ device: idSchema, writer: idSchema }), "SELECT device, writer FROM sync_v2_identity WHERE id = 1");
  if (identity.device !== options.deviceId) throw new Error("This local sync database belongs to another device");
  const writerId = identity.writer;
  const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const emptyResult = (): SyncApplyResult => ({ applied: 0, rowsTouched: 0, sqlRowsTouched: 0, conflicts: 0, quarantined: 0, rejected: 0 });
  const totalChanges = () => get(countSchema, "SELECT total_changes() AS n").n;
  const stamp = (writer: string, seq: number) => `${seq}:${writer}`;
  const saw = (version: SyncVersion, writer: string, seq: number) => (version.seen[writer] ?? 0) >= seq;

  function scopeDir(scope: SyncScope): string {
    idSchema.parse(scope.botSyncId);
    threadIdSchema.parse(scope.threadId);
    const known = get(botSchema, "SELECT bot FROM sync_v2_threads WHERE thread = ?", scope.threadId)?.bot;
    if (known && known !== scope.botSyncId) throw new Error("Thread already belongs to another sync bot");
    if (!known) sql("INSERT OR IGNORE INTO sync_v2_threads(thread, bot) VALUES (?, ?)").run(scope.threadId, scope.botSyncId);
    return join(options.folder, "threads-v2", scope.botSyncId, scope.threadId);
  }

  function seen(thread: string): SyncSeen {
    const rows = all(writerSeqSchema, "SELECT writer, seq FROM sync_v2_progress WHERE thread = ?", thread);
    return Object.fromEntries(rows.map((row) => [row.writer, row.seq]));
  }

  function variants(scope: SyncScope, kind: SyncKind, rowId = ""): SyncVariant[] {
    scopeDir(scope);
    const preferred = sql("SELECT writer, seq FROM sync_v2_selection WHERE thread = ? AND kind = ? AND row_id = ?").get(scope.threadId, kind, rowId);
    const rank = (item: SyncVariant) => !item.version.legacy ? 0 : preferred?.writer === item.writerId && preferred?.seq === item.version.seq ? 1 : 2;
    return all(writerJsonSchema, "SELECT writer, json FROM sync_v2_frontier WHERE thread = ? AND kind = ? AND row_id = ? ORDER BY writer DESC, seq DESC", scope.threadId, kind, rowId)
      .map((row): SyncVariant => ({ writerId: row.writer, version: JSON.parse(row.json) }))
      .sort((a, b) => rank(a) - rank(b));
  }

  function validateVersion(version: SyncVersion): void {
    versionSchema.parse(version);
    if (version.kind === "row") {
      const row = rowSchema.parse(version.value);
      if (row.id !== version.rowId || !version.origin) throw new Error("Invalid row identity or file owner");
    } else {
      if (version.rowId !== "" || version.origin !== undefined) throw new Error("Invalid non-row identity");
      if (version.kind === "metadata") metadataSchema.parse(version.value);
      else if (version.kind === "head") z.string().max(200).nullable().parse(version.value);
      else deleteSchema.parse(version.value);
    }
    if (version.baseStamp) {
      const [seq, writer] = version.baseStamp.split(":");
      if ((version.seen[writer] ?? 0) < Number(seq)) throw new Error("Base stamp is outside version ancestry");
    }
  }

  function validateHead(bytes: Buffer, scope: SyncScope, writer: string): SyncHead {
    if (bytes.length > headBytes) throw new Error("Oversized sync file");
    const head: SyncHead = headSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (head.threadId !== scope.threadId || head.writerId !== writer || head.firstSeq !== head.sealedThrough + 1
      || head.lastSeq !== head.firstSeq + head.versions.length - 1) throw new Error("Invalid sync range");
    for (const [index, version] of head.versions.entries()) {
      if (version.seq !== head.firstSeq + index || (version.seen[writer] ?? 0) >= version.seq) throw new Error("Invalid version sequence");
      if (version.kind === "fragment") {
        const part = version.value;
        if (part.index >= part.count || version.seq !== part.firstSeq + part.index || !part.data
          || (version.seen[writer] ?? 0) >= part.firstSeq) throw new Error("Invalid fragment range");
      } else validateVersion(version);
    }
    return head;
  }

  function quarantine(thread: string, writer: string, bytes: Buffer, reason: string): number {
    return Number(sql("INSERT OR IGNORE INTO sync_v2_quarantine VALUES (?, ?, ?, ?, ?)").run(thread, writer, hash(bytes), reason, bytes).changes);
  }

  function applyVersion(scope: SyncScope, writer: string, version: SyncVersion, result: SyncApplyResult): void {
    const added = sql("INSERT OR IGNORE INTO sync_v2_content VALUES (?, ?, ?, ?)").run(scope.threadId, version.kind, version.rowId, syncContentHash(version.value)).changes;
    if (version.legacy && !added) return;
    const current = variants(scope, version.kind, version.rowId);
    if (current.some((old) => saw(old.version, writer, version.seq))) return;
    for (const old of current) {
      if (saw(version, old.writerId, old.version.seq)) {
        sql("DELETE FROM sync_v2_frontier WHERE thread = ? AND kind = ? AND row_id = ? AND writer = ? AND seq = ?")
          .run(scope.threadId, version.kind, version.rowId, old.writerId, old.version.seq);
      }
    }
    sql("INSERT INTO sync_v2_frontier VALUES (?, ?, ?, ?, ?, ?)")
      .run(scope.threadId, version.kind, version.rowId, writer, version.seq, JSON.stringify(version));
    if (version.legacy) {
      const prior = current[0];
      sql("INSERT INTO sync_v2_selection VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread, kind, row_id) DO UPDATE SET writer = excluded.writer, seq = excluded.seq")
        .run(scope.threadId, version.kind, version.rowId, prior?.writerId ?? writer, prior?.version.seq ?? version.seq);
    }
    const next = variants(scope, version.kind, version.rowId);
    const selected = next[0].version;
    const deletes = version.kind === "delete" ? next : variants(scope, "delete");
    const deletionConflict = version.kind === "delete"
      ? all(writerSeqSchema, "SELECT writer, seq FROM sync_v2_frontier WHERE thread = ? AND kind != 'delete'", scope.threadId)
        .some((row) => !deletes.some((item) => saw(item.version, row.writer, row.seq)))
      : deletes.some((item) => !saw(item.version, writer, version.seq));
    const conflict = next.length > 1 || deletionConflict;
    if (conflict) result.conflicts++;
    if (version.kind === "row" && !options.staged) {
      // SAFETY: validateVersion checks the row envelope and preserves future message fields.
      const row = selected.value as Message;
      result.rowsTouched += applySyncedRows(scope.threadId, [row], undefined, database!);
    }
    if (version.kind === "head" && !options.staged) result.rowsTouched += applySyncedRows(scope.threadId, [], z.string().nullable().parse(selected.value), database!);
    if (options.staged && writer === writerId && !version.legacy) return;
    sql("INSERT INTO sync_v2_changes(thread, kind, row_id, json, conflict) VALUES (?, ?, ?, ?, ?)")
      .run(scope.threadId, version.kind, version.rowId, JSON.stringify(selected.value), Number(conflict));
  }

  function assemble(thread: string, writer: string, packet: SyncFragment): SyncVersion {
    const part = packet.value;
    const rows = all(jsonSchema, "SELECT json FROM sync_v2_packets WHERE thread = ? AND writer = ? AND seq BETWEEN ? AND ? ORDER BY seq",
      thread, writer, part.firstSeq, part.firstSeq + part.count - 1);
    if (rows.length !== part.count) throw new Error("Missing version fragments");
    const pieces = rows.map((row, index) => {
      const fragment: SyncFragment = JSON.parse(row.json);
      if (fragment.kind !== "fragment" || fragment.value.firstSeq !== part.firstSeq || fragment.value.index !== index
        || fragment.value.count !== part.count || fragment.value.hash !== part.hash
        || !isDeepStrictEqual(fragment.seen, packet.seen) || fragment.baseStamp !== packet.baseStamp
        || fragment.rowId !== packet.rowId || fragment.origin !== packet.origin) throw new Error("Conflicting version fragments");
      return Buffer.from(fragment.value.data, "base64");
    });
    const bytes = Buffer.concat(pieces);
    if (hash(bytes) !== part.hash) throw new Error("Version fragment checksum mismatch");
    const version: SyncVersion = JSON.parse(bytes.toString("utf8"));
    validateVersion(version);
    if (version.seq !== part.firstSeq + part.count - 1 || version.rowId !== packet.rowId || version.origin !== packet.origin
      || version.baseStamp !== packet.baseStamp || !isDeepStrictEqual(version.seen, packet.seen)) throw new Error("Version fragment context mismatch");
    return version;
  }

  function advance(scope: SyncScope, writer: string, packet: SyncPacket, result: SyncApplyResult): void {
    if (packet.kind !== "fragment") applyVersion(scope, writer, packet, result);
    else if (packet.value.index === packet.value.count - 1) applyVersion(scope, writer, assemble(scope.threadId, writer, packet), result);
    sql("UPDATE sync_v2_packets SET applied = 1 WHERE thread = ? AND writer = ? AND seq = ?").run(scope.threadId, writer, packet.seq);
    sql("INSERT INTO sync_v2_progress VALUES (?, ?, ?) ON CONFLICT(thread, writer) DO UPDATE SET seq = excluded.seq")
      .run(scope.threadId, writer, packet.seq);
    result.applied++;
  }

  function packetsFor(version: SyncVersion): SyncPacket[] {
    const bytes = Buffer.from(JSON.stringify(version));
    if (bytes.length < headBytes / 2) return [version];
    const chunkSize = Math.floor(headBytes / 4);
    let count = Math.ceil(bytes.length / chunkSize);
    let encoded: Buffer;
    for (;;) {
      encoded = Buffer.from(JSON.stringify({ ...version, seq: version.seq + count - 1 }));
      const nextCount = Math.ceil(encoded.length / chunkSize);
      if (nextCount === count) break;
      count = nextCount;
    }
    const checksum = hash(encoded);
    return Array.from({ length: count }, (_, index) => {
      const packet: SyncFragment = {
        seq: version.seq + index, seen: version.seen, kind: "fragment", rowId: version.rowId, baseStamp: version.baseStamp,
        value: { firstSeq: version.seq, index, count, hash: checksum, data: encoded.subarray(index * chunkSize, (index + 1) * chunkSize).toString("base64") },
      };
      if (version.origin) packet.origin = version.origin;
      return packet;
    });
  }

  function commit(scope: SyncScope, mutations: Array<SyncMutation | SyncRecovery>, crash?: string, localWrite?: (db: DatabaseSync) => void, recovery = false): SyncApplyResult {
    scopeDir(scope);
    if (mutations.length > 128) throw new Error("Sync batches are limited to 128 changes");
    const result = emptyResult();
    const before = totalChanges();
    withMessageTransaction(() => {
      localWrite?.(database!);
      let seq = get(nextSeqSchema, "SELECT next_seq FROM sync_v2_threads WHERE thread = ?", scope.threadId).next_seq;
      const context = seen(scope.threadId);
      for (const mutation of mutations) {
        const rowId = mutation.kind === "row" ? mutation.value.id : "";
        if (recovery && sql("SELECT 1 FROM sync_v2_content WHERE thread = ? AND kind = ? AND row_id = ? AND hash = ?")
          .get(scope.threadId, mutation.kind, rowId, syncContentHash(mutation.value))) continue;
        const current = variants(scope, mutation.kind, rowId)[0];
        let origin: string | undefined;
        if (mutation.kind === "row") {
          const { reactions: _reactions, ...content } = mutation.value;
          // SAFETY: A row frontier only contains values checked by validateVersion.
          const { reactions: _priorReactions, ...priorContent } = (current?.version.value ?? {}) as Message;
          origin = mutation.origin ?? (current && isDeepStrictEqual(content, priorContent) ? current.version.origin : options.deviceId);
        }
        const version: SyncVersion = {
          seq, seen: recovery ? {} : { ...context }, kind: mutation.kind, rowId,
          baseStamp: !recovery && current ? stamp(current.writerId, current.version.seq) : null, value: mutation.value,
        };
        if (recovery && "legacy" in mutation) version.legacy = mutation.legacy;
        if (origin) version.origin = origin;
        validateVersion(version);
        const packets = packetsFor(version);
        for (const packet of packets) {
          const json = JSON.stringify(packet);
          sql("INSERT INTO sync_v2_packets(thread, writer, seq, json, hash) VALUES (?, ?, ?, ?, ?)").run(scope.threadId, writerId, packet.seq, json, hash(json));
          advance(scope, writerId, packet, result);
        }
        seq += packets.length;
        context[writerId] = seq - 1;
      }
      sql("UPDATE sync_v2_threads SET next_seq = ? WHERE thread = ?").run(seq, scope.threadId);
      if (crash === "before-commit") process.exit(91);
    });
    if (crash === "after-commit") process.exit(91);
    result.sqlRowsTouched = totalChanges() - before;
    return result;
  }

  function durableFile(path: string, bytes: Buffer, immutable = false): void {
    const tmp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      if (!immutable) renameSync(tmp, path);
      else {
        try {
          linkSync(tmp, path);
        } catch (error) {
          // SAFETY: Node filesystem errors carry a string code.
          const code = (error as NodeJS.ErrnoException).code;
          // One PC owns this writer directory, so a refused link can rename into place.
          if (code !== "EEXIST" && !existsSync(path)) renameSync(tmp, path);
          else throw error;
        }
      }
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }

  function document(scope: SyncScope, generation: number, cut: number, versions: SyncPacket[]): SyncHead {
    return {
      v: 2, threadId: scope.threadId, writerId, generation, sealedThrough: cut,
      firstSeq: cut + 1, lastSeq: versions.at(-1)?.seq ?? cut, seen: seen(scope.threadId), versions,
    };
  }

  function publishSegment(dir: string, seal: { first_seq: number; last_seq: number; json: string }, scope: SyncScope): number {
    const path = join(dir, `seg-${seal.first_seq}-${seal.last_seq}.json.gz`);
    let written = 0;
    if (!existsSync(path)) {
      const bytes = gzipSync(seal.json);
      durableFile(path, bytes, true);
      written = bytes.length;
    }
    const compressed = readFileSync(path);
    const decoded = gunzipSync(compressed, { maxOutputLength: headBytes });
    if (decoded.toString("utf8") !== seal.json) {
      quarantine(scope.threadId, writerId, compressed, "Immutable segment changed");
      throw new Error("Immutable segment changed");
    }
    validateHead(decoded, scope, writerId);
    return written;
  }

  function flush(scope: SyncScope, crash?: SealCrash, through?: number): SyncFlushResult {
    const dir = join(scopeDir(scope), writerId);
    mkdirSync(dir, { recursive: true });
    let bytesWritten = 0;
    let state = get(localHeadSchema, "SELECT cut, generation, head FROM sync_v2_threads WHERE thread = ?", scope.threadId);
    const lastSeq = integer.parse(through ?? get(nextSeqSchema, "SELECT next_seq FROM sync_v2_threads WHERE thread = ?", scope.threadId).next_seq - 1);
    const previousHead: SyncHead | null = state.head ? JSON.parse(state.head) : null;
    if (lastSeq < Math.max(state.cut, previousHead?.lastSeq ?? 0)) throw new Error("Cannot rewind a published sync head");
    const sealPrefix = (seal: { first_seq: number; last_seq: number; json: string }) => {
      if (crash === "before-publish") process.exit(91);
      bytesWritten += publishSegment(dir, seal, scope);
      if (crash === "after-publish") process.exit(91);
      withMessageTransaction(() => {
        sql("UPDATE sync_v2_seals SET journaled = 1 WHERE thread = ? AND first_seq = ?").run(scope.threadId, seal.first_seq);
      });
      if (crash === "after-journal") process.exit(91);
      withMessageTransaction(() => {
        sql("UPDATE sync_v2_threads SET cut = ? WHERE thread = ?").run(seal.last_seq, scope.threadId);
      });
      state.cut = seal.last_seq;
      if (crash === "after-trim") process.exit(91);
    };
    const unfinished = all(sealSchema, "SELECT first_seq, last_seq, json FROM sync_v2_seals WHERE thread = ? AND last_seq > ? ORDER BY first_seq", scope.threadId, state.cut);
    for (const seal of unfinished) sealPrefix(seal);
    for (;;) {
      const versions: SyncPacket[] = [];
      let size = Buffer.byteLength(JSON.stringify(document(scope, state.generation + 1, state.cut, [])));
      let overflow = false;
      let cursor = state.cut;
      for (;;) {
        const page = all(seqJsonSchema, "SELECT seq, json FROM sync_v2_packets WHERE thread = ? AND writer = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT 128", scope.threadId, writerId, cursor, lastSeq);
        for (const row of page) {
          const packet: SyncPacket = JSON.parse(row.json);
          const added = Buffer.byteLength(row.json) + Number(versions.length > 0)
            + String(packet.seq).length - String(versions.at(-1)?.seq ?? state.cut).length;
          if (size + added > headBytes) {
            overflow = true;
            break;
          }
          size += added;
          versions.push(packet);
          cursor = row.seq;
        }
        if (overflow || page.length < 128) break;
      }
      if (overflow) {
        if (!versions.length) throw new Error("Version context exceeds the head size");
        const seal = { first_seq: state.cut + 1, last_seq: versions.at(-1)!.seq, json: JSON.stringify(document(scope, state.generation + 1, state.cut, versions)) };
        withMessageTransaction(() => {
          sql("INSERT INTO sync_v2_seals(thread, first_seq, last_seq, json) VALUES (?, ?, ?, ?)").run(scope.threadId, seal.first_seq, seal.last_seq, seal.json);
        });
        sealPrefix(seal);
        continue;
      }
      const candidate = document(scope, state.generation || 1, state.cut, versions);
      const previous: SyncHead | null = state.head ? JSON.parse(state.head) : null;
      if (!previous || previous.lastSeq !== candidate.lastSeq || previous.sealedThrough !== candidate.sealedThrough) {
        candidate.generation = state.generation + 1;
        state = { ...state, generation: candidate.generation, head: JSON.stringify(candidate) };
        withMessageTransaction(() => {
          sql("UPDATE sync_v2_threads SET generation = ?, head = ? WHERE thread = ?").run(state.generation, state.head, scope.threadId);
        });
      }
      const bytes = Buffer.from(state.head!);
      const path = join(dir, "head.json");
      if (!existsSync(path) || !readFileSync(path).equals(bytes)) {
        durableFile(path, bytes);
        bytesWritten += bytes.length;
      }
      const segments = get(countSchema, "SELECT COUNT(*) AS n FROM sync_v2_seals WHERE thread = ?", scope.threadId).n;
      return { bytesWritten, headBytes: bytes.length, segments, sealedThrough: state.cut };
    }
  }

  function ingest(scope: SyncScope, writer: string, head: SyncHead, bytes: Buffer, segment: boolean, result: SyncApplyResult): boolean {
    const prior = get(peerHeadSchema.optional(), "SELECT generation, cut, last_seq, hash FROM sync_v2_heads WHERE thread = ? AND writer = ?", scope.threadId, writer);
    if (!segment && prior) {
      if (head.generation < prior.generation || head.sealedThrough < prior.cut || head.lastSeq < prior.last_seq) { result.rejected++; return false; }
      if (head.generation === prior.generation && hash(bytes) !== prior.hash) {
        result.quarantined += quarantine(scope.threadId, writer, bytes, "Head generation changed bytes");
        result.rejected++;
        return false;
      }
      if (head.generation === prior.generation) return true;
    }
    for (const packet of head.versions) {
      const known = get(hashSchema, "SELECT hash FROM sync_v2_packets WHERE thread = ? AND writer = ? AND seq = ?", scope.threadId, writer, packet.seq);
      if (known && known.hash !== hash(JSON.stringify(packet))) {
        result.quarantined += quarantine(scope.threadId, writer, bytes, `Conflicting bytes for sequence ${packet.seq}`);
        result.rejected++;
        return false;
      }
    }
    withMessageTransaction(() => {
      for (const packet of head.versions) {
        const json = JSON.stringify(packet);
        sql("INSERT OR IGNORE INTO sync_v2_packets(thread, writer, seq, json, hash) VALUES (?, ?, ?, ?, ?)")
          .run(scope.threadId, writer, packet.seq, json, hash(json));
      }
      if (!segment) sql("INSERT INTO sync_v2_heads VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread, writer) DO UPDATE SET generation = excluded.generation, cut = excluded.cut, last_seq = excluded.last_seq, hash = excluded.hash")
        .run(scope.threadId, writer, head.generation, head.sealedThrough, head.lastSeq, hash(bytes));
    });
    return true;
  }

  function drain(scope: SyncScope, result: SyncApplyResult, limit = Infinity): void {
    const writers = all(writerSchema, "SELECT DISTINCT writer FROM sync_v2_packets WHERE thread = ? AND applied = 0", scope.threadId);
    for (;;) {
      let advanced = 0;
      for (const { writer } of writers) {
        const context = seen(scope.threadId);
        const start = (context[writer] ?? 0) + 1;
        const page = all(jsonSchema, "SELECT json FROM sync_v2_packets WHERE thread = ? AND writer = ? AND seq >= ? ORDER BY seq LIMIT 128", scope.threadId, writer, start);
        let expected = start;
        withMessageTransaction(() => {
          for (const row of page) {
            const packet: SyncPacket = JSON.parse(row.json);
            if (packet.seq !== expected || Object.entries(packet.seen).some(([peer, seq]) => (context[peer] ?? 0) < seq)) break;
            try {
              if (packet.kind === "fragment" && packet.value.index === packet.value.count - 1) assemble(scope.threadId, writer, packet);
            } catch (error) {
              result.quarantined += quarantine(scope.threadId, writer, Buffer.from(row.json), String(error));
              result.rejected++;
              break;
            }
            advance(scope, writer, packet, result);
            context[writer] = packet.seq;
            expected++;
            advanced++;
            if (result.applied >= limit) break;
          }
        });
        if (result.applied >= limit) return;
      }
      if (!advanced) break;
    }
  }

  function pull(scope: SyncScope): SyncApplyResult {
    const dir = scopeDir(scope);
    const result = emptyResult();
    const before = totalChanges();
    if (!existsSync(dir)) return result;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !idSchema.safeParse(entry.name).success || entry.name === writerId) continue;
      const writer = entry.name;
      const writerDir = join(dir, writer);
      const names = readdirSync(writerDir).filter((name) => name === "head.json" || /^seg-[1-9]\d*-[1-9]\d*\.json\.gz$/.test(name));
      for (const name of names) {
        const segment = name !== "head.json";
        if (segment && sql("SELECT 1 FROM sync_v2_files WHERE thread = ? AND writer = ? AND name = ?").get(scope.threadId, writer, name)) continue;
        let bytes: Buffer;
        let head: SyncHead;
        try {
          bytes = readFileSync(join(writerDir, name));
          if (segment) bytes = gunzipSync(bytes, { maxOutputLength: headBytes });
          head = validateHead(bytes, scope, writer);
          if (segment && name !== `seg-${head.firstSeq}-${head.lastSeq}.json.gz`) throw new Error("Segment filename range mismatch");
        } catch {
          result.rejected++;
          continue;
        }
        if (ingest(scope, writer, head, bytes, segment, result) && segment) {
          sql("INSERT OR IGNORE INTO sync_v2_files VALUES (?, ?, ?)").run(scope.threadId, writer, name);
        }
      }
    }
    if (!options.staged) drain(scope, result);
    result.sqlRowsTouched = totalChanges() - before;
    return result;
  }

  function state(scope: SyncScope): SyncState {
    scopeDir(scope);
    const deletes = variants(scope, "delete");
    let deleteConflicts = 0;
    if (deletes.length) {
      const rows = all(writerSeqSchema, "SELECT writer, seq FROM sync_v2_frontier WHERE thread = ? AND kind != 'delete'", scope.threadId);
      deleteConflicts = rows.filter((row) => !deletes.some((deletion) => saw(deletion.version, row.writer, row.seq))).length;
    }
    return {
      writerId, seen: seen(scope.threadId), deleted: deletes.some((item) => !item.version.legacy) && deleteConflicts === 0, deleteConflicts,
      quarantined: get(countSchema, "SELECT COUNT(*) AS n FROM sync_v2_quarantine WHERE thread = ?", scope.threadId).n,
      outbox: get(countSchema, "SELECT COUNT(*) AS n FROM sync_v2_packets WHERE thread = ? AND writer = ?", scope.threadId, writerId).n,
    };
  }

  function changes(scope: SyncScope, after = 0, limit = 128): SyncChange[] {
    scopeDir(scope);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("Invalid change page");
    return all(jsonSchema.extend({ cursor: integer, kind: z.enum(["row", "metadata", "head", "delete"]), row_id: z.string(), conflict: integer }),
      "SELECT cursor, kind, row_id, json, conflict FROM sync_v2_changes WHERE thread = ? AND cursor > ? ORDER BY cursor LIMIT ?", scope.threadId, after, limit)
      .map((row) => ({ cursor: row.cursor, kind: row.kind, rowId: row.row_id, value: JSON.parse(row.json), conflict: Boolean(row.conflict) }));
  }

  function applyPending(scope: SyncScope): SyncApplyResult {
    scopeDir(scope);
    const result = emptyResult();
    drain(scope, result, 128);
    return result;
  }

  function threads(botSyncId: string): string[] {
    const dir = join(options.folder, "threads-v2", idSchema.parse(botSyncId));
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && threadIdSchema.safeParse(entry.name).success)
      .map((entry) => entry.name);
  }

  function conflicted(scope: SyncScope): boolean {
    return state(scope).deleteConflicts > 0 || Boolean(sql(
      "SELECT 1 FROM sync_v2_frontier WHERE thread = ? GROUP BY kind, row_id HAVING COUNT(*) > 1 LIMIT 1",
    ).get(scope.threadId));
  }

  function recoveryRows(scope: SyncScope, after = ""): SyncChange[] {
    const rows = all(z.object({ row_id: z.string() }),
      "SELECT DISTINCT row_id FROM sync_v2_frontier WHERE thread = ? AND kind = 'row' AND row_id > ? ORDER BY row_id LIMIT 128",
      scope.threadId, after);
    return rows.map(({ row_id }) => ({
      cursor: 0, kind: "row", rowId: row_id, value: variants(scope, "row", row_id)[0].version.value, conflict: false,
    }));
  }

  const recover = (scope: SyncScope, mutations: SyncRecovery[], crash?: string) => commit(scope, mutations, crash, undefined, true);
  return { commit, recover, flush, pull, state, variants, changes, applyPending, threads, conflicted, recoveryRows };
}
