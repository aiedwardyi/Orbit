import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { ThreadSyncV2, type SealCrash, type SyncHead, type SyncOptions } from "./thread-sync-v2.ts";

const roots: string[] = [];
const clients: ThreadSyncV2[] = [];
const scope = { botSyncId: "bot", threadId: "thread" };
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", at: 1, text, parentId: null, ...extra });

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "sync-v2-"));
  roots.push(root);
  return root;
}

function pc(folder: string, deviceId: string, headBytes = 4096, dataDir = temp()) {
  const options: SyncOptions = { folder, dataDir, deviceId, headBytes };
  const client = new ThreadSyncV2(options);
  clients.push(client);
  return { client, options };
}

async function writerDir(client: ThreadSyncV2, folder: string): Promise<string> {
  return join(folder, "threads-v2", scope.botSyncId, scope.threadId, (await client.state(scope)).writerId);
}

async function put(client: ThreadSyncV2, id: string, text: string, extra: Partial<Message> = {}) {
  return client.commit(scope, [{ kind: "row", value: msg(id, text, extra) }]);
}

async function rows(client: ThreadSyncV2): Promise<Message[]> {
  return (await client.scan(scope.threadId)).messages;
}

async function converge(...peers: ThreadSyncV2[]): Promise<void> {
  for (const peer of peers) await peer.flush(scope);
  for (const peer of peers) await peer.pull(scope);
}

