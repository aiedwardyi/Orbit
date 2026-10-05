import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

test("packaged sync worker commits, flushes and pulls without node_modules", async () => {
  const root = mkdtempSync(join(tmpdir(), "sync-v2-package-"));
  process.env.OMB_DATA_DIR = join(root, "script");
  const server = join(root, "Resources", "server");
  mkdirSync(server, { recursive: true });
  for (const file of ["thread-sync-v2.js", "thread-sync-v2-worker.js"]) {
    copyFileSync(new URL(`../dist-server/${file}`, import.meta.url), join(server, file));
  }
  const { ThreadSyncV2 } = await import(pathToFileURL(join(server, "thread-sync-v2.js")).href);
  const folder = join(root, "sync");
  const a = new ThreadSyncV2({ folder, dataDir: join(root, "a"), deviceId: "a" });
  const b = new ThreadSyncV2({ folder, dataDir: join(root, "b"), deviceId: "b" });
  const scope = { botSyncId: "bot", threadId: "thread" };
  const row = { id: "m", role: "user", kind: "text", at: 1, text: "packaged" };
  try {
    await a.commit(scope, [{ kind: "row", value: row }]);
    await a.flush(scope);
    assert.equal((await b.pull(scope)).rowsTouched, 1);
    assert.deepEqual((await b.scan(scope.threadId)).messages, [row]);
    assert.equal((await b.state(scope)).outbox, 0);
  } finally {
    await Promise.all([a.close(), b.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});
