import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
}

type Options = { owner: DriveOwner; mirrorPath: string; statePath: string; ownIds: DriveOwnIds; client: DriveClient; now?: () => number };
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
  if (root === "changes" && parts.length === 2 && /^\d+-[A-Za-z0-9._-]+\.json$/.test(parts[1])) {
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

function priority(path: string): number {
  if (path === "workspace.json") return 0;
  if (path.startsWith("assets/")) return 1;
  if (path.startsWith("pictures/")) return 2;
  if (/\/seg-[1-9]\d*-[1-9]\d*\.json\.gz$/.test(path)) return 3;
  if (path.startsWith("changes/")) return 4;
  if (/^memory-v2(?: \([1-9]\d*\))?\//.test(path)) return 6;
  if (path.endsWith("/head.json")) return 7;
  if (path.startsWith("devices/")) return 8;
  return 5;
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

function fileIdentity(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

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

  function assertSafePath(path: string): boolean {
    if (!parents(path, false)) return false;
    const target = join(mirrorPath, ...path.split("/"));
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new DriveMirrorError("unsafe-path");
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  function localBytes(path: string): Buffer | null {
    return assertSafePath(path) ? readFileSync(join(mirrorPath, ...path.split("/"))) : null;
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
      const current = readTable(statePath);
      if (!current) throw new DriveMirrorError("missing-table");
      if (!sameBinding(current.binding, captured)) throw new DriveMirrorError("binding");
    }
    function save(): void {
      check();
      table!.syncedAt = now();
      writeFileAtomic(statePath, `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 });
    }
    const summary: DriveMirrorSummary = { uploaded: [], downloaded: [], skipped: [], conflicts: [], failed: [], duplicates: [], retryAfterMs: null };
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
    function ingestChange(change: DriveChange): string | null {
      const known = Object.entries(table!.files).find(([, entry]) => entry.driveId === change.fileId)?.[0] ?? null;
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
        if (!page) return summary;
        for (const change of page.changes) ingestChange(change);
        cursor = page.newStartPageToken;
      } catch (error) {
        if (!(error instanceof DriveClientError) || error.rateLimited || (error.status !== 404 && error.status !== 410)) throw error;
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
    const paths = new Set([...remotePaths, ...Object.keys(table.files)]);
    function scan(dir: string, prefix: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.name.endsWith(".tmp")) { summary.skipped.push(path); continue; }
        if (!validPath(path) || entry.isSymbolicLink()) throw new DriveMirrorError("unsafe-path");
        if (entry.isDirectory()) scan(join(dir, entry.name), path);
        else if (entry.isFile()) paths.add(path);
        else throw new DriveMirrorError("unsafe-path");
      }
    }
    scan(mirrorPath, "");

    const names = new Set<string>();
    const resolvedPaths = new Set<string>();
    const identities = new Set<string>();
    for (const path of paths) {
      const name = process.platform === "win32" ? path.toLowerCase() : path;
      const target = join(mirrorPath, ...path.split("/"));
      const resolved = canonicalPath(target);
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      const identity = fileIdentity(target);
      if (names.has(name) || resolvedPaths.has(key) || (identity && identities.has(identity))) throw new DriveMirrorError("path-alias");
      const own = ownTargetPath(path);
      if (own && drivePathRule(path, ids) !== "own") {
        const ownTarget = join(mirrorPath, ...own.split("/"));
        if (samePath(resolved, canonicalPath(ownTarget)) || (identity && identity === fileIdentity(ownTarget))) throw new DriveMirrorError("path-alias");
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
      const bytes = localBytes(path);
      if (!entry) return bytes !== null || remote.has(path);
      if (!bytes) return drivePathRule(path, ids) === "peer" || drivePathRule(path, ids) === "once";
      return entry.md5 !== md5(bytes) || entry.size !== String(bytes.byteLength);
    }

    async function syncPath(path: string): Promise<void> {
      check();
      const rule = drivePathRule(path, ids);
      if (rule === "ignore" || rule === "unknown") { summary.skipped.push(path); return; }
      let copies = remote.get(path) ?? [];
      if (copies.length === 0) {
        const known = table!.files[path];
        const bytes = localBytes(path);
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
        } else if (bytes && !fullList) {
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
      const bytes = localBytes(path);
      if (!file) {
        if (!bytes) { summary.skipped.push(path); return; }
        const created = await client.createFile(rootId, encodeDrivePath(path), { ph: drivePathHash(path) }, bytes);
        check();
        if (!hasContent(created) || !matches(created, bytes) || created.name !== encodeDrivePath(path) || created.appProperties?.ph !== drivePathHash(path) || created.trashed) throw new DriveMirrorError("invalid-remote");
        summary.uploaded.push(path);
        track(path, created);
      } else if (bytes && matches(file, bytes)) {
        summary.skipped.push(path);
        track(path, file);
      } else if (rule === "once" && bytes) {
        if (!summary.conflicts.includes(path)) summary.conflicts.push(path);
      } else if (rule === "own") {
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
        const current = localBytes(path);
        if (current && matches(file, current)) {
          if (written) summary.downloaded.push(path);
          else summary.skipped.push(path);
          track(path, file);
        } else if (!summary.conflicts.includes(path)) summary.conflicts.push(path);
      }
    }
    let stopped = false;
    async function one(path: string): Promise<void> {
      if (!needsWork(path)) { summary.skipped.push(path); return; }
      try {
        await syncPath(path);
      } catch (error) {
        check();
        if (error instanceof DriveClientError && error.rateLimited) {
          summary.retryAfterMs = rateWait(error);
          stopped = true;
          return;
        }
        if (!(error instanceof DriveClientError) || (error.status >= 200 && error.status < 300)) throw error;
        summary.failed.push(path);
      }
    }
    const ordered = (items: Iterable<string>) => [...items].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    for (const path of ordered(paths)) {
      await one(path);
      if (stopped) return summary;
    }
    if (fullList && summary.failed.length === 0) {
      const page = await drive(() => client.listChanges(cursor));
      if (!page) return summary;
      const again: string[] = [];
      for (const change of page.changes) {
        const path = ingestChange(change);
        if (path) again.push(path);
      }
      cursor = page.newStartPageToken;
      for (const path of ordered(new Set(again))) {
        await one(path);
        if (stopped) return summary;
      }
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
  return file.md5Checksum === md5(bytes) && file.size === String(bytes.byteLength);
}
