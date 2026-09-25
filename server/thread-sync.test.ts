import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb, readThread } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  CONFLICT_NOTICE,
  THREAD_SYNC_FORMAT,
  THREAD_SYNC_POLL_MS,
  chatSyncBotId,
  createThreadSyncPoll,
  loadThreadSyncLedger,
  markThreadDirty,
  pullBotThreads,
  pullThread,
  deleteSyncedThread,
  readSyncedThread,
  saveThreadSyncLedger,
  threadSyncDir,
  threadTurnRunning,
  uploadThread,
  type LocalThread,
  type ThreadSyncHost,
  type ThreadSyncLedger,
} from "./thread-sync.ts";

const BOT_SYNC_ID = "sync-bot-1";
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    remove: (_botId, threadId) => void threads.delete(threadId),
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
const tombstonePath = (folder: string, threadId: string) => join(threadSyncDir(folder, BOT_SYNC_ID), `${threadId}.deleted.json`);

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
      remove: () => {},
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

  it("keeps local messages a higher remote revision never saw", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const b = pc("device-b", folder);
    const path = remotePath(folder, "t1");
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1");
    const rev1 = readFileSync(path, "utf8");
    a.say("t1", "onlyA", "offline on a");
    expect(uploadThread(a.host, BOT_SYNC_ID, "t1")).toBe("written");
    writeFileSync(path, rev1);
    b.say("t1", "b2", "from b");
    expect(uploadThread(b.host, BOT_SYNC_ID, "t1")).toBe("written");
    b.say("t1", "b3", "b again");
    expect(uploadThread(b.host, BOT_SYNC_ID, "t1")).toBe("written");

    expect(pullThread(a.host, "bot-a", BOT_SYNC_ID, "t1")).toBe("conflict");
    expect(a.threads.get("t1")?.messages.map((m) => m.id)).toEqual(["m1", "onlyA"]);
    expect(conflictMessages(folder, "device-b")).toEqual([["m1", "b2", "b3"]]);
    // b's copy is parked on Drive, so b adopts instead of conflicting back
    expect(uploadThread(a.host, BOT_SYNC_ID, "t1")).toBe("written");
    expect(pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("imported");
    expect(b.threads.get("t1")?.messages.map((m) => m.id)).toEqual(["m1", "onlyA"]);
    expect(b.notices).toEqual([]);
  });

  it("keeps a committed message whose dirty flag never saved", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const b = pc("device-b", folder);
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1");
    b.threads.get("t1")!.messages.push(msg("m2", "crashed before dirty", "m1"));
    a.say("t1", "m3", "from a");
    uploadThread(a.host, BOT_SYNC_ID, "t1");

    expect(pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("conflict");
    expect(b.threads.get("t1")?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(conflictMessages(folder, "device-a")).toEqual([["m1", "m3"]]);
  });

  it("keeps an edited message whose old content is only in a stale archive", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const b = pc("device-b", folder);
    const path = remotePath(folder, "t1");
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1");
    b.say("t1", "b2", "old");
    expect(uploadThread(b.host, BOT_SYNC_ID, "t1")).toBe("written");
    writeFileSync(join(threadSyncDir(folder, BOT_SYNC_ID), "t1.conflict-device-b-1.json"), readFileSync(path, "utf8"));
    const sibling = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...sibling,
      revision: 3,
      writerDeviceId: "device-a",
      activeLeafId: "a2",
      messages: [sibling.messages[0], msg("a2", "from a", "m1")],
    }));
    // edited in place after the archive, and the dirty flag never saved
    b.threads.get("t1")!.messages[1].text = "new";

    expect(pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("conflict");
    expect(b.threads.get("t1")?.messages.map((m) => m.text)).toEqual(["hello", "new"]);
  });

  it("rebases a pull only onto the live file when the cache matches its size and mtime", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const b = pc("device-b", folder);
    const c = pc("device-c", folder);
    const path = remotePath(folder, "t1");
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1");
    pullThread(c.host, "bot-c", BOT_SYNC_ID, "t1");
    c.say("t1", "c2", "cccc");
    expect(uploadThread(c.host, BOT_SYNC_ID, "t1")).toBe("written");
    const live = readFileSync(path, "utf8");
    const stamp = 1_700_000_000;
    writeFileSync(path, live.replace('"revision":2', '"revision":3').replace("cccc", "dddd"));
    utimesSync(path, stamp, stamp);
    expect(readSyncedThread(path)?.revision).toBe(3);
    writeFileSync(path, live);
    utimesSync(path, stamp, stamp);
    b.say("t1", "b2", "from b");

    expect(pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1")).toBe("conflict");
    expect(b.host.ledger.t1).toEqual({ syncedRevision: 2, syncedWriter: "device-c", dirty: true });
    const dir = threadSyncDir(folder, BOT_SYNC_ID);
    const parked = readdirSync(dir).filter((name) => name.startsWith("t1.conflict-"));
    expect(parked.map((name) => readSyncedThread(join(dir, name), true)?.messages.map((m) => m.text))).toEqual([["hello", "cccc"]]);
  });

  it("marks the ledger dirty before a message write reaches SQLite", () => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    const store = new Store((): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const { threadId } = store.createBot();
    const ledger: ThreadSyncLedger = { [threadId]: { syncedRevision: 1, dirty: false } };
    const stored: string[] = [];
    store.onBeforeWrite((id) => {
      markThreadDirty(ledger, id);
      stored.push(readThread(id, join(DATA_DIR, "missing.json")).messages.map((m) => m.text ?? "").join("|"));
    });

    const message = store.appendMessage(threadId, { role: "user", kind: "text", text: "first" });
    expect(ledger[threadId].dirty).toBe(true);
    expect(stored[0]).not.toContain("first");
    ledger[threadId].dirty = false;
    stored.length = 0;
    store.patchMessage(threadId, message.id, { text: "second" });
    expect(ledger[threadId].dirty).toBe(true);
    expect(stored[0]).toContain("first");
    expect(stored[0]).not.toContain("second");
    closeMessageDb();
  });

  it("archives a changed remote on upload even when size and mtime match the cache", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const path = remotePath(folder, "t1");
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    const stamp = 1_700_000_000;
    utimesSync(path, stamp, stamp);
    expect(readSyncedThread(path)).toMatchObject({ revision: 1, writerDeviceId: "device-a" });
    writeFileSync(path, readFileSync(path, "utf8").replace('"revision":1', '"revision":2').replace("device-a", "device-b"));
    utimesSync(path, stamp, stamp);

    a.say("t1", "m2", "more");
    expect(uploadThread(a.host, BOT_SYNC_ID, "t1")).toBe("conflict");
    expect(conflictMessages(folder, "device-b")).toEqual([["m1"]]);
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
    expect(readSyncedThread(path, true)?.task.title).toBe("Plan TRIP");

    writeFileSync(path, readFileSync(path, "utf8").replace("Plan TRIP", "Plan TRIp"));
    utimesSync(path, stamp, stamp + 5);
    expect(readSyncedThread(path)?.task.title).toBe("Plan TRIp");
  });

  it("counts a turn as running only on its own thread", () => {
    const idle = { live: false, startingThreadId: undefined, busy: false, activeThreadId: "t1" };
    expect(threadTurnRunning("t2", { ...idle, busy: true })).toBe(false);
    expect(threadTurnRunning("t2", { ...idle, startingThreadId: "t1" })).toBe(false);
    expect(threadTurnRunning("t1", { ...idle, busy: true })).toBe(true);
    expect(threadTurnRunning("t1", { ...idle, startingThreadId: "t1" })).toBe(true);
    // a claimed start on a background thread, before activeThreadId moves to it
    expect(threadTurnRunning("t2", { ...idle, startingThreadId: "t2" })).toBe(true);
    expect(threadTurnRunning("t1", { ...idle, startingThreadId: "t2" })).toBe(false);
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => pullBotThreads(b.host, "bot-b", BOT_SYNC_ID)).not.toThrow();
    expect(pullBotThreads(b.host, "bot-b", BOT_SYNC_ID)).toEqual({ t1: "skipped", t2: "skipped", t3: "skipped" });
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      `chat sync: cannot read ${join(dir, "t1.json")} (EPARSE)`,
      `chat sync: cannot read ${join(dir, "t2.json")} (ESCHEMA)`,
    ]);
    expect(b.threads.size).toBe(0);

    b.say("t1", "m1", "local");
    expect(uploadThread(b.host, BOT_SYNC_ID, "t1")).toBe("skipped");
    expect(readFileSync(join(dir, "t1.json"), "utf8")).toBe("{not json");
  });

  it("warns again when a removed file comes back broken", () => {
    const path = join(temp("thread-sync-folder-"), "t1.json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(path, "{not json");
    readSyncedThread(path);
    readSyncedThread(path);
    rmSync(path);
    readSyncedThread(path);
    writeFileSync(path, "{still not json");
    readSyncedThread(path, true);
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      `chat sync: cannot read ${path} (EPARSE)`,
      `chat sync: cannot read ${path} (EPARSE)`,
    ]);
  });
});

