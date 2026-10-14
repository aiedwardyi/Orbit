import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createUploads, safeUploadName, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, uploadTargetDir, type UploadsOptions } from "./uploads.ts";

const roots: string[] = [];
const servers: Server[] = [];
const DAY = 24 * 60 * 60 * 1000;

interface UploadBody {
  id: string;
  offset: number;
  path: string;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function serve(options: Partial<UploadsOptions> = {}) {
  const dir = temp("uploads-");
  const uploads = createUploads({ dir: () => dir, statfs: () => ({ bavail: 2 ** 50, bsize: 1 }), ...options });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void uploads.handle(req, res, req.method ?? "GET", url.pathname, url).then(
      (handled) => {
        if (!handled) res.writeHead(404).end();
      },
      (error: unknown) => res.writeHead(500).end(String(error)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/uploads`;
  const create = async (body: Record<string, unknown>) => {
    const res = await fetch(base, { method: "POST", body: JSON.stringify({ type: "video/mp4", lastModified: 7, ...body }) });
    return { status: res.status, body: (await res.json()) as UploadBody };
  };
  const chunk = async (id: string, offset: number, bytes: Buffer) => {
    const res = await fetch(`${base}/${id}/chunk?offset=${offset}`, { method: "POST", body: bytes });
    return { status: res.status, body: (await res.json()) as UploadBody };
  };
  const status = async (id: string) => (await (await fetch(`${base}/${id}`)).json()) as UploadBody;
  return { dir, base, uploads, create, chunk, status };
}

// Sends a chunk without finishing its body, so the server holds it in flight.
function openChunk(base: string, id: string, offset: number, declared: number, first: Buffer) {
  const req = request(`${base}/${id}/chunk?offset=${offset}`, { method: "POST", headers: { "content-length": declared } });
  req.on("error", () => {});
  req.write(first);
  return req;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

describe("big-file uploads", () => {
  it("rejects a file over 10 GiB at create", async () => {
    const { create } = await serve();
    expect(await create({ name: "huge.mkv", size: UPLOAD_MAX_BYTES + 1 })).toEqual({ status: 413, body: { code: "too_big" } });
  });

  it("refuses a create that would leave less than 1 GiB free", async () => {
    const size = 5_000;
    const { create } = await serve({ statfs: () => ({ bavail: 1, bsize: size + 1024 ** 3 - 1 }) });
    expect(await create({ name: "a.mp4", size })).toEqual({ status: 507, body: { code: "disk_full" } });
  });

  it("answers a wrong offset or a second chunk in flight with 409", async () => {
    const { base, create, chunk, status } = await serve();
    const { body } = await create({ name: "a.mp4", size: 100 });
    expect(await chunk(body.id, 5, Buffer.alloc(10))).toEqual({ status: 409, body: { code: "offset", offset: 0 } });
    const first = openChunk(base, body.id, 0, 50, Buffer.alloc(20, 1));
    await until(async () => (await status(body.id)).offset === 20);
    expect(await chunk(body.id, 20, Buffer.alloc(10))).toEqual({ status: 409, body: { code: "offset", offset: 20 } });
    first.end(Buffer.alloc(30, 1));
    await until(async () => (await status(body.id)).offset === 50);
  });

  it("keeps the prefix of an aborted chunk and finishes a byte-identical file", async () => {
    const { dir, base, create, chunk, status } = await serve();
    const bytes = Buffer.from(Array.from({ length: 1_000 }, (_, i) => i % 251));
    const { body } = await create({ name: "clip.mp4", size: bytes.length });
    const cut = openChunk(base, body.id, 0, 600, bytes.subarray(0, 300));
    await until(async () => (await status(body.id)).offset === 300);
    cut.destroy();
    expect(await status(body.id)).toEqual({ offset: 300, size: 1_000, done: false });
    let done: { status: number; body: UploadBody } | undefined;
    await until(async () => {
      done = await chunk(body.id, 300, bytes.subarray(300));
      return done.status !== 409;
    });
    const path = join(dir, "clip.mp4");
    expect(done).toEqual({ status: 200, body: { offset: 1_000, done: true, path, name: "clip.mp4", size: 1_000, type: "video/mp4" } });
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(await status(body.id)).toEqual({ offset: 1_000, size: 1_000, done: true, path, name: "clip.mp4", type: "video/mp4" });
    if (process.platform === "win32") expect(readFileSync(`${path}:Zone.Identifier`, "utf8")).toContain("ZoneId=3");
  });

  it("sanitizes names and numbers a collision", async () => {
    expect(safeUploadName("..\\..\\evil.exe")).toBe("evil.exe");
    expect(safeUploadName("CON.mp4")).toBe("_CON.mp4");
    expect(safeUploadName("a<b>.mp4")).toBe("a_b_.mp4");
    expect(safeUploadName("   ")).toBe("file");
    const long = safeUploadName(`${"x".repeat(300)}.mp4`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(".mp4")).toBe(true);
    const { dir, create, chunk } = await serve();
    for (const lastModified of [1, 2]) {
      const { body } = await create({ name: "notes.txt", size: 3, lastModified });
      await chunk(body.id, 0, Buffer.from("abc"));
    }
    expect(readdirSync(dir).filter((name) => name !== ".uploading").sort()).toEqual(["notes (2).txt", "notes.txt"]);
  });

  it("resumes a re-create with the same name, size and lastModified", async () => {
    const { create, chunk } = await serve();
    const first = await create({ name: "a.mp4", size: 100 });
    expect(first).toEqual({ status: 201, body: { id: first.body.id, offset: 0, chunkBytes: UPLOAD_CHUNK_BYTES } });
    await chunk(first.body.id, 0, Buffer.alloc(40));
    expect(await create({ name: "a.mp4", size: 100 })).toEqual({ status: 201, body: { id: first.body.id, offset: 40, chunkBytes: UPLOAD_CHUNK_BYTES } });
    expect((await create({ name: "a.mp4", size: 100, lastModified: 8 })).body.id).not.toBe(first.body.id);
  });

  it("deletes the part, and a finished file under 24 h old", async () => {
    const { dir, base, create, chunk } = await serve();
    const open = await create({ name: "a.mp4", size: 100 });
    await chunk(open.body.id, 0, Buffer.alloc(10));
    expect((await fetch(`${base}/${open.body.id}`, { method: "DELETE" })).status).toBe(204);
    expect(readdirSync(join(dir, ".uploading"))).toEqual([]);
    const done = await create({ name: "b.mp4", size: 3 });
    const finished = await chunk(done.body.id, 0, Buffer.from("abc"));
    expect(existsSync(finished.body.path)).toBe(true);
    expect((await fetch(`${base}/${done.body.id}`, { method: "DELETE" })).status).toBe(204);
    expect(existsSync(finished.body.path)).toBe(false);
    expect(readdirSync(join(dir, ".uploading"))).toEqual([]);
    expect((await fetch(`${base}/${done.body.id}`)).status).toBe(404);
  });

  it("sweeps sessions idle 24 h and keeps finished files", async () => {
    let now = 1_000;
    const { dir, uploads, create, chunk, status } = await serve({ now: () => now });
    const idle = await create({ name: "a.mp4", size: 100 });
    const done = await create({ name: "b.mp4", size: 3 });
    const finished = await chunk(done.body.id, 0, Buffer.from("abc"));
    now += DAY - 1;
    uploads.sweep();
    expect((await status(idle.body.id)).offset).toBe(0);
    now += 1;
    uploads.sweep();
    expect(readdirSync(join(dir, ".uploading"))).toEqual([]);
    expect(readFileSync(finished.body.path, "utf8")).toBe("abc");
  });

  it("falls back to DATA_DIR/files when Downloads is inside the sync folder", () => {
    const sync = temp("uploads-sync-");
    const data = temp("uploads-data-");
    const downloads = join(sync, "Downloads");
    mkdirSync(downloads);
    expect(uploadTargetDir(downloads, [sync], data)).toBe(join(data, "files"));
    expect(uploadTargetDir(downloads, [join(data, "google-drive")], data)).toBe(join(downloads, "Wink"));
  });

  it("caps a chunk at 8 MiB and open sessions at 4", async () => {
    const { base, create, chunk, status } = await serve();
    const { body } = await create({ name: "a.mp4", size: 20 * 1024 ** 2 });
    expect(await chunk(body.id, 0, Buffer.alloc(UPLOAD_CHUNK_BYTES + 1))).toEqual({ status: 413, body: { code: "too_big" } });
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/${body.id}/chunk?offset=0`, { method: "POST" }, (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.write(Buffer.alloc(UPLOAD_CHUNK_BYTES + 1));
      req.end();
    });
    expect(streamed).toBe(413);
    expect((await status(body.id)).offset).toBe(0);
    for (const name of ["b.mp4", "c.mp4", "d.mp4"]) expect((await create({ name, size: 10 })).status).toBe(201);
    expect(await create({ name: "e.mp4", size: 10 })).toEqual({ status: 429, body: { code: "busy" } });
  });
});
