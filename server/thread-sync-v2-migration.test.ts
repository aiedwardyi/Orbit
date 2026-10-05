import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { Message } from "./store.ts";
import type { MigrationArgs } from "./testing/thread-sync-v2-migration-pc.ts";
import type { MigrationCrash, MigrationProgress } from "./thread-sync-v2-migration.ts";
import type { SyncApplyResult, SyncFlushResult, SyncState, SyncVersion } from "./thread-sync-v2.ts";

const roots: string[] = [];
const clients: Array<{ close(): Promise<void> }> = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "sync-v2-migration-")); roots.push(dir); return dir; };
const row = (id: string, text = id): Message => ({ id, text, role: "user", kind: "text", at: 1, parentId: null });
interface Snapshot { rows: Message[]; snapshot: Message[]; variants: SyncVersion[]; state: SyncState; progress: MigrationProgress }
type Reply = Snapshot | MigrationProgress | SyncFlushResult | SyncApplyResult | undefined;

function pc(folder: string, deviceId: string, dataDir = temp()) {
  const worker = new Worker(new URL("./testing/thread-sync-v2-migration-pc.ts", import.meta.url), {
    workerData: { folder, deviceId, dataDir }, env: { ...process.env, OMB_DATA_DIR: dataDir }, execArgv: ["--experimental-strip-types"],
  });
  let sequence = 0;
  let dead = false;
  const pending = new Map<number, { resolve(value: Reply): void; reject(error: Error): void }>();
  worker.on("message", ({ id, value, error }: { id: number; value: Reply; error?: string }) => {
    const request = pending.get(id);
    pending.delete(id);
    if (error) request?.reject(new Error(String(error)));
    else request?.resolve(value);
  });
  const exited = new Promise<void>((resolve) => worker.on("exit", (code) => {
    dead = true;
    for (const request of pending.values()) request.reject(new Error(`Worker exited (${code})`));
    pending.clear();
    resolve();
  }));
  worker.on("error", (error) => { for (const request of pending.values()) request.reject(new Error(String(error))); });
  const call = <T extends Reply,>(method: string, args: MigrationArgs = {}): Promise<T> => new Promise((resolve, reject) => {
    const id = ++sequence;
    // SAFETY: Fixture callers pair each method with its declared response type.
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    worker.postMessage({ id, method, args });
  });
  const client = { call, dataDir, async close() { if (!dead) await call("close"); await exited; } };
  clients.push(client);
  return client;
}

function legacy(folder: string, name: string, rows: Message[], stamped = false) {
  const dir = join(folder, "threads", "bot");
  mkdirSync(dir, { recursive: true });
  const file = { format: "orbit.thread-sync", version: 1, revision: 1, writerDeviceId: "old", updatedAt: 1,
    task: { threadId: "thread", title: "Chat", createdAt: 1 }, activeLeafId: rows.at(-1)?.id ?? null, messages: rows };
  writeFileSync(join(dir, name), JSON.stringify(stamped ? { ...file, stamps: Object.fromEntries(rows.map((item) => [item.id, "1:old"])) } : file));
}

