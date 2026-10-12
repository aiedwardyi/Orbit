import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

import { closeMessageDb } from "../message-db.ts";
import {
  applySyncOperations, bindSyncId, createSyncOperation, emptyProfileSyncState, loadOrCreateSyncWorkspace, loadProfileSyncSettings,
  markImported, markSynced, planProfileImport, readSyncOperations, saveProfileSyncSettings, unsyncedChanges, writeSyncOperation,
} from "../profile-sync.ts";
import { ensureMemorySyncDevice, loadMemorySyncLedger, saveMemorySyncLedger, syncBotMemory } from "../memory-sync.ts";
import { pullSyncedPicture, pruneSyncedPictures } from "../picture-sync.ts";
import { Store } from "../store.ts";
import { ensureSyncV2Identity } from "../thread-sync-v2-engine.ts";
import { createThreadSyncV2Store } from "../thread-sync-v2-store.ts";
import { workspaceDir } from "../workspace.ts";

export interface ChatSpec { title: string; rows: number; pictureAges?: number[] }
export interface BotSpec { name: string; memory?: string; chats?: ChatSpec[] }
export interface ReportBot { name: string; syncId: string | null; chats: string[]; memory: string | null; pictures: string }
export interface TestArgs { bots?: BotSpec[]; bot?: string; to?: string; chat?: ChatSpec; folder?: string | null }
export type TestResult = ReportBot[] | boolean | undefined;

const { dataDir } = z.object({ dataDir: z.string() }).parse(workerData);
const DAY = 86_400_000;
const store = new Store(() => ({ instanceId: "test", model: "test" }));
const attachments = join(dataDir, "attachments");
const ledger = loadMemorySyncLedger(dataDir);
let settings = loadProfileSyncSettings(dataDir);
ensureSyncV2Identity(settings.deviceId);
ensureMemorySyncDevice(ledger);
save();
let v2: ReturnType<typeof createThreadSyncV2Store> = null;

function save(): void {
  settings = saveProfileSyncSettings(dataDir, settings);
  saveMemorySyncLedger(dataDir, ledger);
}

const portable = (bot: { name: string }) => ({ name: bot.name });
const big = (i: number) => `row ${i} ${"lorem ipsum dolor sit amet ".repeat(800)}`;

function writeChat(botId: string, chat: ChatSpec, at: number): void {
  const task = store.createTask(botId, chat.title, false)!;
  for (let i = 0; i < chat.rows; i++) store.appendMessage(task.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: big(i), at: at + i });
  for (const days of chat.pictureAges ?? []) {
    const name = `${randomUUID()}.png`;
    mkdirSync(attachments, { recursive: true });
    writeFileSync(join(attachments, name), `png-${name}`);
    store.appendMessage(task.threadId, { role: "user", kind: "screen", image: name, shown: true, png: "pixels", mime: "image/png", at: Date.now() - days * DAY });
  }
}

/** index.ts importProfileChanges, names only. */
function importProfile(folder: string): void {
  const state = applySyncOperations(emptyProfileSyncState(), readSyncOperations(folder).operations);
  const plan = planProfileImport({
    state, deviceId: settings.deviceId, workspaceId: settings.workspaceId, synced: settings.syncedHashes, botMap: settings.botMap,
    local: store.bots.map((bot) => ({ id: bot.id, name: bot.name, section: bot.section, hidden: bot.hidden, changes: portable(bot) })),
    localOrder: { sectionOrder: [], itemOrder: {} }, pendingBotDeletes: settings.pendingBotDeletes,
  });
  for (const item of plan.bots) {
    const remote = state.bots[item.globalId]!;
    let bot = item.localId ? store.bot(item.localId) : undefined;
    const created = !bot;
    if (!bot) bot = store.createBot({ name: String(remote.name ?? "Imported bot") }, { seedMessages: false });
    else if ("name" in item.apply) store.patchBot(bot.id, { name: String(remote.name) });
    bindSyncId(settings.botMap, bot.id, item.globalId);
    const local = portable(store.bot(bot.id)!);
    markImported(settings.syncedHashes, "bot", item.globalId, remote, item.apply, local);
    if (created) markSynced(settings.syncedHashes, { entity: "bot", entityId: item.globalId, changes: Object.fromEntries(Object.entries(local).filter(([field]) => !(field in remote))) });
  }
}

/** index.ts publishProfileChanges, names only. */
function publishProfile(folder: string): void {
  const changed = unsyncedChanges(settings.syncedHashes, store.bots.map((bot) => {
    settings.botMap[bot.id] ??= randomUUID();
    return { entity: "bot" as const, entityId: settings.botMap[bot.id]!, changes: portable(bot) };
  }));
  for (const item of changed) {
    writeSyncOperation(folder, createSyncOperation({ ...item, operationId: randomUUID(), deviceId: settings.deviceId, sequence: settings.nextSequence++, recordedAt: Date.now() }));
    markSynced(settings.syncedHashes, item);
  }
}

