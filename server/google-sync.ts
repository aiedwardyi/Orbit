// Google sync: binds this PC to one Google account, joins that account's
// Drive folder through the mirror, and only then points the sync engines at
// the mirror folder. The mirror folder and its table are never deleted or
// recreated here; a missing or unreadable binding stops transfer for good.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { createDriveClient, DriveClientError, type DriveClient } from "./drive-client.ts";
import { createDriveMirror, decodeDrivePath, DriveMirrorError, drivePathRule, type DriveHashes, type DriveMirrorSummary } from "./drive-mirror.ts";
import { readDriveOwnIds, type DriveOwnIds } from "./drive-own-ids.ts";
import { GoogleAccountError, type GoogleAccountStatus } from "./google-account.ts";
import { lateTick } from "./pc-wake.ts";
import { PROFILE_SYNC_WORKSPACE_FILE, readSyncOperations } from "./profile-sync.ts";
import { syncHold } from "./sync-hold.ts";

export const GOOGLE_BINDING_FILE = "google-binding.json";
export const GOOGLE_MIRROR_DIR = "google-drive";
export const GOOGLE_TABLE_FILE = "google-drive-table.json";
// Written once the engines republished into the mirror; a ready PC without it (1.0.170) republishes on resume.
export const GOOGLE_REPUBLISHED_FILE = "google-drive-republished.json";
// The folder a Move copied from; never a binding or profile-sync.json field, which 1.0.170 reads strictly.
export const GOOGLE_MOVE_FILE = "google-move.json";
const OTHER_WORKSPACE = "This Google account syncs other Wink data.";
const ISSUER = "https://accounts.google.com";
const PASS_MS = 30_000;
const REPUBLISH_MS = 1_000;
const FULL_MS = 5 * 60_000;
const FULL_MAX_MS = 30 * 60_000;
const OPERATION_FILE = /^changes\/\d+-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:json|notes|paths|pin)$/;

export type GoogleSyncState = "unavailable" | "signed-out" | "ready" | "joining" | "syncing" | "up-to-date" | "offline" | "drive-full" | "needs-sign-in" | "blocked" | "other-account" | "folder" | "error";
export interface GoogleSyncStatus {
  state: GoogleSyncState;
  email: string | null;
  boundEmail: string | null;
  join: { first: boolean; pcs: number } | null;
  progress: { done: number; total: number } | null;
  lastSyncAt: number | null;
  move?: true;
  problem?: string;
}

const bindingSchema = z.object({
  version: z.literal(1),
  spaceId: z.string().min(1),
  owner: z.object({ issuer: z.literal(ISSUER), sub: z.string().min(1) }).strict(),
  emailHint: z.string(),
  transport: z.literal("google-drive"),
  rootId: z.string().min(1).nullable(),
  mirrorPath: z.string().min(1),
  transportStatePath: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  heldBots: z.array(z.string()),
  phase: z.enum(["joining", "ready"]),
}).strict();
export type GoogleBinding = z.infer<typeof bindingSchema>;
type BindingRead = { kind: "none" } | { kind: "ok"; binding: GoogleBinding } | { kind: "corrupt" };

export interface GoogleSyncAccount {
  status(): GoogleAccountStatus;
  owner(): { sub: string; email: string } | null;
  getAccessToken(): Promise<string>;
  onSession(listener: () => void): () => void;
}

type Options = {
  dataDir: string;
  account: GoogleSyncAccount;
  /** The profile-sync folder; anything but the mirror folder is the old folder mode. */
  folder: () => string | null;
  /** Mints the engine identities the mirror needs, without pointing any engine at a folder. */
  prepare: () => void;
  /** Local bots nobody has talked to yet. */
  unusedBots: () => string[];
  /** Points the engines at the mirror folder with chats on and republishes what it lacks, unless a Move copied it all; returns the workspace id. */
  activate: (mirrorPath: string, move: boolean) => string;
  /** The engines are still writing what activate republished. */
  republishing?: () => boolean;
  /** Pulls a chat whose peer head a pass just downloaded. */
  pull?: (threadId: string) => void;
  openThread?: () => string | null;
  ownIds?: () => DriveOwnIds;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  passMs?: number;
};

const tableSchema = z.object({ binding: z.object({ rootId: z.string().min(1).nullable() }), files: z.record(z.string(), z.object({})) });
const retrySchema = z.object({ retryAfterMs: z.number().int().positive() });
const moveSchema = z.object({ from: z.string().min(1), at: z.number() }).strict();
const workspaceSchema = z.object({ workspaceId: z.string() });
const startSchema = z.object({ move: z.boolean().optional() });
type StartBody = z.infer<typeof startSchema>;
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

