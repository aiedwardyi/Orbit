import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

import { applySyncedRows, closeMessageDb, messageDatabase, scanThreadRows, withMessageTransaction } from "../message-db.ts";
import { createSyncEngine } from "../thread-sync-v2-engine.ts";
import { createThreadMigration, registerMigration, type MigrationCrash } from "../thread-sync-v2-migration.ts";
import type { Message } from "../store.ts";
import type { SyncMutation, SyncScope } from "../thread-sync-v2.ts";

const options = z.object({ dataDir: z.string(), folder: z.string(), deviceId: z.string() }).parse(workerData);
const engine = createSyncEngine(options);
const migration = createThreadMigration(options, engine);
export interface MigrationArgs {
  scope?: SyncScope;
  rows?: Message[];
  leaf?: string | null;
  mutations?: SyncMutation[];
  crash?: MigrationCrash;
  title?: string;
}
let queue = Promise.resolve();
parentPort!.on("message", (request: { id: number; method: string; args: MigrationArgs }) => {
  queue = queue.then(() => dispatch(request));
});

async function dispatch({ id, method, args }: { id: number; method: string; args: MigrationArgs }) {
  const scope = args.scope ?? { botSyncId: "bot", threadId: "thread" };
  try {
    let value;
    switch (method) {
      case "seed":
        applySyncedRows(scope.threadId, args.rows ?? [], args.leaf);
        break;
      case "begin":
        withMessageTransaction((db) => registerMigration(db, scope, args.title ?? "Chat", 1));
        break;
      case "step": value = await migration.step(scope, args.crash); break;
      case "run":
        for (let i = 0; i < 10000; i++) {
          const progress = await migration.step(scope);
          if (progress.error) throw new Error(progress.error);
          if (progress.phase === "done") { value = progress; break; }
        }
        break;
      case "commit": value = engine.commit(scope, args.mutations ?? []); break;
      case "pull": value = engine.pull(scope); break;
      case "flush": value = engine.flush(scope); break;
      case "snapshot": {
        const db = messageDatabase();
        value = {
          rows: scanThreadRows(scope.threadId, 0, 1024).messages,
          variants: db.prepare("SELECT json FROM sync_v2_frontier WHERE thread = ?").all(scope.threadId).map((row) => JSON.parse(String(row.json))),
          snapshot: db.prepare("SELECT json FROM sync_v2_snapshot WHERE thread = ?").all(scope.threadId).map((row) => JSON.parse(String(row.json))),
          state: engine.state(scope), progress: migration.progress(scope),
        };
        break;
      }
      case "close":
        closeMessageDb();
        parentPort!.postMessage({ id });
        parentPort!.close();
        return;
      default: throw new Error(`Unknown migration operation: ${method}`);
    }
    parentPort!.postMessage({ id, value });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
}
