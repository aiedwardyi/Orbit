import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  CONFLICT_NOTICE,
  THREAD_SYNC_FORMAT,
  chatSyncBotId,
  loadThreadSyncLedger,
  markThreadDirty,
  pullBotThreads,
  pullThread,
  readSyncedThread,
  saveThreadSyncLedger,
  threadSyncDir,
  threadTurnRunning,
  uploadThread,
  type LocalThread,
  type ThreadSyncHost,
} from "./thread-sync.ts";

const BOT_SYNC_ID = "sync-bot-1";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const msg = (id: string, text: string, parentId: string | null, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  kind: "text",
  text,
  at: 1_700_000_000_000,
  parentId,
  ...extra,
});

function pc(deviceId: string, folder: string) {
  const dataDir = temp(`thread-sync-${deviceId}-`);
  const threads = new Map<string, LocalThread>();
  const running = new Set<string>();
  const notices: string[] = [];
  const host: ThreadSyncHost = {
    folder,
    deviceId,
    ledger: loadThreadSyncLedger(dataDir),
    saveLedger: () => saveThreadSyncLedger(dataDir, host.ledger),
    local: (threadId) => threads.get(threadId) ?? null,
    running: (threadId) => running.has(threadId),
    adopt: (_botId, file) => {
      threads.set(file.task.threadId, {
        title: file.task.title,
        createdAt: file.task.createdAt,
        messages: structuredClone(file.messages),
        activeLeafId: file.activeLeafId,
      });
    },
    conflicted: (threadId) => notices.push(threadId),
    now: () => 1_700_000_000_500,
  };
  const say = (threadId: string, id: string, text: string) => {
    const thread = threads.get(threadId) ?? { title: "Plan trip", createdAt: 1_700_000_000_000, messages: [], activeLeafId: null };
    thread.messages.push(msg(id, text, thread.activeLeafId));
    thread.activeLeafId = id;
    threads.set(threadId, thread);
    if (markThreadDirty(host.ledger, threadId)) host.saveLedger();
  };
  return { host, dataDir, threads, running, notices, say };
}

const remotePath = (folder: string, threadId: string) => join(threadSyncDir(folder, BOT_SYNC_ID), `${threadId}.json`);

function conflictMessages(folder: string, writer: string): string[][] {
  const dir = threadSyncDir(folder, BOT_SYNC_ID);
  return readdirSync(dir)
    .filter((name) => name.startsWith(`t1.conflict-${writer}-`))
    .map((name) => readSyncedThread(join(dir, name))?.messages.map((m) => m.id) ?? []);
}

