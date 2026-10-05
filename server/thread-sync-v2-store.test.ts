import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { Message, TaskRecord } from "./store.ts";
import { CONFLICT_NOTICE } from "./thread-sync.ts";
import { ThreadSyncV2 } from "./thread-sync-v2.ts";
import { writeDeviceRecord } from "./device-sync.ts";
import type { Snapshot, TestArgs, TestResult } from "./testing/thread-sync-v2-pc.ts";

const roots: string[] = [];
const peers: Array<{ close(): Promise<void> }> = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "sync-v2-store-"));
  roots.push(root);
  return root;
};

function pc(folder: string, deviceId: string, enabled = true, legacy = false, auto = false) {
  const dataDir = temp();
  const worker = new Worker(new URL("./testing/thread-sync-v2-pc.ts", import.meta.url), {
    workerData: { folder, dataDir, deviceId, enabled, legacy, auto },
    env: { ...process.env, OMB_DATA_DIR: dataDir, OMB_THREAD_SYNC_V2: enabled ? "1" : "0" },
    execArgv: ["--experimental-strip-types"],
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: TestResult): void; reject(error: Error): void }>();
  worker.on("message", ({ id, value, error }: { id: number; value: TestResult; error?: string }) => {
    const request = pending.get(id);
    pending.delete(id);
    if (error) request?.reject(new Error(error));
    else request?.resolve(value);
  });
  worker.on("error", (error) => {
    for (const request of pending.values()) request.reject(error instanceof Error ? error : new Error(String(error)));
    pending.clear();
  });
  const exited = new Promise<void>((resolve) => worker.on("exit", () => resolve()));
  function call<T extends TestResult = TestResult>(method: string, args: TestArgs = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      // SAFETY: Test callers pair each fixture method with its declared response.
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      worker.postMessage({ id, method, args });
    });
  }
  const peer = {
    call,
    dataDir,
    snapshot: () => call<Snapshot>("snapshot"),
    async close() { await call("close"); await exited; },
  };
  peers.push(peer);
  return peer;
}

