import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Message } from "../server/store.ts";

const root = resolve(process.argv[2] ?? "");
const rel = relative(resolve(tmpdir()), root);
if (!rel || rel.startsWith("..") || resolve(tmpdir(), rel) !== root) throw new Error("Use a threads copy in an OS temp directory");
const device = process.argv[3];
const phase = process.argv[4];
process.env.OMB_DATA_DIR = join(root, device ?? "driver");
mkdirSync(process.env.OMB_DATA_DIR, { recursive: true });
const { fileSchema, isConflictNotice, shared } = await import("../server/thread-sync.ts");
const files = (folder: string) => readdirSync(join(folder, "threads"), { withFileTypes: true }).filter((item) => item.isDirectory())
  .flatMap((bot) => readdirSync(join(folder, "threads", bot.name)).filter((name) => name.endsWith(".json")).map((name) => ({ bot: bot.name, name, path: join(folder, "threads", bot.name, name) })));
const hashes = () => files(root).map((file) => ({ path: `${file.bot}/${file.name}`, hash: createHash("sha256").update(readFileSync(file.path)).digest("hex") }));

if (!device) {
  const before = hashes();
  const devices = ["a", "b", "c"];
  for (const id of devices) {
    const folder = join(root, `sync-${id}`);
    if (existsSync(folder)) throw new Error("Use fresh PC directories");
    cpSync(join(root, "threads"), join(folder, "threads"), { recursive: true });
    if (id === "c") {
      for (const source of files(folder)) {
        if (source.name.endsWith(".deleted.json")) continue;
        const file = fileSchema.parse(JSON.parse(readFileSync(source.path, "utf8")));
        const count = Math.ceil(file.messages.length * 0.55);
        const messages = file.messages.slice(0, count);
        const ids = new Set(messages.map((row) => row.id));
        const parents = new Map(file.messages.map((row, i) => [row.id, row.parentId === undefined ? file.messages[i - 1]?.id ?? null : row.parentId]));
        let leaf = file.activeLeafId;
        const visited = new Set<string>();
        while (leaf && !ids.has(leaf) && !visited.has(leaf)) { visited.add(leaf); leaf = parents.get(leaf) ?? null; }
        writeFileSync(source.path, JSON.stringify({ ...file, messages, activeLeafId: leaf }));
      }
    }
  }
  const run = (id: string, step: string) => new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), root, id, step], { stdio: "inherit", windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? done() : reject(new Error(`PC ${id} ${step} exited ${code}`)));
  });
  for (const id of devices) await run(id, "migrate");
  for (const id of devices) {
    for (const [index, peer] of devices.entries()) {
      if (id !== peer) cpSync(join(root, `sync-${peer}`, "threads-v2"), join(root, `sync-${id}`, `threads-v2 (${index + 1})`), { recursive: true });
    }
  }
  for (const id of devices) await run(id, "verify");
  for (const id of devices) await run(id, "restart");
  const after = hashes();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Legacy source bytes changed");
  writeFileSync(join(root, "source-hashes.json"), JSON.stringify({ before, after }));
} else {
  const { Store } = await import("../server/store.ts");
  const { messageDatabase, closeMessageDb } = await import("../server/message-db.ts");
  const { createThreadSyncV2Store } = await import("../server/thread-sync-v2-store.ts");
  const folder = join(root, `sync-${device}`);
  let store = new Store(() => ({ instanceId: "test", model: "test" }));
  const mapPath = join(process.env.OMB_DATA_DIR, "mapping.json");
  const mapping: Record<string, string> = phase === "migrate" ? {} : JSON.parse(readFileSync(mapPath, "utf8"));
  if (phase === "migrate") {
    if (existsSync(mapPath)) throw new Error("Use fresh PC data directories");
    for (const source of files(folder).filter((file) => /^[A-Za-z0-9_-]+\.json$/.test(file.name))) {
      let botId = Object.keys(mapping).find((id) => mapping[id] === source.bot);
      if (!botId) { botId = store.createBot({}, { seedMessages: false }).id; mapping[botId] = source.bot; }
      const file = fileSchema.parse(JSON.parse(readFileSync(source.path, "utf8")));
      store.adoptSyncedTask(botId, file.task, file.messages, file.activeLeafId, true);
    }
    writeFileSync(mapPath, JSON.stringify(mapping));
    writeFileSync(join(process.env.OMB_DATA_DIR, "thread-sync-v2-cutover.json"), JSON.stringify({ version: 2, cutoverAt: Date.now() }));
    store = new Store(() => ({ instanceId: "test", model: "test" }));
  }
  const db = messageDatabase();
  const before = Number(db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n);
  const sync = createThreadSyncV2Store({
    store, dataDir: process.env.OMB_DATA_DIR, deviceId: device, folder: () => folder, enabled: () => true,
    target: (threadId) => {
      const bot = store.botByThread(threadId);
      return bot && mapping[bot.id] ? { botId: bot.id, botSyncId: mapping[bot.id] } : null;
    },
    bots: () => Object.entries(mapping).map(([botId, botSyncId]) => ({ botId, botSyncId })),
    running: () => false, project: (message) => message, imported: () => {}, maintenance: () => {},
  })!;
  try {
    await sync.poll();
    for (const botId of Object.keys(mapping)) for (const task of store.tasks(botId)) await sync.flush(task.threadId);
    const status = sync.migrationStatus();
    if (status.errors.length || status.completed !== status.threads) throw new Error(JSON.stringify(status));
    const expected = new Map<string, Set<string>>();
    const expectedLeaves = new Map<string, string | null>();
    for (const source of files(root)) {
      if (source.name.endsWith(".deleted.json")) {
        const threadId = source.name.split(".")[0];
        if (!expected.has(threadId)) expected.set(threadId, new Set());
        if (!expectedLeaves.has(threadId)) expectedLeaves.set(threadId, null);
        continue;
      }
      const file = fileSchema.parse(JSON.parse(readFileSync(source.path, "utf8")));
      const ids = expected.get(file.task.threadId) ?? new Set<string>();
      const projected = shared({ ...file.task, messages: file.messages, activeLeafId: file.activeLeafId });
      for (const row of projected.messages) ids.add(row.id);
      if (source.name === `${file.task.threadId}.json`) expectedLeaves.set(file.task.threadId, projected.activeLeafId);
      expected.set(file.task.threadId, ids);
    }
    let notices = 0;
    const perThread = [...expected].map(([threadId, expectedIds]) => {
      const rows: Message[] = db.prepare("SELECT json FROM messages WHERE thread_id = ?").all(threadId).map((row) => JSON.parse(String(row.json)));
      notices += rows.filter(isConflictNotice).length;
      const ids = new Set(rows.map((row) => row.id));
      return { threadId, rows: rows.length, missing: [...expectedIds].filter((id) => !ids.has(id)), leaf: store.activeLeaf(threadId) };
    });
    const leafMismatches = perThread.filter((thread) => expectedLeaves.has(thread.threadId) && expectedLeaves.get(thread.threadId) !== thread.leaf)
      .map((thread) => ({ threadId: thread.threadId, actual: thread.leaf, expected: expectedLeaves.get(thread.threadId) }));
    const result = { device, phase, before, rows: perThread.reduce((sum, thread) => sum + thread.rows, 0), missing: perThread.reduce((sum, thread) => sum + thread.missing.length, 0), notices,
      leaves: expectedLeaves.size - leafMismatches.length, leafMismatches, perThread };
    writeFileSync(join(root, `${device}-${phase}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, perThread: undefined }));
    if (notices || (phase !== "migrate" && (result.missing || leafMismatches.length))) throw new Error("Rows missing, unexpected conflict notices, or active leaves differ");
  } finally {
    await sync.close();
    closeMessageDb();
  }
}
