import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createDriveClient } from "./drive-client.ts";
import { createDriveMirror, decodeDrivePath, drivePathHash, drivePathRule, encodeDrivePath, renameDriveFile, DriveMirrorError, type DriveOwner } from "./drive-mirror.ts";
import { DriveIdentityError, readDriveOwnIds, type DriveOwnIds } from "./drive-own-ids.ts";
import { FakeDrive } from "./testing/fake-drive.ts";

const OWNER: DriveOwner = { issuer: "https://accounts.google.com", sub: "account-a" };
interface PC { folder: string; statePath: string; ids: DriveOwnIds; mirror: ReturnType<typeof createDriveMirror> }
let root: string;
let drive: FakeDrive;
let pcs: PC[];

function mirrorFor(pc: Omit<PC, "mirror">, options: Partial<Parameters<typeof createDriveMirror>[0]> = {}) {
  return createDriveMirror({ owner: OWNER, mirrorPath: pc.folder, statePath: pc.statePath, ownIds: pc.ids,
    client: createDriveClient({ getAccessToken: async () => "test-access", fetch: drive.fetch }), now: () => 100, ...options });
}

function write(pc: PC, path: string, bytes: string | Buffer): void {
  const target = join(pc.folder, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

const read = (pc: PC, path: string) => readFileSync(join(pc.folder, ...path.split("/")), "utf8");
const seed = (path: string, text: string | Buffer) => drive.add(encodeDrivePath(path), { ph: drivePathHash(path) }, Buffer.from(text), [drive.root().id]);
const table = (pc: PC) => z.object({
  version: z.literal(1), binding: z.object({ owner: z.object({ issuer: z.string(), sub: z.string() }), rootId: z.string().nullable(), mirrorPath: z.string(), generation: z.number() }),
  files: z.record(z.string(), z.object({ driveId: z.string(), md5: z.string(), size: z.string() })), syncedAt: z.number(),
}).parse(JSON.parse(readFileSync(pc.statePath, "utf8")));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-drive-mirror-"));
  drive = new FakeDrive();
  pcs = ["home", "work", "laptop"].map((name, index) => {
    const folder = join(root, name, "mirror");
    mkdirSync(folder, { recursive: true });
    const ids = { profileDeviceId: `device-${name}`, writerId: `writer-${name}`, memoryDeviceId: ["a", "b", "c"][index].repeat(12) };
    const pc = { folder, statePath: join(root, name, "table.json"), ids };
    return { ...pc, mirror: mirrorFor(pc) };
  });
});

