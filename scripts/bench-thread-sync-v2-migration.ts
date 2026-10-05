import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? "");
const rel = relative(resolve(tmpdir()), root);
if (!rel || rel.startsWith("..") || resolve(tmpdir(), rel) !== root) throw new Error("Use a threads copy in an OS temp directory");
const device = process.argv[3];
process.env.OMB_DATA_DIR = join(root, device ?? "driver");
mkdirSync(process.env.OMB_DATA_DIR, { recursive: true });

const sourceFiles = () => readdirSync(join(root, "threads"), { withFileTypes: true }).filter((item) => item.isDirectory())
  .flatMap((bot) => readdirSync(join(root, "threads", bot.name)).filter((name) => name.endsWith(".json")).map((name) => ({ bot: bot.name, name, path: join(root, "threads", bot.name, name) })));
const hashes = () => sourceFiles().map((file) => ({ path: `${file.bot}/${file.name}`, hash: createHash("sha256").update(readFileSync(file.path)).digest("hex") })).sort((a, b) => a.path.localeCompare(b.path));

if (!device) {
  const before = hashes();
  writeFileSync(join(root, "v1-before.json"), JSON.stringify(before));
  for (const id of ["a", "b"]) {
    await new Promise<void>((resolveChild, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--expose-gc", fileURLToPath(import.meta.url), root, id], { stdio: "inherit", windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolveChild() : reject(new Error(`PC ${id} exited ${code}`)));
    });
  }
  const after = hashes();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Legacy source bytes changed");
  writeFileSync(join(root, "v1-after.json"), JSON.stringify(after));
  console.log(JSON.stringify({ root, files: before.length, v1Unchanged: true }));
} else {
  const { Store } = await import("../server/store.ts");
  const { messageDatabase, closeMessageDb } = await import("../server/message-db.ts");
  const { createThreadSyncV2Store } = await import("../server/thread-sync-v2-store.ts");
  const { fileSchema } = await import("../server/thread-sync.ts");
  const selection = () => ({ instanceId: "test", model: "test" });
  const mapping: Record<string, string> = {};
  const threads = [...new Set(sourceFiles().map((file) => file.name.split(".")[0]))];
  let store = new Store(selection);
  if (existsSync(join(process.env.OMB_DATA_DIR, "benchmark-seeded"))) throw new Error("Use fresh PC data directories for each run");
  for (const source of sourceFiles().filter((file) => /^[A-Za-z0-9_-]+\.json$/.test(file.name))) {
    let botId = Object.keys(mapping).find((id) => mapping[id] === source.bot);
    if (!botId) { botId = store.createBot({}, { seedMessages: false }).id; mapping[botId] = source.bot; }
    const file = fileSchema.parse(JSON.parse(readFileSync(source.path, "utf8")));
    store.adoptSyncedTask(botId, file.task, file.messages, file.activeLeafId, true);
  }
  writeFileSync(join(process.env.OMB_DATA_DIR, "benchmark-seeded"), "1");
  store = new Store(selection);
  globalThis.gc?.();
  const db = messageDatabase();
  const ids = (thread: string) => db.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY id").all(thread).map((row) => String(row.id));
  const before = Object.fromEntries(threads.map((thread) => [thread, ids(thread)]));
  const baseline = process.memoryUsage();
  const sync = createThreadSyncV2Store({
    store, dataDir: process.env.OMB_DATA_DIR, deviceId: device,
    folder: () => root, enabled: () => true,
    target: (threadId) => {
      const bot = store.botByThread(threadId);
      return bot && mapping[bot.id] ? { botId: bot.id, botSyncId: mapping[bot.id] } : null;
    },
    bots: () => Object.entries(mapping).map(([botId, botSyncId]) => ({ botId, botSyncId })),
    running: () => false, project: (message) => message, imported: () => {}, maintenance: () => {},
  })!;
  const stalls: number[] = [];
  let last = performance.now();
  let peakHeap = baseline.heapUsed;
  let peakExternal = baseline.external;
  let peakRss = baseline.rss;
  const timer = setInterval(() => {
    const now = performance.now();
    stalls.push(Math.max(0, now - last - 2));
    last = now;
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakExternal = Math.max(peakExternal, memory.external);
    peakRss = Math.max(peakRss, memory.rss);
  }, 2);
  const start = performance.now();
  try {
    await sync.poll();
    for (const threadId of threads) await sync.flush(threadId);
    await delay(20);
    const wallMs = performance.now() - start;
    const status = sync.migrationStatus();
    if (status.errors.length || status.completed !== status.threads) throw new Error(JSON.stringify(status));
    const perThread = threads.map((threadId) => {
      const after = ids(threadId);
      const afterSet = new Set(after);
      const missing = before[threadId].filter((id) => !afterSet.has(id));
      if (missing.length) throw new Error(`Missing ${missing.length} rows from ${threadId}`);
      const conflicts = Number(db.prepare("SELECT COUNT(*) AS n FROM (SELECT row_id FROM sync_v2_frontier WHERE thread = ? AND kind = 'row' GROUP BY row_id HAVING COUNT(*) > 1)").get(threadId)!.n);
      return { threadId, before: before[threadId], after, missing, conflicts };
    });
    const report = {
      device, wallMs, p95StallMs: stalls.sort((a, b) => a - b)[Math.ceil(stalls.length * 0.95) - 1],
      maxStallMs: Math.max(...stalls), peakHeap, peakExternal, peakRss, baselineHeap: baseline.heapUsed,
      ...status, perThread,
    };
    writeFileSync(join(root, `${device}-results.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, perThread: perThread.map((thread) => ({ threadId: thread.threadId, before: thread.before.length, after: thread.after.length, conflicts: thread.conflicts })) }));
  } finally {
    clearInterval(timer);
    await sync.close();
    closeMessageDb();
  }
}