describe("thread sync follow", () => {
  function setup() {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    const store = new Store((): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const { id, threadId } = store.createBot();
    store.appendMessage(threadId, { role: "user", kind: "text", text: "local" });
    const switched: unknown[] = [];
    store.onChange((change) => {
      if (change.type === "bot") switched.push(change.switched);
    });
    const adopt = (at: number, follow = true) =>
      store.adoptSyncedTask(id, { threadId: "remote", title: "From home", createdAt: 1 }, [msg("r1", "remote", null, { at })], "r1", follow);
    return { store, id, local: threadId, switched, adopt };
  }

  afterEach(() => closeMessageDb());

  it("follows a newer imported thread while idle", () => {
    const { store, id, switched, adopt } = setup();
    adopt(Date.now() + 60_000);
    expect(store.bot(id)?.threadId).toBe("remote");
    expect(store.bot(id)?.resumeCursors).toEqual({});
    expect(switched).toEqual([true]);
  });

  it("stays on the local thread when the import is older", () => {
    const { store, id, local, switched, adopt } = setup();
    adopt(1);
    expect(store.bot(id)?.threadId).toBe(local);
    expect(store.taskByThread(id, "remote")).toBeDefined();
    expect(switched).toEqual([undefined]);
  });

  it("yields an empty active thread to an import and removes it", () => {
    const { store, id, adopt } = setup();
    const empty = store.createTask(id)!.threadId;
    adopt(1);
    expect(store.bot(id)?.threadId).toBe("remote");
    expect(store.taskByThread(id, empty)).toBeUndefined();
    expect(store.tasks(id)).toHaveLength(2);
  });

  it("never removes a thread with messages", () => {
    const { store, id, local, adopt } = setup();
    adopt(1);
    adopt(Date.now() + 60_000);
    expect(store.bot(id)?.threadId).toBe("remote");
    expect(store.messagesFor(local).map((m) => m.text)).toContain("local");
    expect(store.tasks(id).map((t) => t.threadId).sort()).toEqual([local, "remote"].sort());
  });

  it("never switches while the bot is busy or a turn is starting", () => {
    const { store, id, local, adopt } = setup();
    store.setActivity(id, "working", local);
    adopt(Date.now() + 60_000);
    expect(store.bot(id)?.threadId).toBe(local);
    store.setActivity(id, "idle");
    adopt(Date.now() + 60_000, false);
    expect(store.bot(id)?.threadId).toBe(local);
  });
});

describe("one chat per bot", () => {
  function setup() {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    const store = new Store((): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const { id, threadId: older } = store.createBot({}, { seedMessages: false });
    store.appendMessage(older, { role: "user", kind: "text", text: "older" });
    const newer = store.createTask(id, "Newer", false)!.threadId;
    store.appendMessage(newer, msg("n1", "newer", null, { at: Date.now() + 60_000 }));
    return { store, id, older, newer };
  }

  afterEach(() => closeMessageDb());

  it("switches an idle bot to its newest chat and keeps both", () => {
    const { store, id, older, newer } = setup();
    expect(store.followNewestTask(id)).toBe(true);
    expect(store.bot(id)?.threadId).toBe(newer);
    expect(store.tasks(id).map((t) => t.threadId).sort()).toEqual([older, newer].sort());
    expect(store.messagesFor(older).map((m) => m.text)).toEqual(["older"]);
  });

  it("leaves a busy bot on its chat", () => {
    const { store, id, older } = setup();
    store.setActivity(id, "working", older);
    expect(store.followNewestTask(id)).toBe(false);
    expect(store.bot(id)?.threadId).toBe(older);
  });

  it("never picks a skipped routine thread", () => {
    const { store, id, older, newer } = setup();
    expect(store.followNewestTask(id, new Set([newer]))).toBe(false);
    expect(store.bot(id)?.threadId).toBe(older);
  });

  it("drops an empty chat it leaves", () => {
    const { store, id, older, newer } = setup();
    const empty = store.createTask(id)!.threadId;
    store.followNewestTask(id);
    expect(store.bot(id)?.threadId).toBe(newer);
    expect(store.taskByThread(id, empty)).toBeUndefined();
    expect(store.tasks(id).map((t) => t.threadId).sort()).toEqual([older, newer].sort());
  });
});

describe("thread sync delete", () => {
  function setup() {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const store = new Store((): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
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
      adopt: (botId, file) => void store.adoptSyncedTask(botId, file.task, file.messages, file.activeLeafId, true),
      remove: (botId, threadId) => void store.removeSyncedTask(botId, threadId),
      conflicted: () => {},
    };
    const switched: unknown[] = [];
    store.onChange((change) => {
      if (change.type === "bot") switched.push(change.switched);
    });
    return { folder, a, b, store, botId: bot.id, switched };
  }

  afterEach(() => closeMessageDb());

  it("writes a tombstone and removes the thread file", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    deleteSyncedThread(a.host, BOT_SYNC_ID, "t1");
    expect(existsSync(remotePath(folder, "t1"))).toBe(false);
    expect(JSON.parse(readFileSync(tombstonePath(folder, "t1"), "utf8"))).toEqual({
      format: THREAD_SYNC_FORMAT,
      threadId: "t1",
      deletedAt: 1_700_000_000_500,
      writerDeviceId: "device-a",
    });
    expect(a.host.ledger.t1).toBeUndefined();
    expect(loadThreadSyncLedger(a.dataDir).t1).toBeUndefined();
  });

  it("deletes a tombstoned thread and switches off it when active", () => {
    const { a, b, store, botId, switched } = setup();
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    a.say("t2", "m2", "other");
    uploadThread(a.host, BOT_SYNC_ID, "t2");
    pullBotThreads(b, botId, BOT_SYNC_ID);
    store.switchTask(botId, "t1");
    switched.length = 0;
    deleteSyncedThread(a.host, BOT_SYNC_ID, "t1");
    expect(pullBotThreads(b, botId, BOT_SYNC_ID)).toEqual({ t1: "deleted", t2: "current" });
    expect(store.taskByThread(botId, "t1")).toBeUndefined();
    expect(store.messagesFor("t1")).toEqual([]);
    expect(store.bot(botId)?.threadId).toBe("t2");
    expect(switched).toEqual([true]);
    expect(b.ledger.t1).toBeUndefined();
  });

  it("leaves one fresh empty task when the last task is tombstoned", () => {
    const { a, b, store, botId, switched } = setup();
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    pullBotThreads(b, botId, BOT_SYNC_ID);
    expect(store.tasks(botId).map((t) => t.threadId)).toEqual(["t1"]);
    switched.length = 0;
    deleteSyncedThread(a.host, BOT_SYNC_ID, "t1");
    pullBotThreads(b, botId, BOT_SYNC_ID);
    const tasks = store.tasks(botId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.threadId).not.toBe("t1");
    expect(store.bot(botId)?.threadId).toBe(tasks[0]!.threadId);
    expect(store.messagesFor(tasks[0]!.threadId)).toEqual([]);
    expect(switched).toEqual([true]);
  });

  it("never re-imports or re-uploads a tombstoned thread", () => {
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const b = pc("device-b", folder);
    const c = pc("device-c", folder);
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1");
    const copy = readFileSync(remotePath(folder, "t1"));
    deleteSyncedThread(b.host, BOT_SYNC_ID, "t1");
    b.threads.delete("t1");
    a.say("t1", "m2", "late");
    expect(uploadThread(a.host, BOT_SYNC_ID, "t1")).toBe("skipped");
    expect(existsSync(remotePath(folder, "t1"))).toBe(false);
    // Drive restores a stale copy after the tombstone landed
    writeFileSync(remotePath(folder, "t1"), copy);
    expect(pullBotThreads(c.host, "bot-c", BOT_SYNC_ID)).toEqual({ t1: "current" });
    expect(pullThread(c.host, "bot-c", BOT_SYNC_ID, "t1")).toBe("skipped");
    expect(c.threads.has("t1")).toBe(false);
  });
});

describe("thread sync poll", () => {
  function poll() {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const folder = temp("thread-sync-folder-");
    const a = pc("device-a", folder);
    const b = pc("device-b", folder);
    const sync = createThreadSyncPoll(() => ({ host: b.host, bots: [{ botId: "bot-b", botSyncId: BOT_SYNC_ID }] }));
    return { a, b, sync, log };
  }

  it("adopts a file that appears after start within one tick", () => {
    const { a, b, sync, log } = poll();
    sync.start();
    expect(log).toHaveBeenCalledWith(`chat sync: ${BOT_SYNC_ID} no thread dir (ENOENT)`);
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    vi.advanceTimersByTime(THREAD_SYNC_POLL_MS);
    expect(b.threads.get("t1")?.messages.map((m) => m.text)).toEqual(["hello"]);
    sync.stop();
  });

  it("does not pull an unchanged file again", () => {
    const { a, b, sync } = poll();
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    sync.start();
    expect(b.threads.has("t1")).toBe(true);
    // a pull now would re-adopt it
    b.threads.delete("t1");
    delete b.host.ledger.t1;
    vi.advanceTimersByTime(THREAD_SYNC_POLL_MS);
    expect(b.threads.has("t1")).toBe(false);
    sync.stop();
  });

  it("retries a running thread on the next tick", () => {
    const { a, b, sync, log } = poll();
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    b.running.add("t1");
    sync.start();
    expect(log).toHaveBeenCalledWith(`chat sync: ${BOT_SYNC_ID} imported 0 current 0 skipped [t1.json]`);
    vi.advanceTimersByTime(THREAD_SYNC_POLL_MS);
    expect(b.threads.has("t1")).toBe(false);
    b.running.delete("t1");
    vi.advanceTimersByTime(THREAD_SYNC_POLL_MS);
    expect(b.threads.get("t1")?.messages.map((m) => m.text)).toEqual(["hello"]);
    expect(log).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it("applies a tombstone only once no turn runs on the thread", () => {
    const { a, b, sync, log } = poll();
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    pullThread(b.host, "bot-b", BOT_SYNC_ID, "t1");
    deleteSyncedThread(a.host, BOT_SYNC_ID, "t1");
    b.running.add("t1");
    sync.start();
    expect(log).toHaveBeenCalledWith(`chat sync: ${BOT_SYNC_ID} imported 0 current 0 skipped [t1.deleted.json]`);
    vi.advanceTimersByTime(THREAD_SYNC_POLL_MS);
    expect(b.threads.has("t1")).toBe(true);
    b.running.delete("t1");
    vi.advanceTimersByTime(THREAD_SYNC_POLL_MS);
    expect(b.threads.has("t1")).toBe(false);
    expect(b.host.ledger.t1).toBeUndefined();
    sync.stop();
  });

  it("logs a lost thread dir once until it comes back", () => {
    const { a, sync, log } = poll();
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    sync.start();
    log.mockClear();
    const dir = threadSyncDir(a.host.folder, BOT_SYNC_ID);
    rmSync(dir, { recursive: true });
    vi.advanceTimersByTime(THREAD_SYNC_POLL_MS * 2);
    expect(log.mock.calls).toEqual([[`chat sync: ${BOT_SYNC_ID} no thread dir (ENOENT)`]]);
    mkdirSync(dir, { recursive: true });
    vi.advanceTimersByTime(THREAD_SYNC_POLL_MS);
    rmSync(dir, { recursive: true });
    vi.advanceTimersByTime(THREAD_SYNC_POLL_MS);
    expect(log).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it("stops polling when chat sync turns off", () => {
    const { a, b, sync } = poll();
    sync.start();
    sync.stop();
    expect(vi.getTimerCount()).toBe(0);
    a.say("t1", "m1", "hello");
    uploadThread(a.host, BOT_SYNC_ID, "t1");
    vi.advanceTimersByTime(THREAD_SYNC_POLL_MS * 2);
    expect(b.threads.has("t1")).toBe(false);
  });
});