afterEach(() => {
  for (const pc of pcs) expect(statSync(pc.folder).isDirectory()).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

describe("Drive mirror", () => {
  it.each(["pictures/한글 100%.png", "assets/a+b.jpg", "threads-v2 (1)/bot/thread/writer/seg-1-2.json.gz"])("round-trips %s in a flat name and short hash", (path) => {
    expect(decodeDrivePath(encodeDrivePath(path))).toBe(path);
    expect(encodeDrivePath(path)).not.toContain("/");
    expect(drivePathHash(path)).toHaveLength(32);
    expect(drivePathHash(path)).toBe(createHash("sha256").update(path).digest("hex").slice(0, 32));
  });

  it.each(["../outside", "/absolute", "pictures\\outside", "pictures//x", "pictures/NUL.png", "pictures/a.", "pictures/a:stream", "%oops", "pictures%2fwrong.png"])("rejects an unsafe or noncanonical name %s", (name) => {
    expect(decodeDrivePath(name)).toBeNull();
  });

  it.each([
    ["devices/device-home.json", "own"], ["devices/device-work.json", "peer"],
    ["changes/000000000001-device-home-op.json", "own"], ["changes/000000000001-device-work-op.json", "once"],
    ["memory-v2/bot/aaaaaaaaaaaa.json", "own"], ["memory-v2 (1)/bot/aaaaaaaaaaaa.json", "own"], ["memory-v2 (2)/bot/bbbbbbbbbbbb.json", "peer"],
    ["threads-v2/bot/thread/writer-home/head.json", "own"], ["threads-v2 (1)/bot/thread/writer-home/head.json", "own"], ["threads-v2 (2)/bot/thread/writer-work/head.json", "peer"],
    ["threads-v2/bot/thread/writer-home/seg-1-2.json.gz", "once"], ["assets/a.png", "once"], ["pictures/a.png", "once"], ["workspace.json", "once"],
    ["threads/bot/thread.conflict-work-1.json", "once"], ["threads/bot/thread.deleted.json", "once"], ["memory/bot/.ancestry/MEMORY.md.json", "once"],
    ["devices/device-home.json.1.tmp", "ignore"], ["notes.txt", "unknown"], ["memory-v2 (0)/bot/aaaaaaaaaaaa.json", "unknown"],
  ])("classifies %s as %s", (path, rule) => {
    expect(drivePathRule(path, pcs[0].ids)).toBe(rule);
  });

  it("keeps each PC's own files authoritative across three PCs", async () => {
    const paths = pcs.map((pc) => [`devices/${pc.ids.profileDeviceId}.json`, `memory-v2/bot/${pc.ids.memoryDeviceId}.json`, `threads-v2/bot/thread/${pc.ids.writerId}/head.json`, `changes/000000000001-${pc.ids.profileDeviceId}-op.json`]);
    for (const [index, pc] of pcs.entries()) {
      for (const path of paths[index]) write(pc, path, `local-${index}`);
      expect((await pc.mirror.syncOnce()).uploaded).toHaveLength(4);
    }
    for (const [index, pc] of pcs.entries()) {
      await pc.mirror.syncOnce();
      for (const path of paths[index]) expect(read(pc, path)).toBe(`local-${index}`);
      for (const [peer, peerPaths] of paths.entries()) for (const path of peerPaths) expect(read(pc, path)).toBe(`local-${peer}`);
    }
    const file = [...drive.records.values()].find(({ file }) => decodeDrivePath(file.name) === paths[0][2])!;
    drive.edit(file.file.id, Buffer.from("late peer copy"));
    const summary = await pcs[0].mirror.syncOnce();
    expect(summary.uploaded).toEqual([paths[0][2]]);
    expect(summary.downloaded).not.toContain(paths[0][2]);
    expect(read(pcs[0], paths[0][2])).toBe("local-0");
    expect(drive.records.get(file.file.id)!.bytes.toString()).toBe("local-0");
  });

  it.each(["assets/a.png", "pictures/a.png", "workspace.json", "threads-v2/bot/thread/writer-home/seg-1-2.json.gz", "threads/bot/thread.json", "memory/bot/MEMORY.md", "changes/000000000001-device-work-op.json"])("never overwrites either differing copy of %s", async (path) => {
    const remote = seed(path, "remote");
    write(pcs[0], path, "local");
    const before = drive.records.get(remote.id)!.file.modifiedTime;
    const summary = await pcs[0].mirror.syncOnce();
    expect(summary.conflicts).toEqual([path]);
    expect(summary.uploaded).toEqual([]);
    expect(summary.downloaded).toEqual([]);
    expect(read(pcs[0], path)).toBe("local");
    expect(drive.records.get(remote.id)!.bytes.toString()).toBe("remote");
    expect(drive.records.get(remote.id)!.file.modifiedTime).toBe(before);
    expect(table(pcs[0]).files[path]).toBeUndefined();
    for (const pc of pcs.slice(1)) {
      await pc.mirror.syncOnce();
      if (drivePathRule(path, pc.ids) === "own") expect(existsSync(join(pc.folder, path))).toBe(false);
      else expect(read(pc, path)).toBe("remote");
    }
  });

  it("publishes peer files atomically after the entire download", async () => {
    const path = "threads-v2/bot/thread/writer-home/head.json";
    const body = "x".repeat(200_000);
    seed(path, body);
    write(pcs[1], path, "old");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    drive.onDownload = async () => { entered(); await gate; };
    const pass = pcs[1].mirror.syncOnce();
    await started;
    expect(read(pcs[1], path)).toBe("old");
    release();
    expect((await pass).downloaded).toEqual([path]);
    expect(read(pcs[1], path)).toBe(body);
    expect(readdirSync(dirname(join(pcs[1].folder, path)))).toEqual(["head.json"]);
    drive.onDownload = undefined;
    await pcs[2].mirror.syncOnce();
    expect(read(pcs[2], path)).toBe(body);
  });

  it("uploads every pre-existing kind in dependency order on its first pass", async () => {
    const paths = ["workspace.json", "assets/a.png", "pictures/a.png", "threads-v2/bot/thread/writer-home/seg-1-2.json.gz", "changes/000000000001-device-home-op.json", "memory/bot/MEMORY.md", "threads/bot/thread.json", "memory-v2/bot/aaaaaaaaaaaa.json", "threads-v2/bot/thread/writer-home/head.json", "devices/device-home.json"];
    for (const path of paths.toReversed()) write(pcs[0], path, path);
    write(pcs[0], "devices/device-home.json.1.tmp", "partial");
    const summary = await pcs[0].mirror.syncOnce();
    expect(summary.uploaded).toEqual(paths);
    expect(drive.uploads.map((upload) => decodeDrivePath(upload.name))).toEqual(paths);
    expect(summary.skipped).toContain("devices/device-home.json.1.tmp");
    expect(Object.keys(table(pcs[0]).files)).toEqual(paths);
    expect(table(pcs[0]).binding).toEqual({ owner: OWNER, rootId: drive.root().id, mirrorPath: pcs[0].folder, generation: 1 });
    expect(table(pcs[0]).syncedAt).toBe(100);
  });

  it("downloads write-once files before memory, heads and devices", async () => {
    const paths = ["workspace.json", "assets/a.png", "pictures/a.png", "threads-v2/bot/thread/writer-home/seg-1-2.json.gz", "changes/000000000001-device-home-op.json", "memory-v2/bot/aaaaaaaaaaaa.json", "threads-v2/bot/thread/writer-home/head.json", "devices/device-home.json"];
    for (const path of paths.toReversed()) seed(path, path);
    expect((await pcs[1].mirror.syncOnce()).downloaded).toEqual(paths);
    expect(drive.downloads.map((id) => decodeDrivePath(drive.records.get(id)!.file.name))).toEqual(paths);
  });

  it("seeds pre-existing peer files too when Drive lacks them", async () => {
    const path = "threads-v2 (1)/bot/thread/writer-work/head.json";
    write(pcs[0], path, "preserved peer history");
    expect((await pcs[0].mirror.syncOnce()).uploaded).toEqual([path]);
    await pcs[2].mirror.syncOnce();
    expect(read(pcs[2], path)).toBe("preserved peer history");
  });

  it("skips unchanged content without another upload or download", async () => {
    write(pcs[0], "devices/device-home.json", "own");
    seed("devices/device-work.json", "peer");
    seed("assets/a.png", "asset");
    await pcs[0].mirror.syncOnce();
    drive.uploads.length = 0;
    drive.downloads.length = 0;
    const state = readFileSync(pcs[0].statePath, "utf8");
    const summary = await pcs[0].mirror.syncOnce();
    expect(summary.uploaded).toEqual([]);
    expect(summary.downloaded).toEqual([]);
    expect(summary.skipped).toHaveLength(3);
    expect(drive.uploads).toEqual([]);
    expect(drive.downloads).toEqual([]);
    expect(readFileSync(pcs[0].statePath, "utf8")).toBe(state);
  });

  it("never downloads an absent own mutable file", async () => {
    const path = "devices/device-home.json";
    seed(path, "stale own copy");
    const summary = await pcs[0].mirror.syncOnce();
    expect(summary.skipped).toEqual([path]);
    expect(existsSync(join(pcs[0].folder, path))).toBe(false);
    expect(drive.downloads).toEqual([]);
  });

  it.each(["owner", "path", "generation", "root"])("fails closed when the table's %s changes", async (kind) => {
    write(pcs[0], "devices/device-home.json", "local");
    await pcs[0].mirror.syncOnce();
    const state = table(pcs[0]);
    if (kind === "owner") state.binding.owner.sub = "account-b";
    if (kind === "path") state.binding.mirrorPath = pcs[1].folder;
    if (kind === "generation") state.binding.generation++;
    if (kind === "root") state.binding.rootId = "another-root";
    const changed = JSON.stringify(state);
    writeFileSync(pcs[0].statePath, changed);
    const calls = drive.calls.length;
    await expect(pcs[0].mirror.syncOnce()).rejects.toMatchObject({ problem: "binding" });
    expect(drive.calls).toHaveLength(calls);
    expect(readFileSync(pcs[0].statePath, "utf8")).toBe(changed);
    expect(read(pcs[0], "devices/device-home.json")).toBe("local");
  });

  it("rejects different owner and mirror arguments after restart", async () => {
    await pcs[0].mirror.syncOnce();
    const calls = drive.calls.length;
    await expect(mirrorFor(pcs[0], { owner: { ...OWNER, sub: "account-b" } }).syncOnce()).rejects.toBeInstanceOf(DriveMirrorError);
    await expect(mirrorFor(pcs[0], { mirrorPath: pcs[1].folder }).syncOnce()).rejects.toMatchObject({ problem: "binding" });
    expect(drive.calls).toHaveLength(calls);
  });

  it.each(["{", "null", '{"version":99}', '{"version":1,"binding":{}}'])("never resets a corrupt table %s", async (body) => {
    writeFileSync(pcs[0].statePath, body);
    await expect(pcs[0].mirror.syncOnce()).rejects.toMatchObject({ problem: "corrupt-table" });
    expect(readFileSync(pcs[0].statePath, "utf8")).toBe(body);
    expect(drive.calls).toEqual([]);
  });

  it("does not become a new PC when a bound table disappears", async () => {
    await pcs[0].mirror.syncOnce();
    unlinkSync(pcs[0].statePath);
    const calls = drive.calls.length;
    await expect(pcs[0].mirror.syncOnce()).rejects.toMatchObject({ problem: "missing-table" });
    expect(existsSync(pcs[0].statePath)).toBe(false);
    expect(drive.calls).toHaveLength(calls);
  });

  it.each(["devices/device-home.json", "assets/a.png"])("recovers a create-before-save crash with duplicate %s files", async (path) => {
    write(pcs[0], path, "local");
    drive.root();
    drive.onCreate = (file) => {
      drive.onCreate = undefined;
      drive.add(file.name, file.appProperties ?? {}, Buffer.from("local"), [drive.root().id]);
      throw new Error("simulated crash after Drive commit");
    };
    await expect(pcs[0].mirror.syncOnce()).rejects.toThrow();
    expect(table(pcs[0]).files[path]).toBeUndefined();
    const copies = [...drive.records.values()].filter(({ file }) => decodeDrivePath(file.name) === path);
    expect(copies).toHaveLength(2);
    const summary = await mirrorFor(pcs[0]).syncOnce();
    const selected = path.startsWith("assets/") ? copies[0] : copies[1];
    expect(summary.duplicates).toEqual([{ path, selectedId: selected.file.id, ids: path.startsWith("assets/") ? copies.map(({ file }) => file.id) : copies.toReversed().map(({ file }) => file.id) }]);
    expect(table(pcs[0]).files[path].driveId).toBe(selected.file.id);
    expect(read(pcs[0], path)).toBe("local");
    expect(copies.every(({ bytes, file }) => bytes.toString() === "local" && drive.records.has(file.id))).toBe(true);
    expect(drive.uploads).toHaveLength(1);
  });

  it("keeps the oldest write-once duplicate and reports differing data", async () => {
    const first = seed("assets/a.png", "oldest");
    const second = seed("assets/a.png", "newer variant");
    const summary = await pcs[0].mirror.syncOnce();
    expect(summary.duplicates[0].selectedId).toBe(first.id);
    expect(summary.conflicts).toEqual(["assets/a.png"]);
    expect(read(pcs[0], "assets/a.png")).toBe("oldest");
    expect(drive.records.get(second.id)!.bytes.toString()).toBe("newer variant");
  });

  it("uses the newest own duplicate while preserving every remote copy", async () => {
    const first = seed("devices/device-home.json", "first");
    const second = seed("devices/device-home.json", "second");
    write(pcs[0], "devices/device-home.json", "latest local");
    const summary = await pcs[0].mirror.syncOnce();
    expect(summary.duplicates[0].selectedId).toBe(second.id);
    expect(drive.records.get(first.id)!.bytes.toString()).toBe("first");
    expect(drive.records.get(second.id)!.bytes.toString()).toBe("latest local");
  });

  it("never deletes data, cleans duplicates or removes table entries", async () => {
    const path = "devices/device-home.json";
    write(pcs[0], path, "own");
    seed("pictures/a.png", "picture");
    seed("pictures/a.png", "picture");
    await pcs[0].mirror.syncOnce();
    const state = table(pcs[0]);
    const ownId = state.files[path].driveId;
    unlinkSync(join(pcs[0].folder, path));
    drive.records.get(state.files["pictures/a.png"].driveId)!.file.trashed = true;
    await pcs[0].mirror.syncOnce();
    expect(drive.records.has(ownId)).toBe(true);
    expect(read(pcs[0], "pictures/a.png")).toBe("picture");
    expect(table(pcs[0]).files[path]).toEqual(state.files[path]);
    expect(drive.calls.every((call) => call.method !== "DELETE")).toBe(true);
    expect(drive.records.size).toBe(4);
  });

  it("does not replace a disappeared remote root", async () => {
    write(pcs[0], "assets/a.png", "safe");
    await pcs[0].mirror.syncOnce();
    drive.records.get(drive.root().id)!.file.trashed = true;
    const roots = [...drive.records.values()].filter(({ file }) => file.appProperties?.winkRoot === "1").length;
    await expect(pcs[0].mirror.syncOnce()).rejects.toMatchObject({ status: 404 });
    expect(read(pcs[0], "assets/a.png")).toBe("safe");
    expect([...drive.records.values()].filter(({ file }) => file.appProperties?.winkRoot === "1")).toHaveLength(roots);
  });

  it("refuses a missing local mirror and never recreates it", async () => {
    const moved = `${pcs[0].folder}-saved`;
    renameSync(pcs[0].folder, moved);
    try {
      await expect(pcs[0].mirror.syncOnce()).rejects.toMatchObject({ problem: "mirror-unavailable" });
      expect(existsSync(pcs[0].folder)).toBe(false);
      expect(drive.calls).toEqual([]);
    } finally { renameSync(moved, pcs[0].folder); }
  });

  it("rejects junctions inside the mirror", async () => {
    symlinkSync(pcs[1].folder, join(pcs[0].folder, "pictures"), process.platform === "win32" ? "junction" : "dir");
    await expect(pcs[0].mirror.syncOnce()).rejects.toMatchObject({ problem: "unsafe-path" });
    expect(drive.uploads).toEqual([]);
  });

  it("requires the table outside the mirror, including through a junction", () => {
    expect(() => mirrorFor(pcs[0], { statePath: join(pcs[0].folder, "table.json") })).toThrow(DriveMirrorError);
    const alias = join(root, "alias");
    symlinkSync(pcs[0].folder, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => mirrorFor(pcs[0], { statePath: join(alias, "table.json") })).toThrow(DriveMirrorError);
  });

  it("rejects stale downloads after a generation change", async () => {
    const path = "devices/device-work.json";
    seed(path, "peer");
    write(pcs[0], path, "local old");
    drive.onDownload = () => { const state = table(pcs[0]); state.binding.generation++; writeFileSync(pcs[0].statePath, JSON.stringify(state)); };
    await expect(pcs[0].mirror.syncOnce()).rejects.toMatchObject({ problem: "binding" });
    expect(read(pcs[0], path)).toBe("local old");
    expect(table(pcs[0]).files[path]).toBeUndefined();
  });

  it("rejects stale root-create completions after an owner change", async () => {
    drive.onCreate = () => { const state = table(pcs[0]); state.binding.owner.sub = "account-b"; writeFileSync(pcs[0].statePath, JSON.stringify(state)); };
    write(pcs[0], "assets/a.png", "account-a data");
    await expect(pcs[0].mirror.syncOnce()).rejects.toMatchObject({ problem: "binding" });
    expect(drive.uploads).toEqual([]);
    expect(table(pcs[0]).binding.rootId).toBeNull();
  });

  it("rejects bytes that no longer match the listed checksum", async () => {
    const remote = seed("devices/device-work.json", "listed");
    const client = createDriveClient({ getAccessToken: async () => "test-access", fetch: drive.fetch });
    const mirror = mirrorFor(pcs[0], { client: { ...client, downloadFile: async (id) => { drive.edit(remote.id, Buffer.from("changed")); return client.downloadFile(id); } } });
    await expect(mirror.syncOnce()).rejects.toMatchObject({ problem: "content-changed" });
    expect(existsSync(join(pcs[0].folder, "devices/device-work.json"))).toBe(false);
    expect(table(pcs[0]).files).toEqual({});
  });

  it("preserves a write-once file that appears during download", async () => {
    seed("pictures/a.png", "remote");
    drive.onDownload = () => write(pcs[0], "pictures/a.png", "new local");
    const summary = await pcs[0].mirror.syncOnce();
    expect(summary.conflicts).toEqual(["pictures/a.png"]);
    expect(read(pcs[0], "pictures/a.png")).toBe("new local");
    expect(summary.downloaded).toEqual([]);
    expect(readdirSync(join(pcs[0].folder, "pictures"))).toEqual(["a.png"]);
  });

  it("ignores temporary, unmanaged and hash-mismatched remote files", async () => {
    seed("pictures/a.png.1.tmp", "partial");
    seed("notes.txt", "unknown");
    drive.add(encodeDrivePath("pictures/a.png"), { ph: "wrong" }, Buffer.from("unmanaged"), [drive.root().id]);
    drive.add("..%2Foutside", {}, Buffer.from("unsafe"), [drive.root().id]);
    write(pcs[0], "notes.txt", "keep local");
    const summary = await pcs[0].mirror.syncOnce();
    expect(summary.uploaded).toEqual([]);
    expect(summary.downloaded).toEqual([]);
    expect(summary.skipped).toHaveLength(4);
    expect(read(pcs[0], "notes.txt")).toBe("keep local");
  });

  it("coalesces a pass and rejects a second mirror using the same table", async () => {
    seed("pictures/a.png", "remote");
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    drive.onDownload = async () => { entered(); await gate; };
    const first = pcs[0].mirror.syncOnce();
    await started;
    expect(pcs[0].mirror.syncOnce()).toBe(first);
    await expect(mirrorFor(pcs[0]).syncOnce()).rejects.toMatchObject({ problem: "busy" });
    release();
    await first;
  });

  it.each(["EBUSY", "EPERM"])("retries an atomic rename on %s", async (code) => {
    const source = join(root, "download.tmp");
    const target = join(root, "download.json");
    writeFileSync(source, "whole new file");
    writeFileSync(target, "old");
    let attempts = 0;
    await renameDriveFile(source, target, () => {}, (from, to) => {
      if (++attempts < 3) { expect(readFileSync(to, "utf8")).toBe("old"); throw Object.assign(new Error("busy"), { code }); }
      renameSync(from, to);
    });
    expect(attempts).toBe(3);
    expect(readFileSync(target, "utf8")).toBe("whole new file");
    expect(existsSync(source)).toBe(false);
  });

  it("stops a busy rename retry if its binding becomes stale", async () => {
    let checks = 0;
    let attempts = 0;
    await expect(renameDriveFile("source", "target", () => { if (++checks === 2) throw new DriveMirrorError("binding"); }, () => { attempts++; throw Object.assign(new Error("busy"), { code: "EPERM" }); })).rejects.toMatchObject({ problem: "binding" });
    expect(attempts).toBe(1);
  });
});

describe("Drive engine identities", () => {
  function localState(): string {
    const dataDir = join(root, "local-state");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "profile-sync.json"), JSON.stringify({ deviceId: pcs[0].ids.profileDeviceId }));
    writeFileSync(join(dataDir, "memory-sync-v2.json"), JSON.stringify({ device: pcs[0].ids.memoryDeviceId, bots: {} }));
    const db = new DatabaseSync(join(dataDir, "messages.db"));
    db.exec("CREATE TABLE sync_v2_identity (id INTEGER PRIMARY KEY, device TEXT NOT NULL, writer TEXT NOT NULL)");
    db.prepare("INSERT INTO sync_v2_identity VALUES (1, ?, ?)").run(pcs[0].ids.profileDeviceId, pcs[0].ids.writerId);
    db.close();
    return dataDir;
  }

  it("reads saved identities without changing a byte or creating engine state", () => {
    const dataDir = localState();
    const files = readdirSync(dataDir);
    const before = files.map((name) => readFileSync(join(dataDir, name)));
    expect(readDriveOwnIds(dataDir)).toEqual(pcs[0].ids);
    expect(readdirSync(dataDir)).toEqual(files);
    expect(files.map((name) => readFileSync(join(dataDir, name)))).toEqual(before);
  });

  it("reads the committed writer from an open WAL without changing engine data", () => {
    const dataDir = localState();
    const path = join(dataDir, "messages.db");
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("UPDATE sync_v2_identity SET writer = 'writer-wal'");
      const files = ["profile-sync.json", "memory-sync-v2.json", "messages.db", "messages.db-wal"];
      const before = files.map((name) => readFileSync(join(dataDir, name)));
      expect(readDriveOwnIds(dataDir)).toEqual({ ...pcs[0].ids, writerId: "writer-wal" });
      expect(files.map((name) => readFileSync(join(dataDir, name)))).toEqual(before);
    } finally { db.close(); }
  });

  it("fails closed when the saved writer belongs to another device", () => {
    const dataDir = localState();
    const db = new DatabaseSync(join(dataDir, "messages.db"));
    db.exec("UPDATE sync_v2_identity SET device = 'another-device'");
    db.close();
    expect(() => readDriveOwnIds(dataDir)).toThrow(DriveIdentityError);
  });

  it.each(["profile-sync.json", "memory-sync-v2.json", "messages.db"])("does not replace missing %s", (name) => {
    const dataDir = localState();
    unlinkSync(join(dataDir, name));
    expect(() => readDriveOwnIds(dataDir)).toThrow(DriveIdentityError);
    expect(existsSync(join(dataDir, name))).toBe(false);
  });

  it.each(["profile-sync.json", "memory-sync-v2.json", "messages.db"])("does not repair corrupt %s", (name) => {
    const dataDir = localState();
    writeFileSync(join(dataDir, name), "broken");
    expect(() => readDriveOwnIds(dataDir)).toThrow(DriveIdentityError);
    expect(readFileSync(join(dataDir, name), "utf8")).toBe("broken");
  });
});
