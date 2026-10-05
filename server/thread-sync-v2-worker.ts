import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import { closeMessageDb, scanThreadRows } from "./message-db.ts";
import { createSyncEngine, syncOptionsSchema } from "./thread-sync-v2-engine.ts";
import { createThreadMigration } from "./thread-sync-v2-migration.ts";
import type { SyncRequest } from "./thread-sync-v2.ts";

const options = syncOptionsSchema.parse(workerData);
mkdirSync(options.dataDir, { recursive: true });
const ownership = options.staged ? null : new DatabaseSync(join(options.dataDir, "thread-sync-v2-owner.db"));
ownership?.exec("BEGIN EXCLUSIVE");
const engine = createSyncEngine(options);
const migration = createThreadMigration(options, engine);

let queue = Promise.resolve();
parentPort!.on("message", (request: SyncRequest & { id: number }) => {
  queue = queue.then(() => dispatch(request));
});

async function dispatch(request: SyncRequest & { id: number }): Promise<void> {
  const { id } = request;
  try {
    let value: unknown;
    switch (request.method) {
      case "commit": value = engine.commit(...request.args); break;
      case "recover": value = engine.recover(...request.args); break;
      case "flush": value = engine.flush(...request.args); break;
      case "pull": value = engine.pull(...request.args); break;
      case "scan": value = scanThreadRows(...request.args); break;
      case "variants": value = engine.variants(...request.args); break;
      case "state": value = engine.state(...request.args); break;
      case "changes": value = engine.changes(...request.args); break;
      case "threads": value = engine.threads(...request.args); break;
      case "legacyThreads": value = migration.discover(...request.args); break;
      case "migrate": value = await migration.step(...request.args); break;
      case "close":
        closeMessageDb();
        ownership?.close();
        parentPort!.postMessage({ id });
        parentPort!.close();
        return;
      default: throw new Error("Unknown sync operation");
    }
    parentPort!.postMessage({ id, value });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
}