export function readGoogleBinding(dataDir: string): BindingRead {
  const path = join(dataDir, GOOGLE_BINDING_FILE);
  if (!existsSync(path)) return { kind: "none" };
  try {
    const parsed = bindingSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? { kind: "ok", binding: parsed.data } : { kind: "corrupt" };
  } catch {
    return { kind: "corrupt" };
  }
}

function writeGoogleBinding(dataDir: string, binding: GoogleBinding): void {
  writeFileAtomic(join(dataDir, GOOGLE_BINDING_FILE), `${JSON.stringify(bindingSchema.parse(binding), null, 2)}\n`, { mode: 0o600 });
}

async function mirrorFiles(dir: string, prefix = ""): Promise<string[]> {
  if (!existsSync(dir)) return [];
  await yieldLoop();
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await mirrorFiles(join(dir, entry.name), path));
    else if (entry.isFile() && !entry.name.endsWith(".tmp")) files.push(path);
  }
  return files;
}

function workspaceId(bytes: Buffer): string | null {
  try {
    return workspaceSchema.parse(JSON.parse(bytes.toString("utf8"))).workspaceId;
  } catch {
    return null;
  }
}

const peerHead = (path: string, ids: DriveOwnIds) => path.startsWith("threads-v2") && path.endsWith("/head.json") && drivePathRule(path, ids) === "peer" ? [path.split("/")[2]] : [];
const blocksJoin = (path: string) => path === PROFILE_SYNC_WORKSPACE_FILE || path.startsWith("changes/") || path.startsWith("devices/");

