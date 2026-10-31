import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldLoop, setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DriveClientError, type DriveChange, type DriveClient, type DriveFile } from "./drive-client.ts";
import { driveOwnIdsSchema, type DriveOwnIds } from "./drive-own-ids.ts";

const ownerSchema = z.object({ issuer: z.literal("https://accounts.google.com"), sub: z.string().min(1) }).strict();
export type DriveOwner = z.infer<typeof ownerSchema>;
export type DrivePathRule = "own" | "once" | "peer" | "ignore" | "unknown";
export type DriveMirrorProblem = "binding" | "corrupt-table" | "missing-table" | "mirror-unavailable" | "unsafe-path" | "path-alias" | "split-root" | "invalid-remote" | "content-changed" | "busy";

export class DriveMirrorError extends Error {
  readonly problem: DriveMirrorProblem;
  constructor(problem: DriveMirrorProblem) {
    super(`Drive mirror stopped (${problem})`);
    this.name = "DriveMirrorError";
    this.problem = problem;
  }
}

function validPath(path: string): boolean {
  return !!path && path.split("/").every((part) => !!part && part !== "." && part !== ".."
    && !/[\\<>:"|?*]/.test(part) && [...part].every((char) => char.charCodeAt(0) >= 32) && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

const pathSchema = z.string().refine(validPath);
const entrySchema = z.object({ driveId: z.string().min(1), md5: z.string().regex(/^[a-f0-9]{32}$/), size: z.string().regex(/^\d+$/) }).strict();
const bindingSchema = z.object({ owner: ownerSchema, rootId: z.string().min(1).nullable(), mirrorPath: z.string().min(1), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const tableSchema = z.object({
  version: z.literal(1), binding: bindingSchema, files: z.record(pathSchema, entrySchema),
  syncedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), changeToken: z.string().min(1).optional(),
}).strict();
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60 * 1_000;
const TRANSFERS_AT_ONCE = 8;
type Table = z.infer<typeof tableSchema>;
type Binding = z.infer<typeof bindingSchema>;
type ContentFile = DriveFile & { md5Checksum: string; size: string };

export interface DriveMirrorSummary {
  uploaded: string[];
  downloaded: string[];
  skipped: string[];
  conflicts: string[];
  failed: string[];
  duplicates: Array<{ path: string; selectedId: string; ids: string[] }>;
  retryAfterMs: number | null;
  driveFull: boolean;
}

/** Local md5s by path, trusted while size and mtime hold; outlives one mirror so later passes skip rehashing. */
export type DriveHashes = Map<string, { size: bigint; mtimeNs: bigint; md5: string }>;
type Options = { owner: DriveOwner; mirrorPath: string; statePath: string; ownIds: DriveOwnIds; client: DriveClient; now?: () => number; uploads?: boolean; hashes?: DriveHashes; chatFirst?: boolean; openThread?: string | null; downloaded?: (path: string) => void; behind?: (paths: ReadonlySet<string>) => void; listed?: (files: ReadonlyMap<string, readonly DriveFile[]> | null) => void };
const passes = new Set<string>();
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
export const drivePathHash = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 32);

export function encodeDrivePath(path: string): string {
  if (!validPath(path)) throw new DriveMirrorError("unsafe-path");
  return encodeURIComponent(path);
}

export function decodeDrivePath(name: string): string | null {
  try {
    const path = decodeURIComponent(name);
    return validPath(path) && encodeDrivePath(path) === name ? path : null;
  } catch {
    return null;
  }
}

export function drivePathRule(path: string, ids: DriveOwnIds): DrivePathRule {
  if (!validPath(path)) return "unknown";
  if (path.endsWith(".tmp")) return "ignore";
  const parts = path.split("/");
  const [root] = parts;
  if (path === "workspace.json" || ["assets", "pictures", "threads", "memory"].includes(root)) return "once";
  if (root === "changes" && parts.length === 2 && /^\d+-[A-Za-z0-9._-]+\.(?:json|notes|paths|pin|style)$/.test(parts[1])) {
    return parts[1].replace(/^\d+-/, "").startsWith(`${ids.profileDeviceId}-`) ? "own" : "once";
  }
  if (root === "devices" && parts.length === 2 && parts[1].endsWith(".json")) return parts[1] === `${ids.profileDeviceId}.json` ? "own" : "peer";
  if (/^memory-v2(?: \([1-9]\d*\))?$/.test(root) && parts.length === 3 && /^[0-9a-f]{12}\.json$/.test(parts[2])) return parts[2] === `${ids.memoryDeviceId}.json` ? "own" : "peer";
  if (/^threads-v2(?: \([1-9]\d*\))?$/.test(root) && parts.length === 5) {
    if (/^seg-[1-9]\d*-[1-9]\d*\.json\.gz$/.test(parts[4])) return "once";
    if (parts[4] === "head.json") return parts[3] === ids.writerId ? "own" : "peer";
  }
  return "unknown";
}

function priority(path: string, chatFirst = false, openThread?: string | null): number {
  if (path === "workspace.json") return 0;
  if (path.startsWith("assets/")) return 1;
  const thread = /^threads-v2(?: \([1-9]\d*\))?\/[^/]+\/([^/]+)\/[^/]+\/(seg-[1-9]\d*-[1-9]\d*\.json\.gz|head\.json)$/.exec(path);
  if (chatFirst && thread) return (thread[1] === openThread ? 2 : 4) + Number(thread[2] === "head.json");
  const offset = chatFirst ? 4 : 0;
  if (path.startsWith("pictures/")) return 2 + offset;
  if (/\/seg-[1-9]\d*-[1-9]\d*\.json\.gz$/.test(path)) return 3 + offset;
  if (path.startsWith("changes/")) return 4 + offset;
  if (/^memory-v2(?: \([1-9]\d*\))?\//.test(path)) return 6 + offset;
  if (path.endsWith("/head.json")) return 7 + offset;
  if (path.startsWith("devices/")) return 8 + offset;
  return 5 + offset;
}

function canonicalPath(path: string): string {
  let parent = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(parent), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new DriveMirrorError("unsafe-path");
      const next = dirname(parent);
      if (next === parent) throw new DriveMirrorError("unsafe-path");
      missing.push(relative(next, parent));
      parent = next;
    }
  }
}

function fileStat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

const identityOf = (stat: BigIntStats | null) => stat && `${stat.dev}:${stat.ino}`;
const fileIdentity = (path: string) => identityOf(fileStat(path));

function readTable(statePath: string): Table | null {
  try {
    if (lstatSync(statePath).isSymbolicLink()) throw new DriveMirrorError("unsafe-path");
    return tableSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
  } catch (error) {
    if (error instanceof DriveMirrorError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new DriveMirrorError("corrupt-table");
  }
}

function sameBinding(a: Binding, b: Binding): boolean {
  return a.owner.issuer === b.owner.issuer && a.owner.sub === b.owner.sub && a.rootId === b.rootId
    && samePath(a.mirrorPath, b.mirrorPath) && a.generation === b.generation;
}

export async function renameDriveFile(source: string, target: string, check: () => void, rename = renameSync): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    check();
    try {
      rename(source, target);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error.code === "EBUSY" || error.code === "EPERM")) || attempt === 3) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}