function sourceRows(dataDir: string): Array<{ path: string; hash: string | null; done: number }> {
  const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
  try {
    // SAFETY: This projection selects path, hash, and done.
    return db.prepare("SELECT path, hash, done FROM sync_v2_sources ORDER BY id").all() as Array<{ path: string; hash: string | null; done: number }>;
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.all(peers.splice(0).map((peer) => peer.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("store delta sync", () => {
  it("retries a failed scheduled publication without another local edit", async () => {
    const folder = temp();
    const blocked = join(folder, "threads-v2");
    writeFileSync(blocked, "unavailable");
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const row = await a.call<Message>("append", { text: "retry me" });
    await delay(3_300);
    unlinkSync(blocked);
    await a.call("poll");
    await delay(3_300);
    await b.call("pull");
    expect((await b.snapshot()).rows).toMatchObject([{ id: row.id, text: "retry me" }]);
  });

  it("does not recount migrated history on idle polls", async () => {
    const a = pc(temp(), "a", true, true);
    await a.call("poll");
    await a.call("flush");
    const other = await a.call<TaskRecord>("create");
    await a.call("append", { threadId: other.threadId, text: "other task" });
    await a.call("flush", { threadId: other.threadId });
    await a.call("poll");
    const first = await a.snapshot();
    await a.call("poll");
    await a.call("poll");
    expect((await a.snapshot()).historyScans).toBe(first.historyScans);
  });

  it("checks the active path once per new conflict and keeps one notice", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const row = await a.call<Message>("append", { text: "base" });
    await a.call("flush");
    await b.call("pull");
    await a.call("patch", { id: row.id, patch: { text: "a" } });
    await b.call("patch", { id: row.id, patch: { text: "b" } });
    await a.call("flush");
    await b.call("pull");
    const first = await b.snapshot();
    expect(first.noticeChecks).toBe(1);
    await b.call("poll");
    await b.call("poll");
    expect((await b.snapshot()).noticeChecks).toBe(first.noticeChecks);
    await a.call("patch", { id: row.id, patch: { text: "a again" } });
    await a.call("flush");
    await b.call("pull");
    const second = await b.snapshot();
    expect(second.noticeChecks).toBe(first.noticeChecks + 1);
    expect(second.rows.filter((message) => message.tool?.name === `error: ${CONFLICT_NOTICE}`)).toHaveLength(1);
    await b.call("restart");
    await b.call("poll");
    expect((await b.snapshot()).noticeChecks).toBe(second.noticeChecks);
  });

  it("keeps v1 working until both fresh PCs update, then migrates once", async () => {
    const folder = temp();
    const now = Date.now();
    const record = (deviceId: string) => ({ deviceId, name: deviceId, host: `${deviceId}.example.com` });
    writeDeviceRecord(folder, { ...record("a"), chatSync: 2 }, now);
    writeDeviceRecord(folder, record("b"), now);
    writeDeviceRecord(folder, record("c"), now - 4 * 86400_000);
    const a = pc(folder, "a", true, true, true);
    const b = pc(folder, "b", true, true, true);
    const before = [(await a.snapshot()).rows[0].id, (await b.snapshot()).rows[0].id];
    await a.call("poll");
    await b.call("poll");
    expect((await a.snapshot()).hasSync).toBe(false);
    expect((await b.snapshot()).hasSync).toBe(false);
    const dir = join(folder, "threads", "bot");
    const frozen = readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]);
    writeDeviceRecord(folder, { ...record("b"), chatSync: 2 }, now);
    await a.call("poll");
    await a.call("flush");
    await b.call("poll");
    await b.call("flush");
    await a.call("poll");
    writeDeviceRecord(folder, record("old"), now);
    await a.call("restart");
    await a.call("poll");
    for (const peer of [a, b]) {
      const state = await peer.snapshot();
      expect(state.hasSync).toBe(true);
      const ids = state.rows.filter((row) => row.kind === "text").map((row) => row.id);
      expect(ids.sort()).toEqual(before.sort());
    }
    expect(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")])).toEqual(frozen);
  });

  it("adopts local edits on two PCs, emits events, invalidates cursors and suppresses echo", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const row = await a.call<Message>("append", { text: "first" });
    await a.call("flush");
    await b.call("cursor");
    await b.call("pull");
    const first = await b.snapshot();
    expect(first.rows).toMatchObject([{ id: row.id, text: "first" }]);
    expect(first.events).toContainEqual(expect.objectContaining({ type: "message", imported: true, importing: true }));
    expect(first.tasks.find((task) => task.threadId === "thread")?.resumeCursors).toEqual({});
    expect(first.outbox).toBe(0);
    await a.call("patch", { id: row.id, patch: { text: "edited" } });
    await a.call("rename", { title: "Renamed" });
    await a.call("flush");
    await b.call("pull");
    const second = await b.snapshot();
    expect(second.rows[0].text).toBe("edited");
    expect(second.events).toContainEqual(expect.objectContaining({ type: "message.patch", importing: true }));
    expect(second.tasks.find((task) => task.threadId === "thread")?.title).toBe("Renamed");
    expect(second.outbox).toBe(0);
    await b.call("pull");
    expect((await b.snapshot()).events).toEqual([]);
  });

  it("defers flush while a turn is running", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    await a.call("append", { text: "stream" });
    await a.call("live", { value: true });
    expect(await a.call("flush")).toBe("running");
    expect(existsSync(join(folder, "threads-v2"))).toBe(false);
    await a.call("live", { value: false });
    expect(await a.call("flush")).toBe("written");
  });

  it("coalesces writes on the three-second timer and retries after a running turn", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const row = await a.call<Message>("append", { text: "first" });
    await a.call("patch", { id: row.id, patch: { text: "latest" } });
    await a.call("live", { value: true });
    await delay(3_300);
    expect(existsSync(join(folder, "threads-v2"))).toBe(false);
    await a.call("live", { value: false });
    await delay(3_300);
    await b.call("pull");
    expect((await b.snapshot()).rows[0].text).toBe("latest");
  });

  it("bounds worker publication to the versions captured while idle", async () => {
    const folder = temp();
    const a = new ThreadSyncV2({ folder, dataDir: temp(), deviceId: "a" });
    const b = new ThreadSyncV2({ folder, dataDir: temp(), deviceId: "b" });
    const scope = { botSyncId: "bot", threadId: "thread" };
    const row: Message = { id: "row", role: "user", kind: "text", at: 1, text: "idle" };
    try {
      await a.commit(scope, [{ kind: "row", value: row }]);
      const idle = await a.state(scope);
      await a.commit(scope, [{ kind: "row", value: { ...row, text: "streaming" } }]);
      await a.flush(scope, undefined, idle.seen[idle.writerId]);
      await b.pull(scope);
      expect((await b.scan("thread")).messages[0].text).toBe("idle");
      await a.flush(scope);
      await b.pull(scope);
      expect((await b.scan("thread")).messages[0].text).toBe("streaming");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("stages an in-flight pull without clobbering a turn that starts during worker I/O", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const row = await a.call<Message>("append", { text: "base" });
    await a.call("flush");
    await b.call("pull");
    await a.call("patch", { id: row.id, patch: { text: "remote edit" } });
    await a.call("flush");
    await b.call("race");
    await b.call("pull");
    await b.call("patch", { id: row.id, patch: { text: "streaming" } });
    const during = await b.snapshot();
    expect(during.pending).toBeGreaterThan(0);
    expect(during.rows[0].text).toBe("streaming");
    expect(during.disk[0].text).toBe("streaming");
    await b.call("live", { value: false });
    await b.call("pull");
    expect((await b.snapshot()).rows.some((message) => message.tool?.name === `error: ${CONFLICT_NOTICE}`)).toBe(true);
  });

  it("keeps notice filtering, lifted parents and picture publication", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const first = await a.call<Message>("append", { text: "parent" });
    await a.call("notice");
    const row = await a.call<Message>("picture");
    await a.call("flush");
    await b.call("pull");
    const remote = await b.snapshot();
    expect(remote.rows).toHaveLength(2);
    expect(remote.rows[1]).toMatchObject({ id: row.id, parentId: first.id, image: "test.png", shown: true });
    expect(remote.rows[1].png).toBeUndefined();
    expect(remote.rows[1].mime).toBeUndefined();
    expect((await a.snapshot()).rows.at(-1)?.png).toBe("pixels");
    expect(readFileSync(join(folder, "pictures", "test.png"), "utf8")).toBe("picture-bytes");
  });

  it("rolls back the local row when the outbox transaction fails", async () => {
    const a = pc(temp(), "a");
    await a.call("fail");
    await expect(a.call("append", { text: "must roll back" })).rejects.toThrow("outbox rejected");
    const state = await a.snapshot();
    expect(state.disk).toEqual([]);
    expect(state.outbox).toBe(0);
  });

  it("rolls back metadata and deletion with a rejected outbox", async () => {
    const a = pc(temp(), "a");
    await a.call("append", { text: "keep" });
    await a.call("create");
    await a.call("fail");
    await expect(a.call("rename", { title: "Rejected" })).rejects.toThrow("outbox rejected");
    await expect(a.call("delete")).rejects.toThrow("outbox rejected");
    expect((await a.snapshot()).disk[0].text).toBe("keep");
    await a.call("restart");
    expect((await a.snapshot()).tasks.find((task) => task.threadId === "thread")?.title).toBe("Chat");
  });

  it("discovers and follows a new task without echoing the discarded empty task", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const task = await a.call<TaskRecord>("create");
    await a.call("append", { threadId: task.threadId, text: "new task" });
    await a.call("flush", { threadId: task.threadId });
    await b.call("poll");
    const state = await b.snapshot();
    expect(state.tasks.map((item) => item.threadId)).toEqual([task.threadId]);
    expect(state.outbox).toBe(0);
    await b.call("restart");
    expect((await b.snapshot()).tasks.map((item) => item.threadId)).toEqual([task.threadId]);
  });

  it("replays bounded pages and metadata after restart on three PCs", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const c = pc(folder, "c");
    await a.call("batch", { count: 140 });
    await a.call("rename", { title: "Durable" });
    await a.call("restart");
    await a.call("flush");
    await b.call("poll");
    await c.call("poll");
    for (const peer of [b, c]) {
      const state = await peer.snapshot();
      expect(state.rows).toHaveLength(140);
      expect(state.tasks.find((task) => task.threadId === "thread")?.title).toBe("Durable");
      expect(state.outbox).toBe(0);
    }
  });

  it("syncs branch heads and deletes without import echo", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const first = await a.call<Message>("append", { text: "original" });
    const branch = await a.call<Message>("branch", { id: first.id, text: "branch" });
    await a.call("flush");
    await b.call("pull");
    expect((await b.snapshot()).leaf).toBe(branch.id);
    await a.call("head", { id: first.id });
    await a.call("flush");
    await b.call("pull");
    expect((await b.snapshot()).leaf).toBe(first.id);
    await a.call("create");
    await a.call("delete");
    await a.call("flush");
    await b.call("pull");
    const state = await b.snapshot();
    expect(state.tasks.some((task) => task.threadId === "thread")).toBe(false);
    expect(state.disk).toEqual([]);
    expect(state.outbox).toBe(0);
  });

  it("recovers every row when an offline edit races an already applied deletion", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const c = pc(folder, "c");
    const first = await a.call<Message>("append", { text: "first" });
    await a.call("append", { text: "keep this too" });
    await a.call("flush");
    await b.call("pull");
    await c.call("pull");
    await a.call("create");
    await a.call("delete");
    await a.call("flush");
    await b.call("pull");
    await c.call("patch", { id: first.id, patch: { text: "offline edit" } });
    await c.call("flush");
    await b.call("poll");
    expect((await b.snapshot()).rows.filter((row) => row.kind === "text").map((row) => row.text).sort()).toEqual(["keep this too", "offline edit"]);
  });

  it("leaves legacy rows untouched until migration", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b", true, true);
    await a.call("append", { text: "remote" });
    await a.call("flush");
    await b.call("pull");
    expect((await b.snapshot()).rows).toMatchObject([{ text: "legacy" }]);
    expect(await b.call("flush")).toBe("skipped");
    await b.call("poll");
    await b.call("flush");
    await a.call("pull");
    expect((await a.snapshot()).rows.filter((row) => row.kind === "text").map((row) => row.text).sort()).toEqual(["legacy", "remote"]);
    expect((await b.snapshot()).rows.filter((row) => row.kind === "text").map((row) => row.text).sort()).toEqual(["legacy", "remote"]);
  });

  it("snapshots local edits made before migration and includes a late laptop", async () => {
    const folder = temp();
    const a = pc(folder, "a", true, true);
    const b = pc(folder, "b", true, true);
    const c = pc(folder, "c", true, true);
    const original = (await a.snapshot()).rows[0];
    await a.call("patch", { id: original.id, patch: { text: "edited" } });
    await a.call("append", { text: "during migration" });
    await a.call("poll");
    await a.call("flush");
    await b.call("poll");
    await b.call("flush");
    await a.call("poll");
    await c.call("append", { text: "laptop only" });
    await c.call("poll");
    await c.call("flush");
    await a.call("poll");
    await b.call("poll");
    for (const peer of [a, b, c]) {
      const rows = (await peer.snapshot()).rows.filter((row) => row.kind === "text");
      expect(new Set(rows.map((row) => row.id)).size).toBe(5);
      expect(rows.map((row) => row.text)).toContain("laptop only");
      expect(rows.find((row) => row.id === original.id)?.text).toBe("edited");
    }
  });

  it("flushes local rows while an inventoried source is unreadable, then recovers it without clobbering v2", async () => {
    const folder = temp();
    const dir = join(folder, "threads", "bot");
    mkdirSync(dir, { recursive: true });
    const a = pc(folder, "a", true, true);
    const b = pc(folder, "b");
    const local = (await a.snapshot()).rows.find((row) => row.kind === "text");
    if (!local) throw new Error("missing local row");
    const source = join(dir, "thread.json");
    const legacy = {
      format: "orbit.thread-sync", version: 1, revision: 1, writerDeviceId: "old", updatedAt: 1,
      task: { threadId: "thread", title: "Chat", createdAt: 1 }, activeLeafId: "remote",
      messages: [
        { id: local.id, role: "user", kind: "text", at: 1, parentId: null, text: "source copy" },
        { id: "remote", role: "user", kind: "text", at: 1, parentId: null, text: "remote" },
      ],
    };
    writeFileSync(source, JSON.stringify(legacy));
    const saved = readFileSync(source);
    const stuck = join(dir, "thread.conflict-stuck.json");
    writeFileSync(stuck, "{truncated");
    const before = readdirSync(dir).sort();
    await a.call("live", { value: true });
    await a.call("poll");
    writeFileSync(source, "{truncated");
    await a.call("live", { value: false });
    await a.call("poll");
    const sent = await a.call<Message>("append", { text: "fresh" });
    await a.call("patch", { id: local.id, patch: { text: "native" } });
    expect(await a.call("flush")).toBe("written");
    await b.call("pull");
    expect((await b.snapshot()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sent.id, text: "fresh" }),
      expect.objectContaining({ id: local.id, text: "native" }),
    ]));
    const pending = sourceRows(a.dataDir);
    expect(pending.every((row) => row.done === 0 && row.hash === null)).toBe(true);
    expect(pending).toHaveLength(2);
    writeFileSync(source, saved);
    let restored = sourceRows(a.dataDir);
    for (let i = 0; i < 5 && !restored.some((row) => row.path.endsWith("thread.json") && row.done === 1); i++) {
      await a.call("poll");
      restored = sourceRows(a.dataDir);
    }
    expect(await a.call("flush")).toBe("written");
    await b.call("pull");
    for (const peer of [a, b]) {
      const rows = (await peer.snapshot()).rows.filter((row) => row.kind === "text");
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      expect(rows.find((row) => row.id === local.id)?.text).toBe("native");
      expect(rows.filter((row) => row.id === "remote")).toHaveLength(1);
    }
    const done = sourceRows(a.dataDir);
    expect(done.find((row) => row.path.endsWith("thread.json"))).toMatchObject({ done: 1 });
    expect(done.find((row) => row.path.endsWith("thread.conflict-stuck.json"))).toMatchObject({ done: 0, hash: null });
    expect(readFileSync(source)).toEqual(saved);
    expect(readFileSync(stuck, "utf8")).toBe("{truncated");
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("creates no v2 tables, files or worker with the switch off", async () => {
    const folder = temp();
    const a = pc(folder, "a", false);
    await a.call("append", { text: "v1" });
    await a.call("flush");
    await a.call("poll");
    const state = await a.snapshot();
    expect(state.hasSync).toBe(false);
    expect(state.files.some((name) => name.includes("sync-v2"))).toBe(false);
    expect(existsSync(join(folder, "threads-v2"))).toBe(false);
    expect(state.rows[0].text).toBe("v1");
  });
});