export function createGoogleSync(options: Options) {
  const { dataDir, account } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const passMs = options.passMs ?? PASS_MS;
  const statePath = join(dataDir, GOOGLE_TABLE_FILE);
  const republishedPath = join(dataDir, GOOGLE_REPUBLISHED_FILE);
  const movePath = join(dataDir, GOOGLE_MOVE_FILE);
  const client: DriveClient = createDriveClient({ getAccessToken: () => account.getAccessToken(), fetch: options.fetch });
  const ownIds = options.ownIds ?? (() => readDriveOwnIds(dataDir));
  const hashes: DriveHashes = new Map();
  let binding = readGoogleBinding(dataDir);
  let joinInfo: { sub: string; value: GoogleSyncStatus["join"]; problem?: string } | null = null;
  let lastSyncAt: number | null = null;
  let catching = false;
  let total = 0;
  let problem: "offline" | "error" | null = null;
  // Uploads wait for Drive space until uploadAt; downloads keep the normal pace.
  let fullStrikes = 0;
  let uploadAt = 0;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let soon = false;
  let stopped = false;
  let chatFirst = true;

  const mirrorPath = () => {
    const path = join(dataDir, GOOGLE_MIRROR_DIR);
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  syncHold.google(mirrorPath());
  function readMove(): z.infer<typeof moveSchema> | null {
    try {
      return moveSchema.parse(JSON.parse(readFileSync(movePath, "utf8")));
    } catch {
      return null;
    }
  }
  // A Move joins while the engines still write the folder it copies from.
  const moving = () => binding.kind === "ok" && binding.binding.phase === "joining" ? readMove() : null;
  const folderMode = () => {
    const folder = options.folder();
    if (!folder || samePath(folder, mirrorPath())) return false;
    const move = moving();
    return !move || !samePath(folder, move.from);
  };
  // A bound PC whose table is gone, or a table with no binding, must not be read as a fresh start.
  const lost = () => binding.kind === "corrupt"
    || (binding.kind === "none" && existsSync(statePath))
    || (binding.kind === "ok" && (!samePath(binding.binding.mirrorPath, mirrorPath()) || !samePath(binding.binding.transportStatePath, statePath)
      || (binding.binding.phase === "ready" && !existsSync(statePath))));

  function readTable(): z.infer<typeof tableSchema> | null {
    try {
      return tableSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
    } catch {
      return null;
    }
  }

  function progress(): GoogleSyncStatus["progress"] {
    const done = Object.keys(readTable()?.files ?? {}).length;
    return { done, total: Math.max(total, done) };
  }

  function status(): GoogleSyncStatus {
    const accountStatus = account.status();
    const owner = accountStatus.state === "pending" || accountStatus.state === "signed-out" ? null : account.owner();
    const bound = binding.kind === "ok" ? binding.binding : null;
    const base: GoogleSyncStatus = { state: "error", email: owner?.email ?? null, boundEmail: bound?.emailHint ?? null, join: null, progress: null, lastSyncAt };
    if (accountStatus.state === "unavailable") return { ...base, state: "unavailable" };
    if (folderMode()) {
      if (bound || lost() || accountStatus.state !== "signed-in" || !owner) return { ...base, state: "folder" };
      const preview = joinInfo?.sub === owner.sub ? joinInfo : null;
      const ready: GoogleSyncStatus = { ...base, state: "ready", join: preview?.value ?? null, move: true };
      if (preview?.problem) ready.problem = preview.problem;
      return ready;
    }
    if (lost()) return base;
    if (!owner) return { ...base, state: "signed-out" };
    if (bound && bound.owner.sub !== owner.sub) return { ...base, state: "other-account" };
    if (accountStatus.state === "needs-sign-in" || accountStatus.state === "blocked") return { ...base, state: accountStatus.state };
    if (!bound) return { ...base, state: "ready", join: joinInfo?.sub === owner.sub ? joinInfo.value : null };
    if (problem === "error") return base;
    if (bound.phase === "joining") {
      const joining: GoogleSyncStatus = fullStrikes ? { ...base, state: "drive-full" } : { ...base, state: "joining", progress: progress() };
      if (moving()) joining.move = true;
      return joining;
    }
    if (problem === "offline" || accountStatus.state === "offline") return { ...base, state: "offline" };
    if (fullStrikes) return { ...base, state: "drive-full" };
    if (catching || lastSyncAt === null) return { ...base, state: "syncing", progress: catching ? progress() : null };
    return { ...base, state: "up-to-date" };
  }

  /** False when Drive could not be read or, for a Move, holds another workspace. */
  async function preview(sub: string): Promise<boolean> {
    try {
      const [root] = await client.listRoots();
      if (!root) {
        joinInfo = { sub, value: { first: true, pcs: 0 } };
        return true;
      }
      const files = (await client.listChildren(root.id)).filter((file) => !file.trashed);
      const paths = files.map((file) => decodeDrivePath(file.name));
      const folder = options.folder();
      if (folderMode() && folder) {
        let ours: string | null = null;
        try {
          ours = workspaceId(readFileSync(join(folder, PROFILE_SYNC_WORKSPACE_FILE)));
        } catch {}
        for (const file of files.filter((file) => decodeDrivePath(file.name) === PROFILE_SYNC_WORKSPACE_FILE)) {
          if (!ours || workspaceId(await client.downloadFile(file.id, file.size)) !== ours) {
            joinInfo = { sub, value: null, problem: OTHER_WORKSPACE };
            return false;
          }
        }
      }
      const devices = new Set(paths.flatMap((path) => OPERATION_FILE.exec(path ?? "")?.[1] ?? []));
      joinInfo = { sub, value: { first: !paths.includes(PROFILE_SYNC_WORKSPACE_FILE), pcs: devices.size } };
      return true;
    } catch (error) {
      if (!(error instanceof GoogleAccountError)) log(`[google-sync] join preview failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function read(): Promise<GoogleSyncStatus> {
    const current = status();
    const owner = account.owner();
    if (current.state === "ready" && !current.join && owner) {
      await preview(owner.sub);
      return status();
    }
    return current;
  }

  function runnable(): GoogleBinding | null {
    if (stopped || binding.kind !== "ok" || lost() || folderMode()) return null;
    const accountStatus = account.status();
    if (accountStatus.state !== "signed-in" && accountStatus.state !== "offline") return null;
    return account.owner()?.sub === binding.binding.owner.sub ? binding.binding : null;
  }

  function schedule(ms: number): void {
    clearTimeout(timer);
    timer = undefined;
    soon = false;
    if (!runnable()) return;
    soon = ms === 0;
    const due = now() + ms;
    timer = setTimeout(() => {
      timer = undefined;
      soon = false;
      if (lateTick(due, ms, now())) chatFirst = true;
      void kick();
    }, ms);
    timer.unref?.();
  }

  function activate(mirror: string, move = false): string {
    const workspaceId = options.activate(mirror, move);
    writeFileAtomic(republishedPath, `${JSON.stringify({ version: 1 })}\n`);
    return workspaceId;
  }

  /** Copies folder files the mirror lacks, plus this PC's own files when own is set; never writes the folder. */
  function copyFolder(from: string, mirror: string, own: boolean): void {
    const ids = ownIds();
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), path);
          continue;
        }
        const rule = drivePathRule(path, ids);
        if (!entry.isFile() || rule === "ignore" || rule === "unknown") continue;
        const target = join(mirror, ...path.split("/"));
        if (existsSync(target) && !(own && rule === "own")) continue;
        const temp = `${target}.${randomUUID()}.tmp`;
        mkdirSync(dirname(target), { recursive: true });
        try {
          copyFileSync(join(dir, entry.name), temp);
          renameSync(temp, target);
        } catch (error) {
          rmSync(temp, { force: true });
          // The engines may replace or remove a file between the listing and the copy.
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
    };
    walk(from, "");
  }

  function finishJoin(bound: GoogleBinding): void {
    const ops = readSyncOperations(bound.mirrorPath).operations;
    const heldBots = ops.some((op) => op.entity === "bot") ? options.unusedBots() : [];
    // Holds must be on disk before the engines can publish.
    const holding = { ...bound, heldBots };
    writeGoogleBinding(dataDir, holding);
    binding = { kind: "ok", binding: holding };
    const move = readMove();
    // Same tick as activate: what the folder gained during the join, and this PC's newest own files.
    if (move) copyFolder(move.from, bound.mirrorPath, true);
    const workspaceId = activate(bound.mirrorPath, !!move);
    const ready: GoogleBinding = { ...holding, phase: "ready", rootId: readTable()?.binding.rootId ?? null, workspaceId };
    writeGoogleBinding(dataDir, ready);
    binding = { kind: "ok", binding: ready };
  }

  async function pass(bound: GoogleBinding): Promise<number> {
    const owner = { issuer: ISSUER, sub: bound.owner.sub } as const;
    let summary: DriveMirrorSummary;
    let ids: DriveOwnIds;
    // A republish that ends mid-pass may have written files after the scan.
    const busy = options.republishing?.() ?? false;
    const uploads = now() >= uploadAt;
    let listed = false;
    try {
      options.prepare();
      if (catching && !total) {
        const [root] = await client.listRoots();
        const remote = root ? (await client.listChildren(root.id)).flatMap((file) => decodeDrivePath(file.name) ?? []) : [];
        total = new Set([...remote, ...await mirrorFiles(bound.mirrorPath)]).size;
      }
      ids = ownIds();
      summary = await createDriveMirror({
        owner, mirrorPath: bound.mirrorPath, statePath, ownIds: ids, client, now, uploads, hashes, chatFirst,
        openThread: chatFirst ? options.openThread?.() : null,
        listed: (files) => {
          listed = true;
          syncHold.feed(bound.mirrorPath, runnable() ? files : null, ids);
        },
        downloaded: (path) => {
          if (bound.phase !== "ready") return;
          for (const threadId of peerHead(path, ids)) options.pull?.(threadId);
        },
      }).syncOnce();
      if (!listed) syncHold.google(bound.mirrorPath);
    } catch (error) {
      if (!listed) syncHold.google(bound.mirrorPath);
      const offline = error instanceof GoogleAccountError || (error instanceof DriveClientError && (error.status === 0 || error.status >= 500 || error.status === 429));
      problem = offline ? "offline" : "error";
      if (!offline) log(`[google-sync] pass stopped: ${error instanceof DriveMirrorError ? error.problem : error instanceof Error ? error.message : String(error)}`);
      return passMs;
    }
    problem = null;
    lastSyncAt = now();
    if (summary.retryAfterMs === null && !summary.failed.some((path) => path.startsWith("threads-v2"))) chatFirst = false;
    if (!summary.driveFull) {
      fullStrikes = 0;
      uploadAt = 0;
    } else if (uploads) {
      uploadAt = now() + Math.min(FULL_MAX_MS, FULL_MS * 2 ** fullStrikes);
      fullStrikes = Math.min(fullStrikes + 1, 3);
    }
    const moved = summary.uploaded.length + summary.downloaded.length;
    // A rate-limited pass stops early, so moving nothing does not mean the mirror caught up.
    const retry = retrySchema.safeParse(summary);
    if (bound.phase === "joining" && moved === 0 && !retry.success && !summary.driveFull && !summary.failed.some(blocksJoin)) {
      finishJoin(bound);
      catching = true;
      total = 0;
      return 0;
    }
    const republishing = busy || (options.republishing?.() ?? false);
    catching = moved > 0 || summary.failed.length > 0 || retry.success || republishing;
    if (!catching) total = 0;
    if (retry.success) return retry.data.retryAfterMs;
    return moved > 0 ? 0 : republishing ? REPUBLISH_MS : passMs;
  }

  function kick(): Promise<void> {
    if (running) return running;
    const bound = runnable();
    if (!bound) {
      syncHold.google(mirrorPath());
      schedule(0);
      return Promise.resolve();
    }
    clearTimeout(timer);
    timer = undefined;
    soon = false;
    running = (async () => {
      let delay = passMs;
      try {
        delay = await pass(bound);
      } catch (error) {
        problem = "error";
        log(`[google-sync] pass failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      running = null;
      schedule(delay);
    })();
    return running;
  }

  async function start({ move = false }: { move?: boolean } = {}): Promise<{ status: number; body: GoogleSyncStatus }> {
    const current = await read();
    const owner = account.owner();
    const from = options.folder();
    if (current.state !== "ready" || !owner || binding.kind !== "none" || move !== folderMode()) return { status: 409, body: status() };
    const dir = join(dataDir, GOOGLE_MIRROR_DIR);
    if (move && from) {
      options.prepare();
      if (!await preview(owner.sub)) return { status: 409, body: status() };
      mkdirSync(dir, { recursive: true });
      copyFolder(from, realpathSync(dir), false);
      writeFileAtomic(movePath, `${JSON.stringify({ from, at: now() })}\n`);
    } else rmSync(movePath, { force: true });
    mkdirSync(dir, { recursive: true });
    const joining: GoogleBinding = {
      version: 1, spaceId: randomUUID(), owner: { issuer: ISSUER, sub: owner.sub }, emailHint: owner.email, transport: "google-drive",
      rootId: null, mirrorPath: realpathSync(dir), transportStatePath: statePath, workspaceId: null, heldBots: [], phase: "joining",
    };
    writeGoogleBinding(dataDir, joining);
    binding = { kind: "ok", binding: joining };
    catching = true;
    total = 0;
    void kick();
    return { status: 200, body: status() };
  }

  const unsubscribe = account.onSession(() => {
    syncHold.google(mirrorPath());
    catching = runnable() !== null;
    total = 0;
    problem = null;
    void kick();
  });
  if (binding.kind === "corrupt") log("[google-sync] google-binding.json is unreadable; Google sync is paused");

  return {
    status,
    read,
    start,
    kick,
    /** Settles once no pass is running or due right away. */
    idle: async () => { while (running || soon) await (running ?? new Promise((done) => setTimeout(done, 1))); },
    held: (botId: string) => binding.kind === "ok" && binding.binding.heldBots.includes(botId),
    /** A bound, ready PC whose engines lost the mirror folder, or never republished into it, points them back at it. */
    resume(): void {
      const bound = binding.kind === "ok" ? binding.binding : null;
      if (bound?.phase === "ready" && !lost() && !folderMode() && (!options.folder() || !existsSync(republishedPath))) activate(bound.mirrorPath);
      catching = runnable() !== null;
      chatFirst = true;
      void kick();
    },
    stop(): void {
      syncHold.google(mirrorPath());
      stopped = true;
      soon = false;
      unsubscribe();
      clearTimeout(timer);
    },
  };
}
export type GoogleSync = ReturnType<typeof createGoogleSync>;

/** Signed-in phones may read status; starting sync requires the desktop bearer. */
export async function googleSyncRoute(
  method: string, path: string, caller: { relay: boolean; bearerOk: boolean; phoneSession?: boolean; remoteCookie?: boolean }, sync: Pick<GoogleSync, "read" | "start">, body: () => Promise<StartBody> = async () => ({}),
) {
  if (path !== "/api/google-sync" && path !== "/api/google-sync/start") return null;
  if (caller.relay ? !caller.phoneSession : !(caller.bearerOk || caller.remoteCookie)) return { status: 404, body: { error: "not found" } };
  if (method === "GET" && path === "/api/google-sync") return { status: 200, body: await sync.read() };
  if (caller.relay || !caller.bearerOk) return { status: 404, body: { error: "not found" } };
  if (method === "POST" && path === "/api/google-sync/start") {
    const parsed = startSchema.safeParse(await body());
    return parsed.success ? sync.start(parsed.data) : { status: 400, body: { error: "invalid body" } };
  }
  return { status: 405, body: { error: "method not allowed" } };
}