export function createDriveMirror(options: Options) {
  const owner = ownerSchema.parse(options.owner);
  const ids = driveOwnIdsSchema.parse(options.ownIds);
  const mirrorPath = resolve(options.mirrorPath);
  const statePath = canonicalPath(options.statePath);
  const stateRelative = relative(canonicalPath(mirrorPath), statePath);
  if (!stateRelative || (!isAbsolute(stateRelative) && stateRelative !== ".." && !stateRelative.startsWith(`..${sep}`))) throw new DriveMirrorError("unsafe-path");
  const client = options.client;
  const now = options.now ?? Date.now;
  const hashes: DriveHashes = options.hashes ?? new Map();
  let rootIdentity: { dev: number; ino: number } | null = null;
  let bound: Binding | null = null;
  let inflight: Promise<DriveMirrorSummary> | null = null;
  let rateStrikes = 0;

  function checkRoot(): void {
    try {
      const stat = lstatSync(mirrorPath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(mirrorPath), mirrorPath)
        || (rootIdentity && (rootIdentity.dev !== stat.dev || rootIdentity.ino !== stat.ino))) throw new DriveMirrorError("mirror-unavailable");
      rootIdentity ??= { dev: stat.dev, ino: stat.ino };
    } catch {
      throw new DriveMirrorError("mirror-unavailable");
    }
  }

  function parents(path: string, create: boolean): boolean {
    checkRoot();
    let dir = mirrorPath;
    for (const part of path.split("/").slice(0, -1)) {
      dir = join(dir, part);
      let stat;
      try {
        stat = lstatSync(dir);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        if (!create) return false;
        mkdirSync(dir);
        stat = lstatSync(dir);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DriveMirrorError("unsafe-path");
    }
    return true;
  }

  function localStat(path: string, known?: BigIntStats | null): BigIntStats | null {
    if (known === undefined && !parents(path, false)) return null;
    const stat = known === undefined ? fileStat(join(mirrorPath, ...path.split("/"))) : known;
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new DriveMirrorError("unsafe-path");
    return stat;
  }

  const assertSafePath = (path: string) => localStat(path) !== null;

  function localBytes(path: string): Buffer | null {
    return assertSafePath(path) ? readFileSync(join(mirrorPath, ...path.split("/"))) : null;
  }

  function localHash(path: string, known?: BigIntStats | null): { md5: string; size: string } | null {
    const stat = localStat(path, known);
    if (!stat) {
      hashes.delete(path);
      return null;
    }
    const cached = hashes.get(path);
    if (cached?.size === stat.size && cached.mtimeNs === stat.mtimeNs) return { md5: cached.md5, size: String(cached.size) };
    const bytes = readFileSync(join(mirrorPath, ...path.split("/")));
    const local = { md5: md5(bytes), size: String(bytes.byteLength) };
    // A same-size write within this mtime tick would look unchanged, so fresh files are hashed again next pass.
    if (bytes.byteLength === Number(stat.size) && Date.now() - Number(stat.mtimeMs) > 2_000) hashes.set(path, { size: stat.size, mtimeNs: stat.mtimeNs, md5: local.md5 });
    else hashes.delete(path);
    return local;
  }

  function ownTargetPath(path: string): string | null {
    const parts = path.split("/");
    if (parts[0] === "devices" && parts.length === 2) parts[1] = `${ids.profileDeviceId}.json`;
    else if (/^memory-v2(?: \([1-9]\d*\))?$/.test(parts[0]) && parts.length === 3) parts[2] = `${ids.memoryDeviceId}.json`;
    else if (/^threads-v2(?: \([1-9]\d*\))?$/.test(parts[0]) && parts.length === 5 && parts[4] === "head.json") parts[3] = ids.writerId;
    else if (parts[0] === "changes" && parts.length === 2) {
      const prefix = /^\d+-/.exec(parts[1])?.[0];
      if (!prefix) return null;
      parts[1] = `${prefix}${ids.profileDeviceId}${parts[1].slice(prefix.length + ids.profileDeviceId.length)}`;
    } else return null;
    const own = parts.join("/");
    return drivePathRule(own, ids) === "own" ? own : null;
  }

  function assertDownloadPath(path: string, ownPaths: string[]): void {
    assertSafePath(path);
    const target = join(mirrorPath, ...path.split("/"));
    const resolved = canonicalPath(target);
    if (drivePathRule(relative(mirrorPath, resolved).split(sep).join("/"), ids) === "own") throw new DriveMirrorError("path-alias");
    const identity = fileIdentity(target);
    const candidate = ownTargetPath(path);
    for (const own of candidate ? [...ownPaths, candidate] : ownPaths) {
      const ownTarget = join(mirrorPath, ...own.split("/"));
      if (samePath(resolved, canonicalPath(ownTarget)) || (identity && identity === fileIdentity(ownTarget))) throw new DriveMirrorError("path-alias");
    }
  }

  async function download(path: string, bytes: Buffer, once: boolean, check: () => void, ownPaths: string[]): Promise<boolean> {
    check();
    parents(path, true);
    const target = join(mirrorPath, ...path.split("/"));
    const tmp = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      check();
      assertDownloadPath(path, ownPaths);
      if (!once) await renameDriveFile(tmp, target, () => { check(); assertDownloadPath(path, ownPaths); });
      else {
        try {
          linkSync(tmp, target);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
          throw error;
        }
      }
      return true;
    } finally {
      try { unlinkSync(tmp); } catch { /* already renamed or unavailable */ }
    }
  }

  async function run(): Promise<DriveMirrorSummary> {
    checkRoot();
    // The table as read here or last written by save(); any other rewrite changes its stat.
    let checked = lstatSync(statePath, { bigint: true, throwIfNoEntry: false });
    let table = readTable(statePath);
    if (table && (table.binding.owner.issuer !== owner.issuer || table.binding.owner.sub !== owner.sub || !samePath(table.binding.mirrorPath, mirrorPath))) throw new DriveMirrorError("binding");
    if (bound && (!table || !sameBinding(table.binding, bound))) throw new DriveMirrorError(table ? "binding" : "missing-table");
    if (!table) {
      table = { version: 1, binding: { owner, rootId: null, mirrorPath, generation: 1 }, files: {}, syncedAt: now() };
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileAtomic(statePath, `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 });
    }
    let captured = structuredClone(table.binding);
    bound = structuredClone(captured);
    function check(): void {
      checkRoot();
      const stat = lstatSync(statePath, { bigint: true, throwIfNoEntry: false });
      if (stat && checked && stat.ino === checked.ino && stat.size === checked.size && stat.mtimeNs === checked.mtimeNs) return;
      const current = readTable(statePath);
      if (!current) throw new DriveMirrorError("missing-table");
      if (!sameBinding(current.binding, captured)) throw new DriveMirrorError("binding");
      checked = stat;
    }
    function save(): void {
      check();
      table!.syncedAt = now();
      writeFileAtomic(statePath, `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 });
      checked = lstatSync(statePath, { bigint: true });
    }
    const summary: DriveMirrorSummary = { uploaded: [], downloaded: [], skipped: [], conflicts: [], failed: [], duplicates: [], retryAfterMs: null, driveFull: false };
    let uploads = options.uploads ?? true;
    function held(): boolean {
      if (!uploads) summary.driveFull = true;
      return !uploads;
    }
    function rateWait(error: DriveClientError): number {
      if (error.retryAfterMs !== null) return Math.min(error.retryAfterMs, RETRY_MAX_MS);
      const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** rateStrikes);
      if (rateStrikes < 20) rateStrikes += 1;
      return wait;
    }
    async function drive<T>(work: () => Promise<T>): Promise<T | null> {
      check();
      try {
        const result = await work();
        check();
        return result;
      } catch (error) {
        check();
        if (error instanceof DriveClientError && error.rateLimited) {
          summary.retryAfterMs = rateWait(error);
          return null;
        }
        if (error instanceof DriveClientError && error.driveFull) {
          summary.driveFull = true;
          return null;
        }
        throw error;
      }
    }
    let createdThisPass = false;
    if (!table.binding.rootId) {
      const root = await drive(() => client.findOrCreateRoot());
      if (!root) return summary;
      if (root.trashed || root.mimeType !== "application/vnd.google-apps.folder" || root.appProperties?.winkRoot !== "1") throw new DriveMirrorError("invalid-remote");
      table.binding.rootId = root.id;
      save();
      captured = structuredClone(table.binding);
      bound = structuredClone(captured);
      createdThisPass = true;
    }
    const rootId = table.binding.rootId;
    if (!rootId) throw new DriveMirrorError("invalid-remote");
    let got: DriveFile;
    try {
      const found = await drive(() => client.getFile(rootId));
      if (!found) return summary;
      got = found;
    } catch (error) {
      // A 404 on the pass that just bound the root is search lag, not a lost root.
      if (error instanceof DriveClientError && error.status === 404 && createdThisPass) {
        summary.retryAfterMs = RETRY_BASE_MS;
        return summary;
      }
      if (error instanceof DriveClientError && error.status === 404) throw new DriveMirrorError("split-root");
      throw error;
    }
    if (got.trashed || got.mimeType !== "application/vnd.google-apps.folder" || got.appProperties?.winkRoot !== "1") throw new DriveMirrorError("split-root");
    const listedRoots = await drive(() => client.listRoots());
    if (!listedRoots) return summary;
    const roots = listedRoots.some((item) => item.id === rootId) ? listedRoots : [...listedRoots, got].sort((a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime) || a.id.localeCompare(b.id));
    if (roots[0]?.id !== rootId) throw new DriveMirrorError("split-root");
    if (roots.length > 1) summary.duplicates.push({ path: "", selectedId: roots[0].id, ids: roots.map((item) => item.id) });
    const remote = new Map<string, ContentFile[]>();
    const remotePaths = new Set<string>();
    const changed = new Set<string>();
    function accept(file: DriveFile): string | null {
      const path = decodeDrivePath(file.name);
      if (!path || file.trashed || file.appProperties?.ph !== drivePathHash(path) || file.mimeType === "application/vnd.google-apps.folder") {
        summary.skipped.push(path ?? file.name);
        return null;
      }
      if (process.platform === "win32" && path.split("/").some((part) => /~\d/.test(part))) throw new DriveMirrorError("path-alias");
      if (drivePathRule(path, ids) === "ignore") { summary.skipped.push(path); return null; }
      remotePaths.add(path);
      if (drivePathRule(path, ids) === "unknown") { summary.skipped.push(path); return null; }
      if (!hasContent(file)) throw new DriveMirrorError("invalid-remote");
      const copies = remote.get(path) ?? [];
      const index = copies.findIndex((copy) => copy.id === file.id);
      if (index >= 0) copies[index] = file;
      else copies.push(file);
      remote.set(path, copies);
      return path;
    }
    function drop(path: string, id: string): void {
      const copies = (remote.get(path) ?? []).filter((copy) => copy.id !== id);
      if (copies.length) remote.set(path, copies);
      else remote.delete(path);
      changed.add(path);
      remotePaths.add(path);
    }
    function tracked(): Map<string, string> {
      const byId = new Map<string, string>();
      for (const [path, entry] of Object.entries(table!.files)) if (!byId.has(entry.driveId)) byId.set(entry.driveId, path);
      return byId;
    }
    function ingestChange(change: DriveChange, byId: Map<string, string>): string | null {
      const known = byId.get(change.fileId) ?? null;
      const inside = change.parents.includes(rootId);
      if (change.file && !inside) {
        if (!known) return null;
        drop(known, change.fileId);
        return known;
      }
      if (change.removed || !change.file || change.file.trashed) {
        const path = known ?? (change.file ? decodeDrivePath(change.file.name) : null);
        if (!path || (!inside && !known)) return null;
        drop(path, change.fileId);
        return path;
      }
      const path = accept(change.file);
      if (path) changed.add(path);
      return path;
    }
    let fullList = false;
    let cursor = "";
    const savedToken = table.changeToken;
    if (savedToken) {
      try {
        const page = await drive(() => client.listChanges(savedToken));
        if (!page) { options.listed?.(null); return summary; }
        const byId = tracked();
        for (const change of page.changes) ingestChange(change, byId);
        cursor = page.newStartPageToken;
      } catch (error) {
        if (!(error instanceof DriveClientError) || error.rateLimited || (error.status !== 404 && error.status !== 410)) {
          options.listed?.(null);
          throw error;
        }
        delete table.changeToken;
        fullList = true;
      }
    } else fullList = true;
    if (fullList) {
      // Cursor from before the listing, then one catch-up, so a write during the pass is not lost.
      const token = await drive(() => client.getStartPageToken());
      if (!token) return summary;
      cursor = token;
      const files = await drive(() => client.listChildren(rootId));
      if (!files) return summary;
      for (const file of files) accept(file);
    }
    options.listed?.(remote);
    const paths = new Set([...remotePaths, ...Object.keys(table.files)]);
    let awake = performance.now();
    async function breathe(): Promise<void> {
      if (performance.now() - awake < 20) return;
      await yieldLoop();
      awake = performance.now();
    }
    const folders = new Set([""]);
    async function scan(dir: string, prefix: string): Promise<void> {
      await breathe();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.name.endsWith(".tmp")) { summary.skipped.push(path); continue; }
        if (!validPath(path) || entry.isSymbolicLink()) throw new DriveMirrorError("unsafe-path");
        if (entry.isDirectory()) {
          folders.add(path);
          await scan(join(dir, entry.name), path);
        } else if (entry.isFile()) paths.add(path);
        else throw new DriveMirrorError("unsafe-path");
      }
    }
    await scan(mirrorPath, "");

    // scan() refused links, so a scanned folder resolves to itself; identities still catch hard links and short names.
    const realRoot = canonicalPath(mirrorPath);
    const realFolders = new Map<string, string>();
    function resolveFile(path: string): string {
      const parts = path.split("/");
      const name = parts.pop()!;
      const folder = parts.join("/");
      if (folders.has(folder)) return join(realRoot, ...parts, name);
      const real = realFolders.get(folder) ?? canonicalPath(join(mirrorPath, ...parts));
      realFolders.set(folder, real);
      return join(real, name);
    }
    const names = new Set<string>();
    const resolvedPaths = new Set<string>();
    const identities = new Set<string>();
    const stats = new Map<string, BigIntStats>();
    for (const path of paths) {
      await breathe();
      const name = process.platform === "win32" ? path.toLowerCase() : path;
      const target = join(mirrorPath, ...path.split("/"));
      const resolved = resolveFile(path);
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      const stat = fileStat(target);
      if (stat) stats.set(path, stat);
      const identity = identityOf(stat);
      if (names.has(name) || resolvedPaths.has(key) || (identity && identities.has(identity))) throw new DriveMirrorError("path-alias");
      const own = ownTargetPath(path);
      if (own && drivePathRule(path, ids) !== "own") {
        const ownTarget = join(mirrorPath, ...own.split("/"));
        if (samePath(resolved, resolveFile(own)) || (identity && identity === fileIdentity(ownTarget))) throw new DriveMirrorError("path-alias");
      }
      names.add(name);
      resolvedPaths.add(key);
      if (identity) identities.add(identity);
    }
    const ownPaths = [...paths].filter((path) => drivePathRule(path, ids) === "own");

    function track(path: string, file: ContentFile): void {
      const previous = table!.files[path];
      if (previous?.driveId === file.id && previous.md5 === file.md5Checksum && previous.size === file.size) return;
      table!.files[path] = { driveId: file.id, md5: file.md5Checksum, size: file.size };
      save();
    }

    function needsWork(path: string): boolean {
      if (fullList || changed.has(path)) return true;
      const entry = table!.files[path];
      // Under a folder scan() checked, the alias check's stat stands in; a write after it shows next pass.
      const local = localHash(path, folders.has(path.slice(0, Math.max(0, path.lastIndexOf("/")))) ? stats.get(path) ?? null : undefined);
      if (!entry) return local !== null || remote.has(path);
      if (!local) return drivePathRule(path, ids) === "peer" || drivePathRule(path, ids) === "once";
      return entry.md5 !== local.md5 || entry.size !== local.size;
    }

    async function syncPath(path: string): Promise<void> {
      check();
      const rule = drivePathRule(path, ids);
      if (rule === "ignore" || rule === "unknown") { summary.skipped.push(path); return; }
      let copies = remote.get(path) ?? [];
      if (copies.length === 0) {
        const known = table!.files[path];
        const exists = assertSafePath(path);
        if (known) {
          try {
            const placed = await client.getPlaced(known.driveId);
            check();
            if (!placed.file.trashed && placed.parents.includes(rootId)) accept(placed.file);
          } catch (error) {
            check();
            // 404 means that copy is gone. A rate limit still has to stop the pass.
            if (!(error instanceof DriveClientError) || error.status !== 404) throw error;
          }
        } else if (exists && !fullList) {
          const found = await client.listNamed(rootId, encodeDrivePath(path));
          check();
          for (const file of found) accept(file);
        }
        copies = remote.get(path) ?? [];
      }
      copies.sort((a, b) => rule === "once"
        ? Date.parse(a.createdTime) - Date.parse(b.createdTime) || a.id.localeCompare(b.id)
        : Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime) || Date.parse(b.createdTime) - Date.parse(a.createdTime) || a.id.localeCompare(b.id));
      const file = copies[0];
      if (copies.length > 1 && !summary.duplicates.some((item) => item.path === path)) {
        summary.duplicates.push({ path, selectedId: file.id, ids: copies.map((copy) => copy.id) });
        if (rule === "once" && copies.some((copy) => copy.md5Checksum !== file.md5Checksum || copy.size !== file.size) && !summary.conflicts.includes(path)) summary.conflicts.push(path);
      }
      const local = localHash(path);
      if (!file) {
        if (!local) { summary.skipped.push(path); return; }
        if (held()) return;
        const bytes = localBytes(path);
        if (!bytes) { summary.skipped.push(path); return; }
        const created = await client.createFile(rootId, encodeDrivePath(path), { ph: drivePathHash(path) }, bytes);
        check();
        if (!hasContent(created) || !matches(created, bytes) || created.name !== encodeDrivePath(path) || created.appProperties?.ph !== drivePathHash(path) || created.trashed) throw new DriveMirrorError("invalid-remote");
        summary.uploaded.push(path);
        track(path, created);
      } else if (local && same(file, local)) {
        summary.skipped.push(path);
        track(path, file);
      } else if (rule === "once" && local) {
        if (!summary.conflicts.includes(path)) summary.conflicts.push(path);
      } else if (rule === "own") {
        if (!local) { summary.skipped.push(path); return; }
        if (held()) return;
        const bytes = localBytes(path);
        if (!bytes) { summary.skipped.push(path); return; }
        const updated = await client.updateMedia(file.id, bytes);
        check();
        if (!hasContent(updated) || updated.id !== file.id || !matches(updated, bytes) || updated.trashed) throw new DriveMirrorError("invalid-remote");
        summary.uploaded.push(path);
        track(path, updated);
      } else {
        const downloaded = await client.downloadFile(file.id, file.size);
        check();
        if (!matches(file, downloaded)) throw new DriveMirrorError("content-changed");
        const written = await download(path, downloaded, rule === "once", check, ownPaths);
        check();
        const current = localHash(path);
        if (current && same(file, current)) {
          if (written) summary.downloaded.push(path);
          else summary.skipped.push(path);
          track(path, file);
          if (written) options.downloaded?.(path);
        } else if (!summary.conflicts.includes(path)) summary.conflicts.push(path);
      }
    }
    const behind = new Set([...paths].filter((path) => {
      const rule = drivePathRule(path, ids);
      const copies = remote.get(path);
      return (rule === "peer" || rule === "once") && !!copies?.length && !copies.some((copy) => copy.md5Checksum === table!.files[path]?.md5);
    }));
    options.behind?.(behind);
    const landed = (path: string) => {
      if (behind.delete(path)) options.behind?.(behind);
    };
    let stopped = false;
    async function one(path: string): Promise<void> {
      await breathe();
      if (!needsWork(path)) { summary.skipped.push(path); landed(path); return; }
      try {
        await syncPath(path);
        landed(path);
      } catch (error) {
        check();
        if (error instanceof DriveClientError && error.rateLimited) {
          // Transfers in flight share one strike, or the backoff would jump by 2^8.
          if (!stopped) summary.retryAfterMs = rateWait(error);
          stopped = true;
          return;
        }
        if (error instanceof DriveClientError && error.driveFull) {
          summary.driveFull = true;
          uploads = false;
          return;
        }
        if (!(error instanceof DriveClientError) || (error.status >= 200 && error.status < 300)) throw error;
        summary.failed.push(path);
      }
    }
    // One priority tier at a time; a throw still waits for the rest in flight so no save lands after the pass.
    async function each(items: Iterable<string>): Promise<void> {
      const tiers = new Map<number, string[]>();
      for (const path of [...items].sort((a, b) => priority(a, options.chatFirst, options.openThread) - priority(b, options.chatFirst, options.openThread) || a.localeCompare(b))) {
        const tier = tiers.get(priority(path, options.chatFirst, options.openThread));
        if (tier) tier.push(path);
        else tiers.set(priority(path, options.chatFirst, options.openThread), [path]);
      }
      const thrown: unknown[] = [];
      for (const tier of tiers.values()) {
        const worker = async () => {
          while (tier.length > 0 && !stopped && thrown.length === 0) {
            try {
              await one(tier.shift()!);
            } catch (error) {
              thrown.push(error);
            }
          }
        };
        await Promise.all(Array.from({ length: TRANSFERS_AT_ONCE }, worker));
        if (thrown.length > 0) throw thrown[0];
        if (stopped) return;
      }
    }
    await each(paths);
    if (stopped) return summary;
    if (fullList && summary.failed.length === 0) {
      const page = await drive(() => client.listChanges(cursor)).catch((error) => { options.listed?.(null); throw error; });
      if (!page) { options.listed?.(null); return summary; }
      const again: string[] = [];
      const byId = tracked();
      for (const change of page.changes) {
        const path = ingestChange(change, byId);
        if (path) again.push(path);
      }
      cursor = page.newStartPageToken;
      options.listed?.(remote);
      await each(new Set(again));
      if (stopped) return summary;
    }
    function remember(token: string): void {
      if (summary.retryAfterMs !== null || !token) return;
      if (summary.failed.length > 0) {
        if (table!.changeToken !== undefined) {
          delete table!.changeToken;
          save();
        }
        return;
      }
      // A held upload keeps the old cursor, so its changes come back next pass.
      if (summary.driveFull) return;
      if (table!.changeToken === token) return;
      table!.changeToken = token;
      save();
    }
    remember(cursor);
    if (summary.retryAfterMs === null) rateStrikes = 0;
    check();
    summary.skipped = [...new Set(summary.skipped)];
    return summary;
  }

  return {
    syncOnce() {
      if (inflight) return inflight;
      if (passes.has(statePath)) return Promise.reject(new DriveMirrorError("busy"));
      passes.add(statePath);
      inflight = run().finally(() => { inflight = null; passes.delete(statePath); });
      return inflight;
    },
  };
}

function hasContent(file: DriveFile): file is ContentFile {
  return file.md5Checksum !== undefined && file.size !== undefined;
}

function matches(file: ContentFile, bytes: Uint8Array): boolean {
  return same(file, { md5: md5(bytes), size: String(bytes.byteLength) });
}

function same(file: ContentFile, local: { md5: string; size: string }): boolean {
  return file.md5Checksum === local.md5 && file.size === local.size;
}