function hashes(folder: string) {
  const dir = join(folder, "threads", "bot");
  return readdirSync(dir).sort().map((name) => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]);
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy migration", () => {
  it("recovers prestamp, conflicts, tombstones and a late laptop without rewriting v1", async () => {
    const folder = temp();
    legacy(folder, "thread.json", [row("m", "main"), row("old")]);
    legacy(folder, "thread.conflict-old.json", [row("m", "conflict"), row("parked")], true);
    writeFileSync(join(folder, "threads", "bot", "thread.deleted.json"), JSON.stringify({ syncedRevision: 1 }));
    const before = hashes(folder);
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    const c = pc(folder, "c");
    for (const [peer, id] of [[a, "a"], [b, "b"], [c, "c"]] as const) {
      await peer.call("seed", { rows: [row("m", "local"), row(id)], leaf: id });
      await peer.call("begin");
    }
    await a.call("run");
    const first = await a.call<SyncFlushResult>("flush");
    await b.call("run");
    await b.call("flush");
    await a.call("pull");
    await c.call("run");
    await c.call("flush");
    for (const peer of [a, b, c]) {
      await peer.call("pull");
      const after = await peer.call<Snapshot>("snapshot");
      expect(after.rows.map((item) => item.id).sort()).toEqual(["a", "b", "c", "m", "old", "parked"]);
      expect(after.variants.filter((item) => item.rowId === "m").map((item) => z.object({ text: z.string() }).parse(item.value).text).sort()).toEqual(["conflict", "local", "main"]);
      expect(after.state.deleted).toBe(false);
      expect(after.progress.phase).toBe("done");
    }
    expect(first.bytesWritten).toBeGreaterThan(0);
    expect(hashes(folder)).toEqual(before);
  });

  it("publishes no duplicate history from a matching second PC", async () => {
    const folder = temp();
    const rows = Array.from({ length: 260 }, (_, i) => row(`m${i}`));
    legacy(folder, "thread.json", rows);
    const a = pc(folder, "a");
    const b = pc(folder, "b");
    for (const peer of [a, b]) { await peer.call("seed", { rows, leaf: "m259" }); await peer.call("begin"); }
    await a.call("run");
    const first = await a.call<SyncFlushResult>("flush");
    await b.call("run");
    const second = await b.call<SyncFlushResult>("flush");
    expect((await b.call<Snapshot>("snapshot")).state.outbox).toBe(0);
    expect(second.bytesWritten).toBeLessThan(first.bytesWritten / 100);
  });

  it("retains preimages and messages written between snapshot batches", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    await a.call("seed", { rows: Array.from({ length: 260 }, (_, i) => row(`m${i}`)) });
    await a.call("begin");
    await a.call("step");
    await a.call("commit", { mutations: [{ kind: "row", value: row("m200", "edited") }, { kind: "row", value: row("new") }] });
    await a.call("run");
    const state = await a.call<Snapshot>("snapshot");
    expect(state.rows).toHaveLength(261);
    expect(state.rows.find((item) => item.id === "m200")?.text).toBe("edited");
    expect(state.snapshot.find((item) => item.id === "m200")?.text).toBe("m200");
    expect(state.variants.filter((item) => item.rowId === "m200")).toHaveLength(2);
  });

  it("leaves unavailable sources pending and does not bridge later v1 files", async () => {
    const folder = temp();
    legacy(folder, "thread.json", [row("remote")]);
    const path = join(folder, "threads", "bot", "thread.json");
    const bytes = readFileSync(path);
    const a = pc(folder, "a");
    await a.call("begin");
    await a.call("step");
    writeFileSync(path, "{truncated");
    const pending = await a.call<MigrationProgress>("step");
    expect(pending.phase).toBe("legacy");
    expect(pending.error).toBeTruthy();
    expect(pending.pending).toBe(1);
    writeFileSync(path, bytes);
    await a.call("run");
    legacy(folder, "thread.conflict-late.json", [row("late")]);
    await a.call("run");
    expect((await a.call<Snapshot>("snapshot")).rows.map((item) => item.id)).toEqual(["remote"]);
  });

  it("streams lazy local JSON and retains local file ownership and stamps", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    writeFileSync(join(a.dataDir, "messages-thread.json"), JSON.stringify([row("local", "한글 \\\"".repeat(20_000))]));
    mkdirSync(join(a.dataDir, "thread-sync-rows"));
    writeFileSync(join(a.dataDir, "thread-sync-rows", "thread.json"), JSON.stringify({ stamps: { local: "7:editor" }, origins: { local: "owner" } }));
    await a.call("begin");
    await a.call("run");
    const state = await a.call<Snapshot>("snapshot");
    expect(state.rows).toHaveLength(1);
    expect(state.variants.find((item) => item.kind === "row")).toMatchObject({ origin: "owner", legacy: { stamp: "7:editor" }, seen: {}, baseStamp: null });
    expect(readFileSync(join(a.dataDir, "messages-thread.json"), "utf8")).toContain("한글");
  });

  it.each<MigrationCrash>(["snapshot", "source", "pull", "outbox", "complete"])("resumes after a crash at %s", async (crash) => {
    const folder = temp();
    legacy(folder, "thread.json", [row("remote")]);
    const before = hashes(folder);
    const a = pc(folder, "a");
    await a.call("seed", { rows: [row("local")] });
    await a.call("begin");
    let died = false;
    for (let i = 0; i < 30 && !died; i++) {
      try { await a.call("step", { crash }); }
      catch (error) { expect(String(error)).toContain("92"); died = true; }
    }
    expect(died).toBe(true);
    const resumed = pc(folder, "a", a.dataDir);
    await resumed.call("run");
    const state = await resumed.call<Snapshot>("snapshot");
    expect(state.rows.map((item) => item.id).sort()).toEqual(["local", "remote"]);
    expect(state.variants.filter((item) => item.kind === "row")).toHaveLength(2);
    expect(hashes(folder)).toEqual(before);
  });
});
