import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

import { closeMessageDb, messageDatabase } from "../message-db.ts";
import { Store, type BotRecord, type Message, type StoreChange, type TaskRecord } from "../store.ts";
import { CONFLICT_NOTICE, loadThreadSyncLedger, pullThread, saveThreadSyncLedger, uploadThread, type ThreadSyncHost } from "../thread-sync.ts";
import { createThreadSyncV2Store } from "../thread-sync-v2-store.ts";
import { createThreadSyncV2Gate } from "../thread-sync-v2-gate.ts";

export interface TestArgs {
  threadId?: string;
  text?: string;
  id?: string;
  patch?: Partial<Message>;
  count?: number;
  title?: string;
  value?: boolean;
}

export interface Snapshot {
  rows: Message[];
  disk: Message[];
  leaf: string | null;
  events: Array<StoreChange & { importing: boolean }>;
  tasks: TaskRecord[];
  outbox: number;
  pending: number;
  files: string[];
  hasSync: boolean;
  noticeChecks: number;
  historyScans: number;
}

export type TestResult = Snapshot | Message | TaskRecord | BotRecord | string | null | undefined;

const input = z.object({ folder: z.string(), dataDir: z.string(), deviceId: z.string(), enabled: z.boolean(), legacy: z.boolean().optional(), auto: z.boolean().optional() }).parse(workerData);
const selection = () => ({ instanceId: "test", model: "test" });
let store = new Store(selection);
let bot = store.createBot({}, { seedMessages: false });
store.adoptSyncedTask(bot.id, { threadId: "thread", title: "Chat", createdAt: 1 }, [], null, true);
if (input.legacy) store.appendMessage("thread", { role: "user", kind: "text", text: "legacy" });
let live = false;
let runningCalls = 0;
let startAt = Infinity;
const events: Array<StoreChange & { importing: boolean }> = [];
const host = () => ({
  store,
  dataDir: input.dataDir,
  deviceId: input.deviceId,
  folder: () => input.folder,
  enabled: () => true,
  target: (threadId: string) => store.taskByThread(bot.id, threadId) ? { botId: bot.id, botSyncId: "bot" } : null,
  bots: () => [{ botId: bot.id, botSyncId: "bot" }],
  running: () => {
    if (++runningCalls >= startAt) live = true;
    return live;
  },
  project: (message: Message) => message,
  imported: () => { if (!live) store.followNewestTask(bot.id); },
  maintenance: () => {},
});
const gate = createThreadSyncV2Gate(input.dataDir, "");
const ledger = loadThreadSyncLedger(input.dataDir);
const v1: ThreadSyncHost = {
  folder: input.folder, dataDir: input.dataDir, deviceId: input.deviceId, ledger,
  saveLedger: () => saveThreadSyncLedger(input.dataDir, ledger),
  local: (threadId) => {
    const task = store.taskByThread(bot.id, threadId);
    return task ? { title: task.title, createdAt: task.createdAt, messages: store.messagesFor(threadId), activeLeafId: store.activeLeaf(threadId) } : null;
  },
  running: () => live,
  adopt: (_botId, file) => { store.adoptSyncedTask(bot.id, file.task, file.messages, file.activeLeafId, true); },
  remove: (_botId, threadId) => { store.removeSyncedTask(bot.id, threadId); },
  conflicted: () => {},
};
let noticeChecks = 0;
let historyScans = 0;
function traceQueries(): void {
  const prepare = messageDatabase().prepare.bind(messageDatabase());
  messageDatabase().prepare = (sql: string) => {
    if (sql.includes("WITH RECURSIVE path")) noticeChecks++;
    if (sql.includes("SELECT MAX(at)") || sql === "SELECT COUNT(*) AS n FROM sync_v2_snapshot") historyScans++;
    return prepare(sql);
  };
}
traceQueries();
let sync = createThreadSyncV2Store(host(), input.enabled && !input.auto);
store.onChange((change) => events.push({ ...structuredClone(change), importing: store.importingSync }));

parentPort!.on("message", async ({ id, method, args = {} }: { id: number; method: string; args: TestArgs }) => {
  try {
    let value: TestResult;
    const threadId = args.threadId ?? "thread";
    switch (method) {
      case "append": value = store.appendMessage(threadId, { role: "user", kind: "text", text: args.text }); break;
      case "batch":
        for (let i = 0; i < Number(args.count); i++) store.appendMessage(threadId, { role: "user", kind: "text", text: `row ${i}` });
        break;
      case "patch": value = store.patchMessage(threadId, String(args.id), args.patch ?? {}); break;
      case "head": value = store.setActiveLeaf(threadId, String(args.id)); break;
      case "branch": value = store.branchMessage(threadId, String(args.id), String(args.text)); break;
      case "rename": value = store.renameTask(bot.id, threadId, String(args.title)); break;
      case "create": value = store.createTask(bot.id, "Other", false); break;
      case "delete": value = store.deleteTask(bot.id, threadId); break;
      case "notice": value = store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `error: ${CONFLICT_NOTICE}`, ok: false } }); break;
      case "picture":
        mkdirSync(join(input.dataDir, "attachments"), { recursive: true });
        writeFileSync(join(input.dataDir, "attachments", "test.png"), "picture-bytes");
        value = store.appendMessage(threadId, { role: "bot", kind: "screen", image: "test.png", shown: true, png: "pixels", mime: "image/png" });
        break;
      case "live": live = Boolean(args.value); startAt = Infinity; break;
      case "race": live = false; runningCalls = 0; startAt = 3; break;
      case "flush": value = await sync?.flush(threadId); break;
      case "pull": await sync?.pull(threadId); break;
      case "poll":
        if (input.auto && !gate.check(input.folder)) {
          uploadThread(v1, "bot", threadId);
          pullThread(v1, bot.id, "bot", threadId);
        } else {
          if (input.auto) sync ??= createThreadSyncV2Store(host(), true);
          await sync?.poll();
        }
        break;
      case "cursor":
        store.setResumeCursor(bot.id, "test", "cursor");
        break;
      case "fail":
        messageDatabase().exec("CREATE TEMP TRIGGER reject_outbox BEFORE INSERT ON sync_v2_packets BEGIN SELECT RAISE(ABORT, 'outbox rejected'); END");
        break;
      case "restart":
        await sync?.close();
        closeMessageDb();
        store = new Store(selection);
        bot = store.bots[0];
        traceQueries();
        sync = createThreadSyncV2Store(host(), input.enabled && (!input.auto || gate.enabled));
        store.onChange((change) => events.push({ ...structuredClone(change), importing: store.importingSync }));
        break;
      case "snapshot": {
        const db = messageDatabase();
        const hasSync = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sync_v2_identity'").get());
        const outbox = hasSync ? Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_packets WHERE writer = (SELECT writer FROM sync_v2_identity)").get()!.n) : 0;
        const pending = hasSync ? Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_packets WHERE applied = 0").get()!.n) : 0;
        const disk = db.prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid").all(threadId).map((row) => JSON.parse(String(row.json)));
        value = { rows: store.messagesFor(threadId), disk, leaf: store.activeLeaf(threadId), events: events.splice(0), tasks: store.tasks(bot.id), outbox, pending, files: readdirSync(input.dataDir), hasSync, noticeChecks, historyScans };
        break;
      }
      case "close":
        await sync?.close();
        closeMessageDb();
        parentPort!.postMessage({ id });
        parentPort!.close();
        return;
      default: throw new Error(`Unknown test operation: ${method}`);
    }
    parentPort!.postMessage({ id, value });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