function syncProfile(folder: string): void {
  importProfile(folder);
  publishProfile(folder);
  for (const bot of store.bots) if (settings.botMap[bot.id]) syncBotMemory(folder, settings.botMap[bot.id]!, workspaceDir(bot.id), ledger);
  save();
}

function chats() {
  const folder = settings.folder;
  if (!folder || !settings.syncChats) return null;
  v2 ??= createThreadSyncV2Store({
    store, dataDir, deviceId: settings.deviceId,
    folder: () => settings.folder, enabled: () => settings.syncChats,
    target: (threadId) => {
      const bot = store.botByThread(threadId);
      const botSyncId = bot ? settings.botMap[bot.id] : undefined;
      return bot && botSyncId && store.taskByThread(bot.id, threadId) ? { botId: bot.id, botSyncId } : null;
    },
    bots: () => store.bots.flatMap((bot) => settings.botMap[bot.id] ? [{ botId: bot.id, botSyncId: settings.botMap[bot.id]! }] : []),
    running: () => false,
    project: (message) => message,
    imported: (botId) => { store.followNewestTask(botId); },
    maintenance: () => {
      syncProfile(settings.folder!);
      pruneSyncedPictures(settings.folder!, dataDir);
    },
  });
  return v2;
}

function report(): ReportBot[] {
  return store.bots.map((bot) => {
    const tasks = store.tasks(bot.id).filter((task) => store.messagesFor(task.threadId).length);
    const images = tasks.flatMap((task) => store.messagesFor(task.threadId).flatMap((message) => message.image ?? []));
    const present = images.filter((name) => existsSync(join(attachments, name)) || (!!settings.folder && pullSyncedPicture(settings.folder, attachments, name)));
    const memory = join(workspaceDir(bot.id), "MEMORY.md");
    return {
      name: bot.name,
      syncId: settings.botMap[bot.id] ?? null,
      chats: tasks.map((task) => `${task.title}:${store.messagesFor(task.threadId).length}`).sort(),
      memory: existsSync(memory) ? readFileSync(memory, "utf8") : null,
      pictures: `${present.length}/${images.length}`,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function run(method: string, args: TestArgs): Promise<TestResult> {
  // The test's Google activate edits profile-sync.json between calls, as index.ts does in-process.
  settings = loadProfileSyncSettings(dataDir);
  switch (method) {
    case "seed":
      for (const spec of args.bots ?? []) {
        const bot = store.createBot({ name: spec.name }, { seedMessages: false });
        for (const chat of spec.chats ?? []) writeChat(bot.id, chat, Date.now() - 40 * DAY);
        if (spec.memory) {
          mkdirSync(workspaceDir(bot.id), { recursive: true });
          writeFileSync(join(workspaceDir(bot.id), "MEMORY.md"), spec.memory);
        }
      }
      return;
    case "chat":
      writeChat(store.bots.find((bot) => bot.name === args.bot)!.id, args.chat!, Date.now());
      return;
    case "rename":
      store.patchBot(store.bots.find((bot) => bot.name === args.bot)!.id, { name: args.to! });
      return;
    case "folder":
      // PUT /api/profile-sync then chats on, or DELETE (Disconnect).
      if (args.folder) {
        mkdirSync(args.folder, { recursive: true });
        settings.workspaceId = loadOrCreateSyncWorkspace(args.folder, settings.workspaceId);
        settings.folder = args.folder;
        settings.syncChats = true;
      } else settings.folder = null;
      save();
      return;
    case "republish":
      // index.ts activate mints bot sync ids, then republishes chats under them.
      if (settings.folder && settings.syncChats) syncProfile(settings.folder);
      chats()?.republish();
      return chats()?.republishing() ?? false;
    case "start":
      chats()?.start();
      return chats()?.republishing() ?? false;
    case "pass": {
      // One app pass: the v2 poll runs the profile and memory maintenance, then every thread flushes.
      const sync = chats();
      if (!sync) return;
      await sync.poll();
      for (const bot of store.bots) for (const task of store.tasks(bot.id)) await sync.flush(task.threadId);
      while (sync.republishing()) await new Promise((done) => setTimeout(done, 5));
      await sync.poll();
      return;
    }
    case "report":
      return report();
    case "close":
      await v2?.close();
      closeMessageDb();
      return;
    default:
      throw new Error(`unknown method ${method}`);
  }
}

let queue = Promise.resolve();
parentPort!.on("message", ({ id, method, args = {} }: { id: number; method: string; args: TestArgs }) => {
  queue = queue.then(async () => {
    try {
      parentPort!.postMessage({ id, value: await run(method, args) });
    } catch (error) {
      parentPort!.postMessage({ id, error: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  });
});