describe("thread sync v2", () => {
  it("deduplicates equal recovery versions published concurrently", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    const recovery = { kind: "row" as const, value: msg("m", "same"), legacy: { sourceHash: "b".repeat(64) } };
    await a.recover(scope, [recovery]);
    await b.recover(scope, [recovery]);
    await converge(a, b);
    for (const peer of [a, b]) {
      expect(await peer.variants(scope, "row", "m")).toHaveLength(1);
      expect(await rows(peer)).toHaveLength(1);
    }
  });

  it("recovers unknown legacy variants without overwriting v2 rows or heads", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    await put(a, "m", "native");
    await a.commit(scope, [{ kind: "head", value: "m" }]);
    await converge(a, b);
    const legacy = { sourceHash: "a".repeat(64), stamp: "1:old" };
    await b.recover(scope, [
      { kind: "row", value: msg("m", "old"), legacy },
      { kind: "row", value: msg("offline", "unseen"), legacy },
      { kind: "head", value: "offline", legacy },
      { kind: "delete", value: { deletedAt: 1 }, legacy },
    ]);
    await converge(a, b);
    for (const peer of [a, b]) {
      expect((await rows(peer)).map((row) => row.text).sort()).toEqual(["native", "unseen"]);
      expect((await peer.scan("thread")).messages).toHaveLength(2);
      const variants = await peer.variants(scope, "row", "m");
      expect(variants).toHaveLength(2);
      expect(variants.find((item) => item.version.legacy)?.version).toMatchObject({ seen: {}, baseStamp: null, legacy });
      expect((await peer.variants(scope, "head"))[0].version.value).toBe("m");
      expect((await peer.state(scope)).deleted).toBe(false);
    }
    const before = (await b.state(scope)).outbox;
    await b.recover(scope, [{ kind: "row", value: { text: "native", ...msg("m", "native") }, legacy }]);
    expect((await b.state(scope)).outbox).toBe(before);
  });

  it("keeps concurrent edits on three independent PCs and resolves only with captured ancestry", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    const c = pc(folder, "c").client;
    await put(a, "m", "base");
    await converge(a, b, c);
    await put(a, "m", "a edit");
    await put(b, "m", "b edit");
    await put(c, "m", "offline c");
    await converge(a, b);
    expect(await a.variants(scope, "row", "m")).toHaveLength(2);
    await converge(c, a, b);
    for (const peer of [a, b, c]) {
      expect((await peer.variants(scope, "row", "m")).map((item) => item.version.value)).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: "a edit" }), expect.objectContaining({ text: "b edit" }), expect.objectContaining({ text: "offline c" }),
      ]));
      expect(await rows(peer)).toEqual(await rows(a));
    }
    await put(b, "m", "resolved");
    await converge(b, a, c);
    for (const peer of [a, b, c]) expect(await peer.variants(scope, "row", "m")).toMatchObject([{ version: { value: { text: "resolved" } } }]);
  });

  it("does not lend a later head's ancestry to an older row version", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    const c = pc(folder, "c").client;
    await put(a, "m", "a offline");
    await put(b, "m", "b offline");
    await a.flush(scope);
    await b.pull(scope);
    await put(b, "other", "after seeing a");
    await b.flush(scope);
    await c.pull(scope);
    expect(await c.variants(scope, "row", "m")).toHaveLength(2);
    expect(await c.variants(scope, "row", "other")).toHaveLength(1);
  });

  it("retains metadata, parents and competing branch heads", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    const c = pc(folder, "c").client;
    for (const [peer, id] of [[a, "a"], [b, "b"], [c, "c"]] as const) {
      await peer.commit(scope, [
        { kind: "row", value: msg(id, id, { parentId: "root" }) },
        { kind: "metadata", value: { title: id, createdAt: 1 } },
        { kind: "head", value: id },
      ]);
    }
    await converge(a, b, c);
    for (const peer of [a, b, c]) {
      expect(await peer.variants(scope, "metadata")).toHaveLength(3);
      expect(await peer.variants(scope, "head")).toHaveLength(3);
      expect((await rows(peer)).map((row) => row.parentId)).toEqual(["root", "root", "root"]);
      expect((await peer.changes(scope)).some((change) => change.conflict)).toBe(true);
    }
  });

  it("keeps a reaction-only row's file owner when a third PC imports it", async () => {
    const folder = temp();
    const a = pc(folder, "files-a").client;
    const b = pc(folder, "react-b").client;
    const c = pc(folder, "read-c").client;
    await put(a, "m", "image", { image: "picture.png" });
    await converge(a, b);
    const row = (await rows(b))[0];
    await b.commit(scope, [{ kind: "row", value: { ...row, reactions: [{ emoji: "heart", by: "user" }] } }]);
    await converge(b, c);
    expect(await c.variants(scope, "row", "m")).toMatchObject([{ version: { origin: "files-a", value: { reactions: [{ emoji: "heart", by: "user" }] } } }]);
  });

  it("retains last-good rows across stale, torn and same-stat rewritten heads", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    await put(a, "m", "old");
    await converge(a, b);
    const path = join(await writerDir(a, folder), "head.json");
    const old = readFileSync(path);
    await put(a, "m", "new");
    await converge(a, b);
    const good = readFileSync(path);
    writeFileSync(path, old);
    expect((await b.pull(scope)).rejected).toBe(1);
    expect((await rows(b))[0].text).toBe("new");
    writeFileSync(path, "{\"v\":2,");
    expect((await b.pull(scope)).rejected).toBe(1);
    expect((await rows(b))[0].text).toBe("new");
    await a.flush(scope);
    expect(readFileSync(path)).toEqual(good);
    const stat = statSync(path);
    writeFileSync(path, good.toString().replace('"new"', '"bad"'));
    utimesSync(path, stat.atime, stat.mtime);
    expect((await b.pull(scope)).quarantined).toBe(1);
    expect((await rows(b))[0].text).toBe("new");
  });

  it("waits for delayed segments and applies duplicates only once", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    const c = pc(folder, "c").client;
    for (let i = 0; i < 20; i++) await put(a, `m${i}`, "x".repeat(600));
    const flush = await a.flush(scope);
    expect(flush.headBytes).toBeLessThanOrEqual(4096);
    expect(flush.segments).toBeGreaterThan(0);
    const dir = await writerDir(a, folder);
    const segments = readdirSync(dir).filter((name) => name.startsWith("seg-"));
    const hidden = temp();
    for (const name of segments) renameSync(join(dir, name), join(hidden, name));
    await b.pull(scope);
    await c.pull(scope);
    expect((await b.state(scope)).seen).toEqual({});
    expect(await rows(b)).toEqual([]);
    for (const name of segments.reverse()) {
      renameSync(join(hidden, name), join(dir, name));
      await b.pull(scope);
    }
    await c.pull(scope);
    expect(await rows(b)).toHaveLength(20);
    expect(await rows(c)).toHaveLength(20);
    expect(await b.pull(scope)).toMatchObject({ rowsTouched: 0, sqlRowsTouched: 0, applied: 0 });
  });

  it("quarantines contradictory sequence bytes without replacing an applied value", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    await put(a, "m", "good");
    await converge(a, b);
    const path = join(await writerDir(a, folder), "head.json");
    const head: SyncHead = JSON.parse(readFileSync(path, "utf8"));
    head.generation++;
    head.versions[0].value = msg("m", "bad");
    writeFileSync(path, JSON.stringify(head));
    expect((await b.pull(scope)).quarantined).toBe(1);
    expect((await rows(b))[0].text).toBe("good");
    expect((await b.pull(scope)).quarantined).toBe(0);
    expect((await b.state(scope)).quarantined).toBe(1);
  });

  it("preserves delete/edit races and late offline rows", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    const c = pc(folder, "c").client;
    await put(a, "base", "base");
    await converge(a, b, c);
    await a.commit(scope, [{ kind: "delete", value: { deletedAt: 2 } }]);
    await put(b, "base", "edited offline");
    await put(c, "late", "late offline", { parentId: "base" });
    await converge(a, b, c);
    for (const peer of [a, b, c]) {
      expect(await peer.state(scope)).toMatchObject({ deleted: false, deleteConflicts: 2 });
      expect((await rows(peer)).map((row) => row.text).sort()).toEqual(["edited offline", "late offline"]);
      expect(await peer.variants(scope, "delete")).toHaveLength(1);
      expect((await peer.changes(scope)).some((change) => change.conflict)).toBe(true);
    }
    await c.commit(scope, [{ kind: "delete", value: { deletedAt: 3 } }]);
    await converge(c, a, b);
    for (const peer of [a, b, c]) expect(await peer.state(scope)).toMatchObject({ deleted: true, deleteConflicts: 0 });
    expect(await rows(a)).toHaveLength(2);
  });

  it("keeps undated versions concurrent even when their sequence numbers differ", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    const c = pc(folder, "c").client;
    for (let i = 0; i < 8; i++) await put(a, `other${i}`, "unrelated");
    await put(a, "m", "high sequence");
    await put(b, "m", "low sequence");
    await converge(a, b, c);
    for (const peer of [a, b, c]) expect(await peer.variants(scope, "row", "m")).toHaveLength(2);
  });

  it("buffers missing causal dependencies instead of claiming they were applied", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    const c = pc(folder, "c").client;
    await put(a, "base", "base");
    await converge(a, b);
    await put(b, "reply", "reply", { parentId: "base" });
    await b.flush(scope);
    const dir = await writerDir(a, folder);
    const hidden = join(temp(), "head.json");
    renameSync(join(dir, "head.json"), hidden);
    await c.pull(scope);
    expect(await rows(c)).toEqual([]);
    expect((await c.state(scope)).seen).toEqual({});
    renameSync(hidden, join(dir, "head.json"));
    await c.pull(scope);
    expect((await rows(c)).map((row) => row.id)).toEqual(["base", "reply"]);
  });

  it("rolls back every version when a later mutation in the batch fails validation", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    await expect(a.commit(scope, [
      { kind: "row", value: msg("valid", "valid") },
      { kind: "row", value: msg("", "invalid") },
    ])).rejects.toThrow();
    expect(await rows(a)).toEqual([]);
    expect(await a.state(scope)).toMatchObject({ outbox: 0, seen: {} });
    await put(a, "first", "first");
    expect(await a.variants(scope, "row", "first")).toMatchObject([{ version: { seq: 1 } }]);
  });

  it("changes file owner for content edits but keeps it for reordered reaction edits", async () => {
    const folder = temp();
    const a = pc(folder, "files.a").client;
    const b = pc(folder, "files.b").client;
    const c = pc(folder, "files.c").client;
    await put(a, "m", "image", { image: "first.png" });
    await converge(a, b);
    const original = (await rows(b))[0];
    const { text, ...rest } = original;
    await b.commit(scope, [{ kind: "row", value: { text, ...rest, reactions: [{ emoji: "heart", by: "user" }] } }]);
    await converge(b, c);
    expect(await c.variants(scope, "row", "m")).toMatchObject([{ version: { origin: "files.a" } }]);
    await put(b, "m", "replaced", { image: "second.png" });
    await converge(b, c);
    expect(await c.variants(scope, "row", "m")).toMatchObject([{ version: { origin: "files.b" } }]);
  });

  it("does not overwrite conflicting immutable segment bytes on crash recovery", async () => {
    const folder = temp();
    const first = pc(folder, "a");
    const dir = await writerDir(first.client, folder);
    for (let i = 0; i < 12; i++) await put(first.client, `m${i}`, "good".repeat(200));
    await expect(first.client.flush(scope, "after-publish")).rejects.toThrow("exited (91)");
    const segment = readdirSync(dir).find((name) => name.startsWith("seg-"))!;
    const path = join(dir, segment);
    const original = readFileSync(path);
    const altered = gzipSync(gunzipSync(original).toString().replace("good", "evil"));
    writeFileSync(path, altered);
    const a = pc(folder, "a", 4096, first.options.dataDir).client;
    await expect(a.flush(scope)).rejects.toThrow("Immutable segment changed");
    expect(readFileSync(path)).toEqual(altered);
    expect(await a.state(scope)).toMatchObject({ quarantined: 1, outbox: 12 });
    expect(await rows(a)).toHaveLength(12);
    writeFileSync(path, original);
    await a.flush(scope);
    const b = pc(folder, "b").client;
    await b.pull(scope);
    expect(await rows(b)).toHaveLength(12);
  });

  it.each<SealCrash>(["before-publish", "after-publish", "after-journal", "after-trim"])("recovers a worker crash %s", async (crash) => {
    const folder = temp();
    const first = pc(folder, "a");
    const b = pc(folder, "b").client;
    const c = pc(folder, "c").client;
    await put(first.client, "first", "first");
    await converge(first.client, b, c);
    const identity = (await first.client.state(scope)).writerId;
    for (let i = 0; i < 12; i++) await put(first.client, `m${i}`, "x".repeat(700));
    await expect(first.client.flush(scope, crash)).rejects.toThrow("exited (91)");
    await b.pull(scope);
    const a = pc(folder, "a", 4096, first.options.dataDir).client;
    expect((await a.state(scope)).writerId).toBe(identity);
    await converge(a, b, c);
    expect(await rows(b)).toHaveLength(13);
    expect(await rows(c)).toHaveLength(13);
    expect((await b.pull(scope)).applied).toBe(0);
  });

  it.each(["before-commit", "after-commit"] as const)("keeps row writes atomic with the outbox across %s", async (crash) => {
    const folder = temp();
    const first = pc(folder, "a");
    await put(first.client, "base", "base");
    await expect(first.client.commit(scope, [{ kind: "row", value: msg("new", "new") }], crash)).rejects.toThrow("exited (91)");
    const a = pc(folder, "a", 4096, first.options.dataDir).client;
    const b = pc(folder, "b").client;
    await converge(a, b);
    expect(await rows(a)).toHaveLength(crash === "before-commit" ? 1 : 2);
    expect(await rows(b)).toEqual(await rows(a));
    expect((await a.state(scope)).outbox).toBe(crash === "before-commit" ? 1 : 2);
  });

  it("fragments oversized versions without exposing a partial row", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    const c = pc(folder, "c").client;
    const text = "한글🙂".repeat(3000);
    await put(a, "large", text);
    const flushed = await a.flush(scope);
    expect(flushed.headBytes).toBeLessThanOrEqual(4096);
    const dir = await writerDir(a, folder);
    const head = readFileSync(join(dir, "head.json"));
    writeFileSync(join(dir, "head.json"), "torn");
    await b.pull(scope);
    expect(await rows(b)).toEqual([]);
    for (const name of readdirSync(dir).filter((name) => name.startsWith("seg-"))) {
      expect(gunzipSync(readFileSync(join(dir, name))).length).toBeLessThanOrEqual(4096);
    }
    writeFileSync(join(dir, "head.json"), head);
    await b.pull(scope);
    await c.pull(scope);
    expect((await rows(b))[0].text).toBe(text);
    expect((await rows(c))[0].text).toBe(text);
  });

  it("reopens applied progress and cached immutable segments without import echo", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const first = pc(folder, "b");
    for (let i = 0; i < 12; i++) await put(a, `m${i}`, "x".repeat(500));
    await converge(a, first.client);
    await first.client.close();
    const b = pc(folder, "b", 4096, first.options.dataDir).client;
    expect((await b.pull(scope)).applied).toBe(0);
    expect((await b.state(scope)).outbox).toBe(0);
    expect(await rows(b)).toHaveLength(12);
    const dir = await writerDir(a, folder);
    const segment = readdirSync(dir).find((name) => name.startsWith("seg-"))!;
    writeFileSync(join(dir, segment), "unavailable after first read");
    expect((await b.pull(scope)).rejected).toBe(0);
  });

  it("rejects concurrent ownership and path traversal", async () => {
    const folder = temp();
    const a = pc(folder, "a");
    await a.client.state(scope);
    const duplicate = pc(folder, "a", 4096, a.options.dataDir).client;
    await expect(duplicate.state(scope)).rejects.toThrow("locked");
    await expect(a.client.flush({ ...scope, threadId: "../escape" })).rejects.toThrow();
    await expect(a.client.flush({ ...scope, botSyncId: "other" })).rejects.toThrow("another sync bot");
  });

  it("retries torn segments without advancing through their missing range", async () => {
    const folder = temp();
    const a = pc(folder, "a").client;
    const b = pc(folder, "b").client;
    for (let i = 0; i < 10; i++) await put(a, `m${i}`, "x".repeat(700));
    await a.flush(scope);
    const dir = await writerDir(a, folder);
    const segment = readdirSync(dir).find((name) => name.startsWith("seg-1-"))!;
    const bytes = readFileSync(join(dir, segment));
    writeFileSync(join(dir, segment), bytes.subarray(0, 10));
    await b.pull(scope);
    expect(await rows(b)).toEqual([]);
    writeFileSync(join(dir, segment), bytes);
    await b.pull(scope);
    expect(await rows(b)).toHaveLength(10);
  });

  it("rejects mismatched segment identities and impossible causal bases", async () => {
    const folder = temp();
    const b = pc(folder, "b").client;
    const dir = join(folder, "threads-v2", "bot", "thread", "foreign");
    mkdirSync(dir, { recursive: true });
    const head: SyncHead = {
      v: 2, threadId: "thread", writerId: "foreign", generation: 1, sealedThrough: 0, firstSeq: 1, lastSeq: 1, seen: {},
      versions: [{ seq: 1, seen: {}, baseStamp: "5:other", kind: "row", rowId: "m", value: msg("m", "bad"), origin: "foreign" }],
    };
    writeFileSync(join(dir, "head.json"), JSON.stringify(head));
    writeFileSync(join(dir, "seg-2-3.json.gz"), gzipSync(JSON.stringify(head)));
    expect((await b.pull(scope)).rejected).toBe(2);
    expect(await rows(b)).toEqual([]);
  });
});