describe("thread sync", () => {
  it("round trips a thread into a real store and clears per-device session fields", () => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    a.say("t1", "m1", "hello");
    a.say("t1", "m2", "world");
    expect(uploadThread(a.host, BOT_SYNC_ID, "t1")).toBe("written");

    const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
    const store = new Store(selection);
    const bot = store.createBot();
    const ledgerDir = temp("thread-sync-device-b-");
    const b: ThreadSyncHost = {
      folder,
      deviceId: "device-b",
      ledger: loadThreadSyncLedger(ledgerDir),
      saveLedger: () => saveThreadSyncLedger(ledgerDir, b.ledger),
      local: (threadId) => {
        const task = store.taskByThread(bot.id, threadId);
        return task
          ? { title: task.title, createdAt: task.createdAt, messages: store.messagesFor(threadId), activeLeafId: store.activeLeaf(threadId) }
          : null;
      },
      running: () => false,
      adopt: (botId, file) => void store.adoptSyncedTask(botId, file.task, file.messages, file.activeLeafId),
      conflicted: () => {},
    };
    const frames: unknown[] = [];
    const unsubscribe = store.onChange((change) => {
      if (change.type === "message") frames.push(change.imported);
    });
    expect(pullBotThreads(b, bot.id, BOT_SYNC_ID)).toEqual({ t1: "imported" });
    unsubscribe();
    expect(frames).toEqual([true, true]);
    expect(store.messagesFor("t1").map((m) => m.text)).toEqual(["hello", "world"]);
    expect(store.activeLeaf("t1")).toBe("m2");
    expect(store.taskByThread(bot.id, "t1")?.title).toBe("Plan trip");

    const task = store.taskByThread(bot.id, "t1")!;
    task.resumeCursors = { claude: "session-1" };
    task.lastInstanceId = "claude";
    task.providerSessionBoundId = "m1";
    a.say("t1", "m3", "again");
    expect(uploadThread(a.host, BOT_SYNC_ID, "t1")).toBe("written");
    expect(pullThread(b, bot.id, BOT_SYNC_ID, "t1")).toBe("imported");
    const refreshed = store.taskByThread(bot.id, "t1")!;
    expect(refreshed.resumeCursors).toEqual({});
    expect(refreshed.lastInstanceId).toBeUndefined();
    expect(refreshed.providerSessionBoundId).toBeUndefined();
    expect(store.activeLeaf("t1")).toBe("m3");
    expect(b.ledger.t1).toEqual({ syncedRevision: 2, syncedWriter: "device-a", dirty: false });
    closeMessageDb();
    const reopened = new Store(selection);
    expect(reopened.messagesFor("t1").map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(reopened.activeLeaf("t1")).toBe("m3");

    const file = JSON.parse(readFileSync(remotePath(folder, "t1"), "utf8"));
    expect(file).toMatchObject({ format: THREAD_SYNC_FORMAT, version: 1, revision: 2, writerDeviceId: "device-a" });
    expect(Object.keys(file.task).sort()).toEqual(["createdAt", "threadId", "title"]);
    expect(JSON.stringify(file)).not.toMatch(/resumeCursors|lastInstanceId|lastModel|providerSessionBoundId|usage/);
  });

  it("imports a newer remote copy over a clean local thread", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const b = pc("device-b", folder);
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    expect(pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("imported");
    a.say("t1", "m2", "more");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    expect(pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("imported");
    expect(b.threads.get("t1")?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("current");
    b.say("t1", "m3", "reply from b");
    expect(uploadThread(b.host, BOT_SYNC_ID, "t1")).toBe("written");
    expect(pullThread(a.host, "bot-a", BOT_SYNC_ID, "t1")).toBe("imported");
    expect(a.threads.get("t1")?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps both copies when the remote is newer and the local thread is dirty", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const b = pc("device-b", folder);
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1");
    a.say("t1", "m2", "from a");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    b.say("t1", "m3", "from b");

    expect(uploadThread(b.host, BOT_SYNC_ID, "t1")).toBe("conflict");
    expect(pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("current");
    expect(b.notices).toEqual(["t1"]);
    expect(b.threads.get("t1")?.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(readSyncedThread(remotePath(folder, "t1"))?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(conflictMessages(folder, "device-a")).toEqual([["m1", "m2"]]);
    expect(pullBotThreads(b.host, "bot-b", BOT_SYNC_ID)).toEqual({ t1: "current" });
    expect(CONFLICT_NOTICE).toMatch(/other PC's copy was saved as a conflict file/);
  });

  it("resumes syncing after a conflict with both copies on Drive", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const b = pc("device-b", folder);
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1");
    a.say("t1", "m2", "from a");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    b.say("t1", "m3", "from b");
    expect(uploadThread(b.host, BOT_SYNC_ID, "t1")).toBe("conflict");

    expect(uploadThread(b.host, BOT_SYNC_ID, "t1")).toBe("written");
    const remote = readSyncedThread(remotePath(folder, "t1"));
    expect(remote).toMatchObject({ revision: 3, writerDeviceId: "device-b" });
    expect(remote?.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(conflictMessages(folder, "device-a")).toEqual([["m1", "m2"]]);
    expect(pullThread(a.host, "bot-a", BOT_SYNC_ID, "t1")).toBe("imported");
    expect(a.threads.get("t1")?.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(a.notices).toEqual([]);
    expect(b.notices).toEqual(["t1"]);
  });

  it("treats an equal revision from another writer as a conflict on upload and pull", () => {
    // both at rev 2; A writes rev 3, a lagging Drive shows B rev 2, B writes its own rev 3 and Drive keeps it
    const race = () => {
      const folder = temp("thread-sync-folder-");
      const a = pc("device-a", folder);
      const b = pc("device-b", folder);
      const path = remotePath(folder, "t1");
      a.say("t1", "m1", "hello");
      uploadThread(a.host, BOT_SYNC_ID, "t1");
      a.say("t1", "m2", "more");
      uploadThread(a.host, BOT_SYNC_ID, "t1");
      pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1");
      const rev2 = readFileSync(path, "utf8");
      a.say("t1", "m3", "from a");
      expect(uploadThread(a.host, BOT_SYNC_ID, "t1")).toBe("written");
      writeFileSync(path, rev2);
      b.say("t1", "m4", "from b");
      expect(uploadThread(b.host, BOT_SYNC_ID, "t1")).toBe("written");
      expect(readSyncedThread(path)).toMatchObject({ revision: 3, writerDeviceId: "device-b" });
      return { folder, a, b };
    };

    const pulled = race();
    expect(pullThread(pulled.a.host, "bot-a", BOT_SYNC_ID, "t1")).toBe("conflict");
    expect(pulled.a.notices).toEqual(["t1"]);
    expect(conflictMessages(pulled.folder, "device-b")).toEqual([["m1", "m2", "m4"]]);
    expect(uploadThread(pulled.a.host, BOT_SYNC_ID, "t1")).toBe("written");
    expect(readSyncedThread(remotePath(pulled.folder, "t1"))).toMatchObject({ revision: 4, writerDeviceId: "device-a" });
    expect(pullThread(pulled.b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("imported");
    expect(pulled.b.threads.get("t1")?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);

    const uploaded = race();
    uploaded.a.say("t1", "m5", "a again");
    expect(uploadThread(uploaded.a.host, BOT_SYNC_ID, "t1")).toBe("conflict");
    expect(conflictMessages(uploaded.folder, "device-b")).toEqual([["m1", "m2", "m4"]]);
    expect(uploadThread(uploaded.a.host, BOT_SYNC_ID, "t1")).toBe("written");
    expect(readSyncedThread(remotePath(uploaded.folder, "t1"))?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m5"]);

    // an entry written before syncedWriter keeps revision-only behavior
    const legacy = race();
    legacy.a.host.ledger.t1 = { syncedRevision: 3, dirty: false };
    expect(pullThread(legacy.a.host, "bot-a", BOT_SYNC_ID, "t1")).toBe("current");
  });

  it("keeps the valid ledger entries when one is malformed", () => {
    const dataDir = temp("thread-sync-ledger-");
    writeFileSync(join(dataDir, "thread-sync.json"), JSON.stringify({
      t1: { syncedRevision: 2, syncedWriter: "device-a", dirty: false },
      t2: { syncedRevision: "bad", dirty: false },
      "bad.id": { syncedRevision: 1, dirty: false },
      t3: { syncedRevision: 1, dirty: true },
    }));
    expect(loadThreadSyncLedger(dataDir)).toEqual({
      t1: { syncedRevision: 2, syncedWriter: "device-a", dirty: false },
      t3: { syncedRevision: 1, dirty: true },
    });
  });

  it("reuses a parsed file until its mtime or size changes", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    const path = remotePath(folder, "t1");
    const stamp = 1_700_000_000;
    utimesSync(path, stamp, stamp);
    expect(readSyncedThread(path)?.task.title).toBe("Plan trip");

    writeFileSync(path, readFileSync(path, "utf8").replace("Plan trip", "Plan TRIP"));
    utimesSync(path, stamp, stamp);
    expect(readSyncedThread(path)?.task.title).toBe("Plan trip");

    utimesSync(path, stamp, stamp + 5);
    expect(readSyncedThread(path)?.task.title).toBe("Plan TRIP");
  });

  it("counts a turn as running only on its own thread", () => {
    const idle = { live: false, starting: false, busy: false, activeThreadId: "t1" };
    expect(threadTurnRunning("t2", { ...idle, busy: true })).toBe(false);
    expect(threadTurnRunning("t2", { ...idle, starting: true })).toBe(false);
    expect(threadTurnRunning("t1", { ...idle, busy: true })).toBe(true);
    expect(threadTurnRunning("t1", { ...idle, starting: true })).toBe(true);
    expect(threadTurnRunning("t2", { ...idle, live: true })).toBe(true);
    expect(threadTurnRunning("t1", idle)).toBe(false);
  });

  it("never uploads or imports while a turn runs on the thread", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const b = pc("device-b", folder);
    a.say("t1", "m1", "hello");
    a.running.add("t1");
    expect(uploadThread(a.host, BOT_SYNC_ID, "t1")).toBe("running");
    expect(existsSync(remotePath(folder, "t1"))).toBe(false);
    a.running.delete("t1");
    expect(uploadThread(a.host, BOT_SYNC_ID, "t1")).toBe("written");
    b.running.add("t1");
    expect(pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("running");
    expect(b.threads.has("t1")).toBe(false);
    b.running.delete("t1");
    expect(pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("imported");
  });

  it("syncs only bots with a sync id while chat sync is on", () => {
    const settings = { syncChats: true, folder: "/drive/orbit", botMap: { "bot-a": BOT_SYNC_ID } };
    expect(chatSyncBotId(settings, "bot-a")).toBe(BOT_SYNC_ID);
    expect(chatSyncBotId(settings, "bot-b")).toBeNull();
    expect(chatSyncBotId({ ...settings, syncChats: false }, "bot-a")).toBeNull();
    expect(chatSyncBotId({ ...settings, folder: null }, "bot-a")).toBeNull();
  });

  it("ignores malformed and wrong-format files", () => {
    const folder = temp("thread-sync-folder-");
    const b = pc("device-b", folder);
    const dir = threadSyncDir(folder, BOT_SYNC_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "t1.json"), "{not json");
    writeFileSync(join(dir, "t2.json"), JSON.stringify({ format: "orbit.profile-sync", version: 1 }));
    writeFileSync(join(dir, "t3.json"), JSON.stringify({
      format: THREAD_SYNC_FORMAT,
      version: 1,
      revision: 1,
      writerDeviceId: "device-a",
      updatedAt: 1,
      task: { threadId: "other", title: "x", createdAt: 1 },
      activeLeafId: null,
      messages: [],
    }));
    expect(() => pullBotThreads(b.host, "bot-b", BOT_SYNC_ID)).not.toThrow();
    expect(pullBotThreads(b.host, "bot-b", BOT_SYNC_ID)).toEqual({ t1: "skipped", t2: "skipped", t3: "skipped" });
    expect(b.threads.size).toBe(0);

    b.say("t1", "m1", "local");
    expect(uploadThread(b.host, BOT_SYNC_ID, "t1")).toBe("skipped");
    expect(readFileSync(join(dir, "t1.json"), "utf8")).toBe("{not json");
  });
});
