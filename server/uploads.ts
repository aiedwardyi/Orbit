// Big files from any device land on this PC's disk in resumable 8 MiB chunks, never in a sync folder.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statfsSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";

import { writeFileAtomic } from "./atomic.ts";
import { sendJson } from "./compression.ts";

export const UPLOAD_MAX_BYTES = 10 * 1024 ** 3;
export const UPLOAD_CHUNK_BYTES = 8 * 1024 ** 2;
export const MAX_OPEN_UPLOADS = 4;

const UPLOADING_DIR = ".uploading";
const DISK_RESERVE_BYTES = 1024 ** 3;
const IDLE_MS = 24 * 60 * 60 * 1000;
const UPLOAD_ID = /^[0-9a-f-]{36}$/;
const RESERVED_STEM = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_NAME_CHARS = 120;

interface UploadRecord {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  createdAt: number;
  touchedAt: number;
  path?: string;
  doneAt?: number;
}

export interface UploadsOptions {
  dir: () => string;
  now?: () => number;
  statfs?: (dir: string) => { bavail: number; bsize: number };
}

/** Same rules as the device window's linked-file names: one segment, no reserved stems, 120 chars. */
export function safeUploadName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- Control characters are not valid in Windows names.
  const base = (raw.split(/[\\/]/).pop() ?? "").replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/[. ]+$/, "");
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 && /^\.[a-z0-9]{1,16}$/i.test(base.slice(dot)) ? base.slice(dot) : "";
  const stem = (ext ? base.slice(0, dot) : base).replace(/^[. ]+/, "").slice(0, MAX_NAME_CHARS - ext.length - 1) || "file";
  return `${RESERVED_STEM.test(stem.split(".")[0]!) ? "_" : ""}${stem}${ext}`;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// A folder that does not exist yet still resolves through its nearest real ancestor.
function resolvedPath(path: string): string {
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * OneDrive and Google Drive for desktop folders, whatever Wink's own sync points at.
 * Drive letters are never probed: this runs at server start, and a stat on a disconnected network drive blocks for seconds.
 */
export function cloudSyncRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const oneDrive = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((root): root is string => Boolean(root));
  const myDrive = join(home, "My Drive");
  return existsSync(myDrive) ? [...oneDrive, myDrive] : oneDrive;
}

