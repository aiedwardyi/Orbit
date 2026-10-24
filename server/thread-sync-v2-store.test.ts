import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message, TaskRecord } from "./store.ts";
import { CONFLICT_NOTICE } from "./thread-sync.ts";
import { ThreadSyncV2 } from "./thread-sync-v2.ts";
import { writeDeviceRecord } from "./device-sync.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { Snapshot, TestArgs, TestResult } from "./testing/thread-sync-v2-pc.ts";

const roots: string[] = [];
const peers: Array<{ close(): Promise<void> }> = [];
const CONFLICT_NOTICE_V2 = "This chat also changed on another PC. Both versions were kept.";
const isConflictNotice = (message: Message) => [CONFLICT_NOTICE, CONFLICT_NOTICE_V2].some((notice) => message.tool?.name === `error: ${notice}`);
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "sync-v2-store-"));
  roots.push(root);
  return root;
};

function pc(folder: string, deviceId: string, enabled = true, legacy = false, auto = false, writer?: string) {
  const dataDir = temp();
  const worker = new Worker(new URL("./testing/thread-sync-v2-pc.ts", import.meta.url), {
    workerData: { folder, dataDir, deviceId, enabled, legacy, auto, writer },
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
  let gone: Error | undefined;
  const exited = new Promise<void>((resolve) => worker.on("exit", (code) => {
    gone = new Error(`worker exited with code ${code}`);
    for (const request of pending.values()) request.reject(gone);
    pending.clear();
    resolve();
  }));
  function call<T extends TestResult = TestResult>(method: string, args: TestArgs = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (gone) return reject(gone);
      const id = ++sequence;
      // SAFETY: Test callers pair each fixture method with its declared response.
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      worker.postMessage({ id, method, args });
    });
  }
  const peer = {
    call,
    dataDir,
    worker,
    snapshot: () => call<Snapshot>("snapshot"),
    async close() {
      const timer = setTimeout(() => void worker.terminate(), 10_000);
      try {
        await call("close").catch(() => {});
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
  peers.push(peer);
  return peer;
}

function migrationRow(dataDir: string, threadId: string): { phase: string; error: string | null; eligible: number } {
  const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
  try {
    // SAFETY: This projection selects the migration phase, its error, and eligibility.
    const row = db.prepare(`SELECT m.phase AS phase, m.error AS error, s.eligible AS eligible
      FROM sync_v2_migration m JOIN sync_v2_store s ON s.threadId = m.thread WHERE m.thread = ?`).get(threadId) as { phase: string; error: string | null; eligible: number } | undefined;
    if (!row) throw new Error(`missing migration for ${threadId}`);
    return row;
  } finally {
    db.close();
  }
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

const LOW = "1a000000-0000-4000-8000-000000000000";
const MID = "5b000000-0000-4000-8000-000000000000";
const HIGH = "fc000000-0000-4000-8000-000000000000";

function isolated(writers: string[]) {
  return writers.map((writer, i) => {
    const folder = temp();
    return { folder, writer, peer: pc(folder, `pc${i}`, true, false, false, writer) };
  });
}

// Separate folders let each PC resolve before the others' resolving heads reach it.
function share(to: Array<{ folder: string }>, from: Array<{ folder: string; writer: string }>): void {
  for (const source of from) {
    const dir = join("threads-v2", "bot", "thread", source.writer);
    if (!existsSync(join(source.folder, dir))) continue;
    for (const target of to) if (target.folder !== source.folder) cpSync(join(source.folder, dir), join(target.folder, dir), { recursive: true });
  }
}

function heads(dataDir: string): Array<{ writer: string; value: string | null }> {
  const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
  try {
    // Writer order is the pick an older build makes.
    return db.prepare("SELECT writer, json FROM sync_v2_frontier WHERE kind = 'head' ORDER BY writer DESC, seq DESC").all()
      .map((row) => ({ writer: String(row.writer), value: JSON.parse(String(row.json)).value }));
  } finally {
    db.close();
  }
}

function joinCount(dataDir: string): number {
  const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM sync_v2_joins").get()!.n);
  } finally {
    db.close();
  }
}

// A kept split puts its notice on top of the main tip.
function tip(snapshot: Snapshot): string | null {
  const leaf = snapshot.rows.find((row) => row.id === snapshot.leaf);
  return leaf && isConflictNotice(leaf) ? leaf.parentId ?? null : snapshot.leaf;
}

function path(snapshot: Snapshot): string[] {
  const ids: string[] = [];
  for (let id = snapshot.leaf; id;) {
    ids.unshift(id);
    id = snapshot.rows.find((row) => row.id === id)?.parentId ?? null;
  }
  return ids;
}

// c pulled only the base row before a typed 50 more.
async function behind() {
  const folder = temp();
  const a = pc(folder, "a", true, false, false, LOW);
  const c = pc(folder, "c", true, false, false, HIGH);
  await a.call("append", { text: "base" });
  await a.call("flush");
  await c.call("pull");
  await a.call("batch", { count: 50 });
  await a.call("flush");
  return { a, c, main: (await a.snapshot()).leaf };
}

async function exchange(a: ReturnType<typeof pc>, c: ReturnType<typeof pc>): Promise<void> {
  await c.call("flush");
  await a.call("pull");
  await a.call("flush");
  await c.call("pull");
  await c.call("flush");
  await a.call("pull");
}

afterEach(async () => {
  await Promise.all(peers.splice(0).map((peer) => peer.close()));
  await Promise.all(roots.splice(0).map(removeTempDir));
});

describe("store delta sync", { timeout: 60_000 }, () => {
  it("prefers main history after a stale PC sees a newer conflict branch first", async () => {
    const main = temp();
    const stale = temp();
    const row = (id: string, parentId: string | null, at: number): Message => ({ id, parentId, at, role: "user", kind: "text", text: id });
    const base = row("base", null, 1);
    const parked = row("parked", "base", 1000);
    const current = row("current", "base", 2);
    for (const folder of [main, stale]) {
      const dir = join(folder, "threads", "bot");
      mkdirSync(dir, { recursive: true });
      const file = { format: "orbit.thread-sync", version: 1, revision: 1, writerDeviceId: "old", updatedAt: 1,
        task: { threadId: "thread", title: "Chat", createdAt: 1 } };
      writeFileSync(join(dir, "thread.json"), JSON.stringify({ ...file, messages: folder === main ? [base, current] : [base], activeLeafId: folder === main ? current.id : base.id }));
      writeFileSync(join(dir, "thread.conflict-old.json"), JSON.stringify({ ...file, messages: [base, parked], activeLeafId: parked.id }));
    }
    const a = pc(main, "a", true, false, true);
    const b = pc(main, "b", true, false, true);
    const c = pc(stale, "c", true, false, true);
    for (const [peer, messages] of [[a, [base, current]], [b, [base, current]], [c, [base]]] as const) {
      await peer.call("seed", { rows: [...messages], leaf: messages.at(-1)!.id });
      await peer.call("poll");
      await peer.call("flush");
    }
    expect((await c.snapshot()).rows.some((message) => message.id === parked.id)).toBe(true);
    cpSync(join(main, "threads-v2"), join(stale, "threads-v2 (1)"), { recursive: true });
    for (const peer of [a, b, c]) {
      await peer.call("poll");
      const snapshot = await peer.snapshot();
      expect(snapshot.leaf).toBe(current.id);
      expect(snapshot.rows.map((message) => message.id).sort()).toEqual(["base", "current", "parked"]);
      expect(snapshot.rows.filter(isConflictNotice)).toHaveLength(0);
      await peer.call("restart");
      await peer.call("poll");
      expect((await peer.snapshot()).leaf).toBe(current.id);
    }
  });

  it("removes a migration notice on restart and reconnects later messages", async () => {
    const a = pc(temp(), "a", true, true);
    await a.call("poll");
    const before = await a.snapshot();
    await a.call("migrationNotice");
    const child = await a.call<Message>("append", { text: "after migration" });
    expect((await a.snapshot()).rows.filter(isConflictNotice)).toHaveLength(1);
    await a.call("restart");
    const after = await a.snapshot();
    expect(after.rows.filter(isConflictNotice)).toHaveLength(0);
    expect(after.rows.find((row) => row.id === child.id)?.parentId).toBe(before.leaf);
    expect(after.leaf).toBe(child.id);
    expect(after.disk).toEqual(after.rows);
    await a.call("restart");
    expect((await a.snapshot()).rows).toEqual(after.rows);
    await a.call("migrationNotice", { at: 0 });
    await a.call("restart");
    expect((await a.snapshot()).rows.some((message) => message.id === "migration-notice")).toBe(true);
  });

  it("retains an old notice when native edits really conflicted, even after resolution", async () => {
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
    expect((await b.snapshot()).rows.some((message) => message.tool?.name === `error: ${CONFLICT_NOTICE_V2}`)).toBe(true);
    await b.call("migrationNotice");
    await b.call("patch", { id: row.id, patch: { text: "resolved" } });
    await b.call("restart");
    expect((await b.snapshot()).rows.some((message) => message.id === "migration-notice")).toBe(true);
  });

  it("removes a migration notice when only the branch heads forked", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    await a.call("append", { text: "base" });
    await a.call("flush");
    await b.call("pull");
    await a.call("append", { text: "a" });
    await b.call("append", { text: "b" });
    await a.call("flush");
    await b.call("pull");
    await b.call("migrationNotice");
    await b.call("restart");
    expect((await b.snapshot()).rows.some((message) => message.id === "migration-notice")).toBe(false);
  });

  it("heals two current PCs and a stale laptop after simultaneous migration into split roots", async () => {
    const folders = [temp(), temp(), temp()];
    const rows: Message[] = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, parentId: i ? `m${i - 1}` : null, at: i, role: "user", kind: "text", text: `row ${i}` }));
    for (const [i, folder] of folders.entries()) {
      const messages = i === 2 ? rows.slice(0, 30) : rows;
      const dir = join(folder, "threads", "bot");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "thread.json"), JSON.stringify({ format: "orbit.thread-sync", version: 1, revision: 1, writerDeviceId: "old", updatedAt: 1,
        task: { threadId: "thread", title: "Chat", createdAt: 1 }, messages, activeLeafId: messages.at(-1)!.id }));
    }
    const all = folders.map((folder, i) => pc(folder, `pc${i}`, true, false, true));
    for (const [i, peer] of all.entries()) {
      const messages = i === 2 ? rows.slice(0, 30) : rows;
      await peer.call("seed", { rows: messages, leaf: messages.at(-1)!.id });
    }
    for (const peer of all) { await peer.call("poll"); await peer.call("flush"); }
    for (const [i, folder] of folders.entries()) {
      for (const [j, source] of folders.entries()) {
        if (i !== j) cpSync(join(source, "threads-v2"), join(folder, `threads-v2 (${j + 1})`), { recursive: true });
      }
    }
    for (const peer of all) {
      await peer.call("poll");
      const after = await peer.snapshot();
      expect(after.rows.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
      expect(after.leaf).toBe("m299");
      expect(after.disk).toEqual(after.rows);
      await peer.call("poll");
      await peer.call("poll");
      expect((await peer.snapshot()).headChecks).toBe(after.headChecks);
      await peer.call("restart");
      await peer.call("poll");
      expect((await peer.snapshot()).leaf).toBe("m299");
    }
  });

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
    await vi.waitFor(async () => {
      await b.call("pull");
      expect((await b.snapshot()).rows).toMatchObject([{ id: row.id, text: "retry me" }]);
    }, { timeout: 15_000, interval: 250 });
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

  it("polls the most recently opened thread first, once per poll", async () => {
    const a = pc(temp(), "a");
    for (const threadId of ["a-other", "z-open"]) {
      await a.call("seed", { threadId });
      await a.call("append", { threadId, text: threadId });
      await a.call("flush", { threadId });
    }
    await a.call("open", { threadId: "a-other" });
    await a.call("open", { threadId: "z-open" });
    await a.snapshot();
    await a.call("poll");
    expect((await a.snapshot()).pulls).toEqual(["z-open", "a-other"]);
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
    expect(second.rows.filter(isConflictNotice)).toHaveLength(1);
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

  for (const [order, home, laptop] of [["higher", "8d89407d-0000-4000-8000-000000000000", "8d98ea7a-0000-4000-8000-000000000000"],
    ["lower", "8d98ea7a-0000-4000-8000-000000000000", "8d89407d-0000-4000-8000-000000000000"]]) {
    it(`keeps every PC on the main conversation when a stale PC's writer id sorts ${order}`, async () => {
      const folder = temp();
      const a = pc(folder, "a", true, false, false, home);
      const b = pc(folder, "b");
      const c = pc(folder, "c", true, false, false, laptop);
      await a.call("append", { text: "base" });
      await a.call("flush");
      await c.call("pull");
      await a.call("batch", { count: 50 });
      await a.call("flush");
      const main = (await a.snapshot()).leaf;
      await c.call("batch", { count: 4 });
      const stale = (await c.snapshot()).rows.slice(1);
      await c.call("pull");
      await c.call("flush");
      for (const peer of [a, b]) await peer.call("pull");
      for (const peer of [a, b, c]) {
        const snapshot = await peer.snapshot();
        expect(tip(snapshot)).toBe(main);
        expect(snapshot.rows.filter(isConflictNotice)).toHaveLength(peer === c ? 1 : 0);
        expect(stale.every((row) => snapshot.rows.some((message) => message.id === row.id))).toBe(true);
        await peer.call("restart");
        await peer.call("poll");
        expect(tip(await peer.snapshot())).toBe(main);
      }
      expect(await b.call("head", { id: stale[0].id })).toBe(stale.at(-1)!.id);
    });
  }

  it("joins a stale PC's send and reply onto the main branch on every PC", async () => {
    const { a, c, main } = await behind();
    const typed = await c.call<Message>("append", { text: "typed while stale" });
    const reply = await c.call<Message>("append", { text: "reply", role: "bot" });
    await exchange(a, c);
    for (const peer of [a, c]) {
      const snapshot = await peer.snapshot();
      expect(snapshot.leaf).toBe(reply.id);
      expect(snapshot.rows.find((message) => message.id === typed.id)?.parentId).toBe(main);
      expect(path(snapshot)).toHaveLength(snapshot.rows.length);
      expect(snapshot.rows.filter(isConflictNotice)).toHaveLength(0);
      expect(heads(peer.dataDir).map((head) => head.value)).toEqual([reply.id]);
      await peer.call("restart");
      await peer.call("poll");
      expect(path(await peer.snapshot())).toEqual(path(snapshot));
    }
  });

  for (const [setup, reason] of [["4 user turns", "4 user turns"], ["outside wake window", "outside wake window"], ["edit of the stale send", "edit or regenerate"],
    ["edit of a row both PCs had", "edit or regenerate"], ["switch back to the stale send", "branch switch"], ["another writer", "another writer"],
    ["edit, switch back, send again", "branch switch"], ["compaction in the stale rows", "compaction"]]) {
    it(`keeps a stale send split with a notice and a log line (${setup})`, async () => {
      const folder = temp();
      const a = pc(folder, "a", true, false, false, LOW);
      const c = pc(folder, "c", true, false, false, HIGH);
      const base = await a.call<Message>("append", { text: "base" });
      await a.call("flush");
      if (setup === "another writer") {
        const b = pc(folder, "b", true, false, false, MID);
        await b.call("pull");
        await b.call("append", { text: "from another PC" });
        await b.call("flush");
      }
      await c.call("pull");
      await a.call("batch", { count: 50 });
      await a.call("flush");
      const main = (await a.snapshot()).leaf;
      if (setup === "4 user turns") await c.call("batch", { count: 4 });
      else if (setup === "outside wake window") await c.call("append", { text: "typed late", at: Date.now() + 11 * 60_000 });
      else if (setup === "edit of a row both PCs had") await c.call("branch", { id: base.id, text: "edited" });
      else if (setup === "compaction in the stale rows") {
        const covered = await c.call<Message>("append", { text: "old work" });
        const kept = await c.call<Message>("append", { text: "recent work" });
        await c.call("compaction", { compaction: {
          v: 1,
          coveredThroughId: covered.id,
          firstKeptId: kept.id,
          contextWindow: 200_000,
          estimatedTokensBefore: 900,
          sourceMessageCount: 1,
          summary: "old work summary",
        } });
      } else {
        const sent = await c.call<Message>("append", { text: "typed while stale" });
        if (setup !== "another writer") await c.call("branch", { id: sent.id, text: "edited" });
        if (setup === "switch back to the stale send" || setup === "edit, switch back, send again") await c.call("head", { id: sent.id });
        if (setup === "edit, switch back, send again") await c.call("append", { text: "sent again" });
      }
      const stale = (await c.snapshot()).rows.slice(1);
      await exchange(a, c);
      for (const peer of [a, c]) {
        const snapshot = await peer.snapshot();
        expect(tip(snapshot)).toBe(main);
        expect(stale.every((row) => snapshot.rows.some((message) => message.id === row.id))).toBe(true);
        expect(snapshot.rows.filter(isConflictNotice)).toHaveLength(peer === c ? 1 : 0);
      }
      expect((await c.snapshot()).logs).toContain(`chat sync v2: kept thread split (${reason})`);
    });
  }

  it("joins a stale send when only the main PC wrote another version at the fork", async () => {
    const { a, c, main } = await behind();
    await a.call("branch", { id: (await a.snapshot()).rows[1].id, text: "edited on main" });
    await a.call("head", { id: main! });
    await a.call("flush");
    const sent = await c.call<Message>("append", { text: "typed while stale" });
    await exchange(a, c);
    for (const peer of [a, c]) {
      const snapshot = await peer.snapshot();
      expect(snapshot.leaf).toBe(sent.id);
      expect(snapshot.rows.find((row) => row.id === sent.id)?.parentId).toBe(main);
      expect(snapshot.rows.filter(isConflictNotice)).toHaveLength(0);
    }
  });

  it("notes the other PC's messages until a reply after a join and never after a normal pull", async () => {
    const { a, c } = await behind();
    await c.call("append", { text: "typed while stale" });
    await c.call("append", { text: "reply", role: "bot" });
    await exchange(a, c);
    await c.call("restart");
    const next = await c.call<Message>("append", { text: "next turn" });
    await c.call("append", { text: "reply on another branch", role: "bot" });
    await c.call("branch", { id: next.id, text: "retry without a reply" });
    expect(await c.call("note")).toBe("[Chat sync] 50 messages from the other PC arrived before your last reply.");
    expect(await c.call("note")).toBe("[Chat sync] 50 messages from the other PC arrived before your last reply.");
    expect(joinCount(a.dataDir)).toBe(0);
    expect(await a.call("note")).toBeNull();
    expect(joinCount(a.dataDir)).toBe(0);
    await exchange(a, c);
    await a.call("append", { text: "after the join" });
    await a.call("flush");
    await c.call("pull");
    expect(await c.call("note")).toBe("[Chat sync] 50 messages from the other PC arrived before your last reply.");
    await c.call("append", { text: "next reply", role: "bot" });
    expect(await c.call("note")).toBeNull();
    expect(joinCount(c.dataDir)).toBe(0);
    await exchange(a, c);
    await a.call("append", { text: "a normal pull" });
    await a.call("flush");
    await c.call("pull");
    expect(await c.call("note")).toBeNull();
    expect(joinCount(c.dataDir)).toBe(0);
  });

  for (const change of ["a reply from the other PC", "a branch switch"]) {
    it(`drops a join note after ${change}`, async () => {
      const { a, c } = await behind();
      const sent = await c.call<Message>("append", { text: "typed while stale" });
      await c.call("append", { text: "reply", role: "bot" });
      await exchange(a, c);
      if (change === "a reply from the other PC") {
        await a.call("append", { text: "continued on the other PC" });
        await a.call("append", { text: "later reply", role: "bot" });
        await a.call("flush");
        await c.call("pull");
      } else await c.call("branch", { id: sent.id, text: "another version" });
      expect(await c.call("note")).toBeNull();
      expect(joinCount(c.dataDir)).toBe(0);
    });
  }

  for (const outcome of ["a failed turn", "an empty stopped turn"]) {
    it(`keeps a join note after ${outcome} until a reply follows`, async () => {
      const { a, c } = await behind();
      await c.call("append", { text: "typed while stale" });
      await c.call("append", { text: "reply", role: "bot" });
      await exchange(a, c);
      await c.call("append", { text: "next turn" });
      expect(await c.call("note")).toBe("[Chat sync] 50 messages from the other PC arrived before your last reply.");
      if (outcome === "a failed turn") {
        const error = await c.call<Message>("notice");
        await c.call("patch", { id: error.id, patch: { tool: { name: "error: provider unavailable", ok: false } } });
      }
      await c.call("restart");
      expect(await c.call("note")).toBe("[Chat sync] 50 messages from the other PC arrived before your last reply.");
      expect(joinCount(c.dataDir)).toBe(1);
      await c.call("append", { text: "retry replied", role: "bot" });
      expect(await c.call("note")).toBeNull();
      expect(joinCount(c.dataDir)).toBe(0);
    });
  }

  it("converges on one head when the main PC keeps typing during a join", async () => {
    const { a, c } = await behind();
    await c.call("append", { text: "typed while stale" });
    await c.call("append", { text: "reply", role: "bot" });
    await c.call("flush");
    await a.call("pull");
    await a.call("flush");
    await c.call("pull");
    await a.call("append", { text: "typed on main before the join landed" });
    for (let round = 0; round < 4; round++) {
      for (const peer of [a, c]) await peer.call("flush");
      for (const peer of [a, c]) await peer.call("pull");
    }
    const [left, right] = await Promise.all([a.snapshot(), c.snapshot()]);
    expect(right.leaf).toBe(left.leaf);
    for (const [peer, snapshot] of [[a, left], [c, right]] as const) {
      expect(heads(peer.dataDir).map((head) => head.value)).toEqual([snapshot.leaf]);
      expect(snapshot.rows).toHaveLength(54);
      expect(path(snapshot)).toHaveLength(54);
    }
  });

  it("converges a PC that picks by writer id once the resolving head lands", async () => {
    const folder = temp();
    const a = pc(folder, "a", true, false, false, "1a000000-0000-4000-8000-000000000000");
    const b = pc(folder, "b", true, false, false, "5b000000-0000-4000-8000-000000000000");
    const c = pc(folder, "c", true, false, false, "fc000000-0000-4000-8000-000000000000");
    await a.call("append", { text: "base" });
    await a.call("flush");
    await c.call("pull");
    await a.call("batch", { count: 50 });
    await a.call("flush");
    await b.call("pull");
    const main = (await a.snapshot()).leaf;
    await c.call("batch", { count: 4 });
    await c.call("flush");
    await a.call("pull");
    await a.call("flush");
    const outbox = (await b.snapshot()).outbox;
    for (const peer of [b, c]) await peer.call("pull");
    for (const peer of [b, c]) {
      const frontier = heads(peer.dataDir);
      expect(frontier).toHaveLength(1);
      expect(frontier[0].value).toBe(main);
    }
    expect((await b.snapshot()).outbox).toBe(outbox);
  });

  it("applies the main head to the local store after upgrading an already consumed fork", async () => {
    const folder = temp();
    const a = pc(folder, "a", true, false, false, LOW);
    const c = pc(folder, "c", true, false, false, HIGH);
    await a.call("append", { text: "base" });
    await a.call("flush");
    await c.call("pull");
    await a.call("batch", { count: 20 });
    await a.call("flush");
    const main = (await a.snapshot()).leaf;
    await c.call("batch", { count: 4 });
    await c.call("flush");
    const before = await c.snapshot();
    await c.call("consumeForkByWriter");
    expect(heads(c.dataDir)[0].value).toBe(before.leaf);
    const db = new DatabaseSync(join(c.dataDir, "messages.db"), { readOnly: true });
    try {
      await c.call("restart");
      expect((await c.snapshot()).leaf).toBe(before.leaf);
      expect(heads(c.dataDir)).toHaveLength(2);
      await c.call("pull");
      const after = await c.snapshot();
      expect(tip(after)).toBe(main);
      expect(db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get("thread")?.active_leaf_id).toBe(after.leaf);
      expect(after.disk).toEqual(after.rows);
      expect(after.events.some((event) => event.type === "thread" && event.activeLeafId === main && event.importing)).toBe(true);
      expect(after.outbox).toBe(before.outbox + 1);
      expect(heads(c.dataDir).map((head) => head.value)).toEqual([main]);
      await c.call("restart");
      await c.call("poll");
      expect(tip(await c.snapshot())).toBe(main);
      expect((await c.snapshot()).outbox).toBe(after.outbox);
    } finally {
      db.close();
    }
  });

  it("resolves a later head fork after migrating a live chat with a stale v1 tombstone", async () => {
    const folder = temp();
    const dir = join(folder, "threads", "bot");
    mkdirSync(dir, { recursive: true });
    const base: Message = { id: "base", parentId: null, at: 1, role: "user", kind: "text", text: "base" };
    writeFileSync(join(dir, "thread.json"), JSON.stringify({ format: "orbit.thread-sync", version: 1, revision: 1, writerDeviceId: "old", updatedAt: 1,
      task: { threadId: "thread", title: "Chat", createdAt: 1 }, messages: [base], activeLeafId: base.id }));
    const tombstone = JSON.stringify({ syncedRevision: 1 });
    writeFileSync(join(dir, "thread.deleted.json"), tombstone);
    const a = pc(folder, "a", true, false, true, LOW);
    const c = pc(folder, "c", true, false, true, HIGH);
    for (const peer of [a, c]) {
      await peer.call("seed", { rows: [base], leaf: base.id });
      await peer.call("poll");
      await peer.call("flush");
      expect(migrationRow(peer.dataDir, "thread")).toEqual({ phase: "done", error: null, eligible: 1 });
    }
    await a.call("pull");
    await a.call("batch", { count: 20 });
    await a.call("flush");
    const main = (await a.snapshot()).leaf;
    await c.call("batch", { count: 4 });
    await c.call("flush");
    const before = await c.snapshot();
    const db = new DatabaseSync(join(c.dataDir, "messages.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT json_extract(json, '$.legacy') AS legacy FROM sync_v2_frontier WHERE kind = 'delete'").get()?.legacy).toBeTruthy();
      expect(db.prepare("SELECT deleted FROM sync_v2_store WHERE threadId = ?").get("thread")?.deleted).toBe(0);
      await c.call("pull");
      expect((await c.snapshot()).outbox).toBe(before.outbox + 1);
      expect(heads(c.dataDir).map((head) => head.value)).toEqual([main]);
    } finally {
      db.close();
    }
    await c.call("flush");
    await a.call("pull");
    for (const peer of [a, c]) {
      const after = await peer.snapshot();
      expect(tip(after)).toBe(main);
      expect(after.rows.filter(isConflictNotice)).toHaveLength(peer === c ? 1 : 0);
      expect(after.disk).toEqual(after.rows);
      await peer.call("restart");
      await peer.call("poll");
      expect(tip(await peer.snapshot())).toBe(main);
      expect((await peer.snapshot()).outbox).toBe(after.outbox);
    }
    expect(readFileSync(join(dir, "thread.deleted.json"), "utf8")).toBe(tombstone);
  });

  it("blocks head resolution for native deletion conflicts and effective deletions", async () => {
    const all = isolated([LOW, MID, HIGH]);
    const [a, b, c] = all;
    await a.peer.call("append", { text: "base" });
    await a.peer.call("flush");
    share(all, [a]);
    for (const item of [b, c]) await item.peer.call("pull");
    await b.peer.call("create");
    await b.peer.call("delete");
    await b.peer.call("flush");
    await a.peer.call("batch", { count: 20 });
    await a.peer.call("flush");
    await c.peer.call("batch", { count: 4 });
    await c.peer.call("flush");
    share([c], [a, b]);
    const before = await c.peer.snapshot();
    await c.peer.call("pull");
    expect((await c.peer.snapshot()).outbox).toBe(before.outbox);
    expect(heads(c.peer.dataDir)).toHaveLength(2);
    expect((await c.peer.snapshot()).tasks.some((task) => task.threadId === "thread")).toBe(true);
    const transport = new ThreadSyncV2({ folder: c.folder, dataDir: c.peer.dataDir, deviceId: "pc2", staged: true });
    try {
      const scope = { botSyncId: "bot", threadId: "thread" };
      expect((await transport.variants(scope, "delete")).some((item) => !item.version.legacy)).toBe(true);
      expect((await transport.state(scope)).deleted).toBe(false);
      await c.peer.call("create");
      await c.peer.call("delete");
      const deleted = await c.peer.snapshot();
      expect((await transport.state(scope)).deleted).toBe(true);
      await c.peer.call("poll");
      const after = await c.peer.snapshot();
      expect(after.outbox).toBe(deleted.outbox);
      expect(after.tasks.some((task) => task.threadId === "thread")).toBe(false);
      expect(after.disk).toEqual([]);
      expect(heads(c.peer.dataDir)).toHaveLength(2);
    } finally {
      await transport.close();
    }
  });

  for (const count of [2, 3]) {
    it(`folds equal heads from ${count} PCs that resolve at once into one head with one more write`, async () => {
      const all = isolated([LOW, MID, HIGH]);
      const [a, , c] = all;
      const resolvers = count === 2 ? [a, c] : all;
      await a.peer.call("append", { text: "base" });
      await a.peer.call("flush");
      share(all, [a]);
      for (const item of all.slice(1)) await item.peer.call("pull");
      await a.peer.call("batch", { count: 2 });
      await a.peer.call("flush");
      const main = (await a.peer.snapshot()).leaf;
      await c.peer.call("append", { text: "row 0", at: 1 });
      await c.peer.call("flush");
      share(resolvers, [a, c]);
      const start = await Promise.all(all.map((item) => item.peer.snapshot()));
      for (const item of resolvers) await item.peer.call("pull");
      for (const item of resolvers) await item.peer.call("flush");
      for (let round = 0; round < 2; round++) {
        share(all, all);
        for (const item of all) await item.peer.call("pull");
        for (const item of all) await item.peer.call("flush");
      }
      share(all, all);
      for (const item of all) await item.peer.call("pull");
      const settled = await Promise.all(all.map((item) => item.peer.snapshot()));
      for (let round = 0; round < 3; round++) {
        for (const item of all) {
          await item.peer.call("poll");
          await item.peer.call("flush");
        }
        share(all, all);
      }
      const after = await Promise.all(all.map((item) => item.peer.snapshot()));
      expect(after.map((snapshot) => snapshot.outbox)).toEqual(settled.map((snapshot) => snapshot.outbox));
      expect(settled.reduce((sum, snapshot, i) => sum + snapshot.outbox - start[i].outbox, 0)).toBe(count + 1);
      for (const [i, item] of all.entries()) {
        expect(tip(after[i])).toBe(main);
        expect(after[i].rows.filter(isConflictNotice)).toHaveLength(item === c ? 1 : 0);
        expect(heads(item.peer.dataDir).map((head) => head.value)).toEqual([main]);
      }
    });
  }

  it("keeps a version picked after both branches when another PC's resolving head arrives late", async () => {
    const all = isolated([LOW, HIGH, MID]);
    const [a, c] = all;
    await a.peer.call("append", { text: "base" });
    await a.peer.call("flush");
    share([c], [a]);
    await c.peer.call("pull");
    await a.peer.call("batch", { count: 2 });
    await a.peer.call("flush");
    const side = await c.peer.call<Message>("append", { text: "side" });
    await c.peer.call("flush");
    share([a, c], [a, c]);
    await a.peer.call("pull");
    await c.peer.call("pull");
    expect(await a.peer.call("head", { id: side.id })).toBe(side.id);
    await c.peer.call("flush");
    share([a], [c]);
    await a.peer.call("pull");
    expect((await a.peer.snapshot()).leaf).toBe(side.id);
    for (let round = 0; round < 3; round++) {
      for (const item of all) {
        await item.peer.call("poll");
        await item.peer.call("flush");
      }
      share(all, all);
    }
    for (const item of all) {
      const snapshot = await item.peer.snapshot();
      expect(snapshot.leaf).toBe(side.id);
      expect(snapshot.rows.filter(isConflictNotice)).toHaveLength(0);
      expect(heads(item.peer.dataDir).map((head) => head.value)).toEqual([side.id]);
    }
  });

  it("keeps a version picked after every resolving head and still follows newer typing deeper first", async () => {
    const folder = temp();
    const a = pc(folder, "a", true, false, false, LOW);
    const c = pc(folder, "c", true, false, false, HIGH);
    await a.call("append", { text: "base" });
    await a.call("flush");
    await c.call("pull");
    await a.call("batch", { count: 20 });
    await a.call("flush");
    const main = (await a.snapshot()).leaf!;
    const side = await c.call<Message>("append", { text: "side", at: 1 });
    await c.call("flush");
    for (let round = 0; round < 2; round++) {
      for (const peer of [a, c]) await peer.call("pull");
      for (const peer of [a, c]) await peer.call("flush");
    }
    expect(heads(a.dataDir).map((head) => head.value)).toEqual([main]);
    await a.call("head", { id: side.id });
    await a.call("flush");
    await c.call("pull");
    expect((await c.snapshot()).leaf).toBe(side.id);
    const reply = await c.call<Message>("append", { text: "on the picked branch" });
    await c.call("flush");
    await a.call("pull");
    expect((await a.snapshot()).leaf).toBe(reply.id);
    await a.call("head", { id: main });
    const longer = await a.call<Message>("append", { text: "longer branch" });
    const shorter = await c.call<Message>("append", { text: "shorter branch" });
    for (const peer of [a, c]) await peer.call("flush");
    for (let round = 0; round < 2; round++) {
      for (const peer of [a, c]) await peer.call("pull");
      for (const peer of [a, c]) await peer.call("flush");
    }
    for (const peer of [a, c]) {
      const snapshot = await peer.snapshot();
      expect(snapshot.leaf).toBe(longer.id);
      expect(snapshot.rows.some((row) => row.id === shorter.id)).toBe(true);
    }
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
    await vi.waitFor(async () => {
      await b.call("pull");
      expect((await b.snapshot()).rows[0]?.text).toBe("latest");
    }, { timeout: 15_000, interval: 250 });
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
    expect((await b.snapshot()).rows.some(isConflictNotice)).toBe(true);
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

  it("syncs a repaired compaction row and head like any message row", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const covered = await a.call<Message>("append", { text: "old work" });
    const kept = await a.call<Message>("append", { text: "recent work" });
    const row = {
      v: 1 as const,
      coveredThroughId: covered.id,
      firstKeptId: kept.id,
      contextWindow: 200_000,
      estimatedTokensBefore: 900,
      sourceMessageCount: 1,
    };
    const fallback = await a.call<Message>("compaction", {
      compaction: { ...row, summary: "Model summary unavailable; full transcript retained by Wink.\ndigest" },
    });
    await a.call("flush");
    await b.call("pull");
    const repaired = await a.call<Message>("compaction", { compaction: { ...row, summary: "repaired summary" } });
    await a.call("flush");
    await b.call("pull");

    const state = await b.snapshot();
    expect(state.leaf).toBe(repaired.id);
    expect(state.rows.find((message) => message.id === repaired.id)).toMatchObject({
      kind: "compaction",
      parentId: fallback.id,
      compaction: { ...row, summary: "repaired summary" },
    });
    expect(state.rows.find((message) => message.id === fallback.id)?.compaction).toMatchObject({ summary: expect.stringContaining("digest") });
    expect(state.rows.some(isConflictNotice)).toBe(false);
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

  it("replaces a dead sync worker on the next flush and pull", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const first = await a.call<Message>("append", { text: "before" });
    expect(await a.call("flush")).toBe("written");
    await b.call("pull");
    expect((await b.snapshot()).rows).toMatchObject([{ id: first.id, text: "before" }]);
    await a.call("dropWorker");
    await b.call("dropWorker");
    const second = await a.call<Message>("append", { text: "after" });
    expect(await a.call("flush")).toBe("written");
    await b.call("pull");
    expect((await b.snapshot()).rows).toEqual([
      expect.objectContaining({ id: first.id, text: "before" }),
      expect.objectContaining({ id: second.id, text: "after" }),
    ]);
  });

  it("pulls another chat while a snapshot stays errored", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const remote = await a.call<Message>("append", { text: "remote" });
    expect(await a.call("flush")).toBe("written");
    await b.call("plant", { threadId: "stuck" });
    await b.call("poll");
    expect((await b.snapshot()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: remote.id, text: "remote" }),
    ]));
    expect(migrationRow(b.dataDir, "stuck")).toMatchObject({ phase: "snapshot", eligible: 0, error: expect.any(String) });
    const later = await a.call<Message>("append", { text: "later" });
    expect(await a.call("flush")).toBe("written");
    await b.call("poll");
    expect((await b.snapshot()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: remote.id, text: "remote" }),
      expect.objectContaining({ id: later.id, text: "later" }),
    ]));
    expect(migrationRow(b.dataDir, "stuck")).toMatchObject({ phase: "snapshot", eligible: 0, error: expect.any(String) });
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

  it("rejects a pending call when the worker exits", async () => {
    const [{ peer }] = isolated([LOW]);
    const pending = peer.call("snapshot");
    await peer.worker.terminate();
    await expect(pending).rejects.toThrow(/worker exited/);
    await expect(peer.call("snapshot")).rejects.toThrow(/worker exited/);
  });
});
