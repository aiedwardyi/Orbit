// Google sync: binds this PC to one Google account, joins that account's
// Drive folder through the mirror, and only then points the sync engines at
// the mirror folder. The mirror folder and its table are never deleted or
// recreated here; a missing or unreadable binding stops transfer for good.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { createDriveClient, DriveClientError, type DriveClient } from "./drive-client.ts";
import { createDriveMirror, decodeDrivePath, DriveMirrorError, type DriveMirrorSummary } from "./drive-mirror.ts";
import { readDriveOwnIds, type DriveOwnIds } from "./drive-own-ids.ts";
import { GoogleAccountError, type GoogleAccountStatus } from "./google-account.ts";
import { PROFILE_SYNC_WORKSPACE_FILE, readSyncOperations } from "./profile-sync.ts";

export const GOOGLE_BINDING_FILE = "google-binding.json";
export const GOOGLE_MIRROR_DIR = "google-drive";
export const GOOGLE_TABLE_FILE = "google-drive-table.json";
const ISSUER = "https://accounts.google.com";
const PASS_MS = 30_000;
const OPERATION_FILE = /^changes\/\d+-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

export type GoogleSyncState = "unavailable" | "signed-out" | "ready" | "joining" | "syncing" | "up-to-date" | "offline" | "needs-sign-in" | "blocked" | "other-account" | "folder" | "error";
export interface GoogleSyncStatus {
  state: GoogleSyncState;
  email: string | null;
  boundEmail: string | null;
  join: { first: boolean; pcs: number } | null;
  progress: { done: number; total: number } | null;
  lastSyncAt: number | null;
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
  /** Points the engines at the mirror folder with chats on; returns the workspace id. */
  activate: (mirrorPath: string) => string;
  ownIds?: () => DriveOwnIds;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  passMs?: number;
};

const tableSchema = z.object({ binding: z.object({ rootId: z.string().min(1).nullable() }), files: z.record(z.string(), z.object({})) });
const retrySchema = z.object({ retryAfterMs: z.number().int().positive() });
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

function mirrorFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return mirrorFiles(join(dir, entry.name), path);
    return entry.isFile() && !entry.name.endsWith(".tmp") ? [path] : [];
  });
}

const blocksJoin = (path: string) => path === PROFILE_SYNC_WORKSPACE_FILE || path.startsWith("changes/") || path.startsWith("devices/");