/** <Downloads>\Wink, or DATA_DIR/files when that overlaps a sync folder. */
export function uploadTargetDir(downloads: string, syncFolders: readonly string[], dataDir: string): string {
  const target = join(downloads, "Wink");
  const real = resolvedPath(target);
  const synced = syncFolders.some((folder) => {
    const root = resolvedPath(folder);
    return inside(root, real) || inside(real, root);
  });
  return synced ? join(dataDir, "files") : target;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  sendJson(res, status, JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const fail = (status: number, msg: string) => {
      if (done) return;
      done = true;
      reject(Object.assign(new Error(msg), { status }));
    };
    req.on("data", (c: Buffer) => {
      if (done) return;
      bytes += c.length;
      if (bytes > 1_000_000) return fail(413, "body too large");
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      try {
        const data = Buffer.concat(chunks).toString("utf8");
        const body: unknown = data ? JSON.parse(data) : {};
        done = true;
        resolve(body);
      } catch {
        fail(400, "invalid JSON body");
      }
    });
    req.on("error", (e) => fail(400, e.message));
  });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function candidateName(name: string, n: number): string {
  if (n === 1) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

// A rename on Windows overwrites, so the name is claimed with an exclusive create and the part renamed over that placeholder.
function claimFinalPath(dir: string, part: string, name: string): string {
  for (let n = 1; ; n++) {
    const candidate = join(dir, candidateName(name, n));
    if (relative(dir, candidate) !== basename(candidate)) throw new Error("upload name escapes its folder");
    try {
      closeSync(openSync(candidate, "wx"));
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
    try {
      renameSync(part, candidate);
    } catch (error) {
      tryUnlink(candidate);
      throw error;
    }
    return candidate;
  }
}

function markOfTheWeb(path: string): void {
  if (process.platform !== "win32") return;
  try {
    writeFileSync(`${path}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
  } catch {
    // non-NTFS volume
  }
}

export function createUploads(options: UploadsOptions) {
  const now = options.now ?? Date.now;
  const statfs = options.statfs ?? statfsSync;
  const inFlight = new Set<string>();

  const sessionsDir = () => join(options.dir(), UPLOADING_DIR);
  const recordPath = (id: string) => join(sessionsDir(), `${id}.json`);
  const partPath = (id: string) => join(sessionsDir(), `${id}.part`);

  const load = (id: string): UploadRecord | null => {
    try {
      return JSON.parse(readFileSync(recordPath(id), "utf8")) as UploadRecord;
    } catch {
      return null;
    }
  };
  const save = (id: string, record: UploadRecord) => writeFileAtomic(recordPath(id), JSON.stringify(record));
  const sessions = (): [string, UploadRecord][] => {
    let names: string[];
    try {
      names = readdirSync(sessionsDir());
    } catch {
      return [];
    }
    const found: [string, UploadRecord][] = [];
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      if (!name.endsWith(".json") || !UPLOAD_ID.test(id)) continue;
      const record = load(id);
      if (record) found.push([id, record]);
    }
    return found;
  };
  const doneBody = (record: UploadRecord) => ({ path: record.path, name: basename(record.path!), size: record.size, type: record.type });
  const remove = (id: string) => {
    tryUnlink(partPath(id));
    tryUnlink(recordPath(id));
  };

  async function create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name : "";
    const size = body?.size;
    if (!name.trim() || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) {
      return json(res, 400, { error: "name and a size of 1 or more are required" });
    }
    if (size > UPLOAD_MAX_BYTES) return json(res, 413, { code: "too_big" });
    const type = typeof body?.type === "string" && body.type ? body.type.slice(0, 200) : "application/octet-stream";
    const lastModified = typeof body?.lastModified === "number" && Number.isFinite(body.lastModified) ? body.lastModified : 0;
    const open = sessions().filter(([, record]) => !record.path);
    const match = lastModified > 0 ? open.find(([, r]) => r.name === name && r.size === size && r.lastModified === lastModified) : undefined;
    if (!match && open.length >= MAX_OPEN_UPLOADS) return json(res, 429, { code: "busy" });
    mkdirSync(sessionsDir(), { recursive: true });
    const written = match ? sizeOf(partPath(match[0])) : 0;
    const owed = open.reduce((sum, [id, r]) => (id === match?.[0] ? sum : sum + Math.max(0, r.size - sizeOf(partPath(id)))), 0);
    const { bavail, bsize } = statfs(sessionsDir());
    if (bavail * bsize < size - written + owed + DISK_RESERVE_BYTES) return json(res, 507, { code: "disk_full" });
    if (match) {
      const [id, record] = match;
      save(id, { ...record, touchedAt: now() });
      return json(res, 201, { id, offset: written, chunkBytes: UPLOAD_CHUNK_BYTES });
    }
    const id = randomUUID();
    closeSync(openSync(partPath(id), "wx"));
    save(id, { name, size, type, lastModified, createdAt: now(), touchedAt: now() });
    json(res, 201, { id, offset: 0, chunkBytes: UPLOAD_CHUNK_BYTES });
  }

  async function chunk(req: IncomingMessage, res: ServerResponse, id: string, url: URL): Promise<void> {
    const record = load(id);
    if (!record) return json(res, 404, { code: "gone" });
    if (record.path) return json(res, 409, { code: "offset", offset: record.size });
    const part = partPath(id);
    const start = sizeOf(part);
    if (inFlight.has(id) || url.searchParams.get("offset") !== String(start)) {
      return json(res, 409, { code: "offset", offset: start });
    }
    const limit = Math.min(UPLOAD_CHUNK_BYTES, record.size - start);
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) return json(res, 413, { code: "too_big" });
    inFlight.add(id);
    // A sink error would make pipeline destroy the socket, so failures are kept and the body drained for the 413 or 507.
    const out = createWriteStream(part, { flags: "a" });
    let failure: string | undefined;
    let received = 0;
    out.on("error", (error) => {
      failure ??= errorCode(error) === "ENOSPC" ? "disk_full" : error.message;
    });
    const sink = new Writable({
      write(piece: Buffer, _encoding, callback) {
        received += piece.length;
        if (received > limit) failure ??= "too_big";
        if (failure) return callback();
        out.write(piece, () => callback());
      },
    });
    let aborted = false;
    try {
      await pipeline(req, sink);
    } catch {
      aborted = true;
    } finally {
      out.end();
      await finished(out).catch(() => {});
      inFlight.delete(id);
      // A cancel during the chunk already removed the record; do not bring it back.
      if (load(id)) save(id, { ...record, touchedAt: now() });
    }
    if (!load(id)) {
      tryUnlink(part);
      return json(res, 404, { code: "gone" });
    }
    if (failure === "too_big") {
      truncateSync(part, start);
      return json(res, 413, { code: "too_big" });
    }
    if (failure === "disk_full") return json(res, 507, { code: "disk_full" });
    if (failure) throw new Error(failure);
    if (aborted) return;
    const offset = sizeOf(part);
    if (offset < record.size) return json(res, 200, { offset });
    const dir = options.dir();
    const done: UploadRecord = { ...record, path: claimFinalPath(dir, part, safeUploadName(record.name)), doneAt: now() };
    markOfTheWeb(done.path!);
    save(id, done);
    json(res, 200, { offset, done: true, ...doneBody(done) });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL): Promise<boolean> {
    if (path === "/api/uploads") {
      if (method !== "POST") return false;
      await create(req, res);
      return true;
    }
    const m = path.match(/^\/api\/uploads\/([^/]+)(\/chunk)?$/);
    if (!m) return false;
    const id = m[1]!;
    const isChunk = Boolean(m[2]);
    if (isChunk ? method !== "POST" : method !== "GET" && method !== "DELETE") return false;
    if (!UPLOAD_ID.test(id)) {
      json(res, 404, { code: "gone" });
      return true;
    }
    if (isChunk) {
      await chunk(req, res, id, url);
      return true;
    }
    const record = load(id);
    if (!record) {
      json(res, 404, { code: "gone" });
      return true;
    }
    if (method === "GET") {
      if (record.path) json(res, 200, { offset: record.size, done: true, ...doneBody(record) });
      else json(res, 200, { offset: sizeOf(partPath(id)), size: record.size, done: false });
      return true;
    }
    remove(id);
    res.writeHead(204);
    res.end();
    return true;
  }

  /** Drops sessions idle 24 h and done records 24 h old; finished files stay. */
  function sweep(): void {
    for (const [id, record] of sessions()) {
      if (inFlight.has(id)) continue;
      const age = now() - (record.path ? (record.doneAt ?? 0) : record.touchedAt);
      if (age >= IDLE_MS) remove(id);
    }
  }

  return { handle, sweep };
}