export function createGoogleSync(options: Options) {
  const { dataDir, account } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const passMs = options.passMs ?? PASS_MS;
  const statePath = join(dataDir, GOOGLE_TABLE_FILE);
  const client: DriveClient = createDriveClient({ getAccessToken: () => account.getAccessToken(), fetch: options.fetch });
  const ownIds = options.ownIds ?? (() => readDriveOwnIds(dataDir));
  let binding = readGoogleBinding(dataDir);
  let joinInfo: { sub: string; value: GoogleSyncStatus["join"] } | null = null;
  let lastSyncAt: number | null = null;
  let catching = false;
  let total = 0;
  let problem: "offline" | "error" | null = null;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let soon = false;
  let stopped = false;

  const mirrorPath = () => {
    const path = join(dataDir, GOOGLE_MIRROR_DIR);
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const folderMode = () => {
    const folder = options.folder();
    return !!folder && !samePath(folder, mirrorPath());
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
    if (folderMode()) return { ...base, state: "folder" };
    if (lost()) return base;
    if (!owner) return { ...base, state: "signed-out" };
    if (bound && bound.owner.sub !== owner.sub) return { ...base, state: "other-account" };
    if (accountStatus.state === "needs-sign-in" || accountStatus.state === "blocked") return { ...base, state: accountStatus.state };
    if (!bound) return { ...base, state: "ready", join: joinInfo?.sub === owner.sub ? joinInfo.value : null };
    if (problem === "error") return base;
    if (bound.phase === "joining") return { ...base, state: "joining", progress: progress() };
    if (problem === "offline" || accountStatus.state === "offline") return { ...base, state: "offline" };
    if (catching || lastSyncAt === null) return { ...base, state: "syncing", progress: catching ? progress() : null };
    return { ...base, state: "up-to-date" };
  }

  async function preview(sub: string): Promise<void> {
    try {
      const [root] = await client.listRoots();
      if (!root) {
        joinInfo = { sub, value: { first: true, pcs: 0 } };
        return;
      }
      const paths = (await client.listChildren(root.id)).filter((file) => !file.trashed).map((file) => decodeDrivePath(file.name));
      const devices = new Set(paths.flatMap((path) => OPERATION_FILE.exec(path ?? "")?.[1] ?? []));
      joinInfo = { sub, value: { first: !paths.includes(PROFILE_SYNC_WORKSPACE_FILE), pcs: devices.size } };
    } catch (error) {
      if (!(error instanceof GoogleAccountError)) log(`[google-sync] join preview failed: ${error instanceof Error ? error.message : String(error)}`);
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
    timer = setTimeout(() => {
      timer = undefined;
      soon = false;
      void kick();
    }, ms);
    timer.unref?.();
  }

  function finishJoin(bound: GoogleBinding): void {
    const ops = readSyncOperations(bound.mirrorPath).operations;
    const heldBots = ops.some((op) => op.entity === "bot") ? options.unusedBots() : [];
    // Holds must be on disk before the engines can publish.
    const holding = { ...bound, heldBots };
    writeGoogleBinding(dataDir, holding);
    binding = { kind: "ok", binding: holding };
    const workspaceId = options.activate(bound.mirrorPath);
    const ready: GoogleBinding = { ...holding, phase: "ready", rootId: readTable()?.binding.rootId ?? null, workspaceId };
    writeGoogleBinding(dataDir, ready);
    binding = { kind: "ok", binding: ready };
  }

  async function pass(bound: GoogleBinding): Promise<number> {
    const owner = { issuer: ISSUER, sub: bound.owner.sub } as const;
    let summary: DriveMirrorSummary;
    try {
      options.prepare();
      if (catching && !total) {
        const [root] = await client.listRoots();
        const remote = root ? (await client.listChildren(root.id)).flatMap((file) => decodeDrivePath(file.name) ?? []) : [];
        total = new Set([...remote, ...mirrorFiles(bound.mirrorPath)]).size;
      }
      summary = await createDriveMirror({ owner, mirrorPath: bound.mirrorPath, statePath, ownIds: ownIds(), client, now }).syncOnce();
    } catch (error) {
      const offline = error instanceof GoogleAccountError || (error instanceof DriveClientError && (error.status === 0 || error.status >= 500 || error.status === 429));
      problem = offline ? "offline" : "error";
      if (!offline) log(`[google-sync] pass stopped: ${error instanceof DriveMirrorError ? error.problem : error instanceof Error ? error.message : String(error)}`);
      return passMs;
    }
    problem = null;
    lastSyncAt = now();
    const moved = summary.uploaded.length + summary.downloaded.length;
    // A rate-limited pass stops early, so moving nothing does not mean the mirror caught up.
    const retry = retrySchema.safeParse(summary);
    if (bound.phase === "joining" && moved === 0 && !retry.success && !summary.failed.some(blocksJoin)) {
      finishJoin(bound);
      catching = true;
      total = 0;
      return 0;
    }
    catching = moved > 0 || summary.failed.length > 0 || retry.success;
    if (!catching) total = 0;
    if (retry.success) return retry.data.retryAfterMs;
    return moved > 0 ? 0 : passMs;
  }

  function kick(): Promise<void> {
    if (running) return running;
    const bound = runnable();
    if (!bound) {
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

  async function start(): Promise<{ status: number; body: GoogleSyncStatus }> {
    const current = await read();
    const owner = account.owner();
    if (current.state !== "ready" || !owner || binding.kind !== "none") return { status: 409, body: status() };
    const dir = join(dataDir, GOOGLE_MIRROR_DIR);
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
    /** A bound, ready PC whose engines lost the mirror folder points them back at it. */
    resume(): void {
      const bound = binding.kind === "ok" ? binding.binding : null;
      if (bound?.phase === "ready" && !lost() && !options.folder()) options.activate(bound.mirrorPath);
      catching = runnable() !== null;
      void kick();
    },
    stop(): void {
      stopped = true;
      soon = false;
      unsubscribe();
      clearTimeout(timer);
    },
  };
}
export type GoogleSync = ReturnType<typeof createGoogleSync>;

/** Desktop renderer only: never the phone relay or a remote cookie. */
export async function googleSyncRoute(method: string, path: string, caller: { relay: boolean; bearerOk: boolean }, sync: Pick<GoogleSync, "read" | "start">) {
  if (path !== "/api/google-sync" && path !== "/api/google-sync/start") return null;
  if (caller.relay || !caller.bearerOk) return { status: 404, body: { error: "not found" } };
  if (method === "GET" && path === "/api/google-sync") return { status: 200, body: await sync.read() };
  if (method === "POST" && path === "/api/google-sync/start") return sync.start();
  return { status: 405, body: { error: "method not allowed" } };
}
