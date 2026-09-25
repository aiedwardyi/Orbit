import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, relative, resolve } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { botAvatarChoiceSchema, botAvatarCropSchema, type BotAvatarCrop } from "../shared/bot-avatar.ts";

export const PROFILE_SYNC_FORMAT = "orbit.profile-sync" as const;
export const PROFILE_SYNC_VERSION = 1 as const;
export const PROFILE_SYNC_CHANGES_DIR = "changes";
export const PROFILE_SYNC_WORKSPACE_FILE = "workspace.json";
const PROFILE_SYNC_MAX_FILES = 100_000;

const ID = z.string().trim().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const COLOR = z.enum([
  "green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral", "white", "black", "gray",
]);
const portableBotChanges = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(4_000).optional(),
  color: COLOR.optional(),
  mascotExpression: z.string().trim().max(80).nullable().optional(),
  mascotStyle: botAvatarChoiceSchema.nullable().optional(),
  avatarAsset: z.string().trim().max(240).nullable().optional(),
  avatarCrop: botAvatarCropSchema.optional(),
  sectionId: ID.nullable().optional(),
  pinned: z.boolean().optional(),
  chiefOfStaff: z.boolean().optional(),
  instanceId: z.string().trim().max(160).nullable().optional(),
  model: z.string().trim().max(160).nullable().optional(),
  effort: z.string().trim().max(40).nullable().optional(),
  modelMode: z.enum(["automatic", "pinned"]).nullable().optional(),
  approvePeerComms: z.boolean().optional(),
  memoryDocument: z.string().trim().max(240).nullable().optional(),
}).strict();
const sectionChanges = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  order: z.number().int().min(0).max(10_000).optional(),
}).strict();
const orderChanges = z.object({
  sectionOrder: z.array(ID).max(200).optional(),
  itemOrder: z.record(z.string().max(96), z.array(ID).max(500)).optional(),
}).strict();

const operationSchema = z.object({
  format: z.literal(PROFILE_SYNC_FORMAT),
  version: z.literal(PROFILE_SYNC_VERSION),
  operationId: ID,
  deviceId: ID,
  sequence: z.number().int().positive().max(2_000_000_000),
  recordedAt: z.number().int().positive().max(9_999_999_999_999),
  baseCheckpoint: z.string().trim().max(160).optional(),
  entity: z.enum(["bot", "section", "order"]),
  entityId: ID,
  changes: z.record(z.string().max(64), z.json()).optional(),
  deleted: z.boolean().optional(),
}).strict();

export type SyncEntity = "bot" | "section" | "order";

export interface ProfileSyncOperation {
  format: typeof PROFILE_SYNC_FORMAT;
  version: typeof PROFILE_SYNC_VERSION;
  operationId: string;
  deviceId: string;
  sequence: number;
  recordedAt: number;
  baseCheckpoint?: string;
  entity: SyncEntity;
  entityId: string;
  changes?: Record<string, unknown>;
  deleted?: boolean;
}

export interface SyncConflict {
  id: string;
  entity: SyncEntity;
  entityId: string;
  field: string;
  variants: Array<{ value: unknown; operationId: string; deviceId: string; recordedAt: number }>;
  chosenOperationId: string;
}

export interface SyncedBot {
  id: string;
  [key: string]: unknown;
}

export interface SyncedSection {
  id: string;
  [key: string]: unknown;
}

export interface SyncOrder {
  sectionOrder: string[];
  itemOrder: Record<string, string[]>;
}

interface FieldVersion {
  value: unknown;
  operationId: string;
  deviceId: string;
  recordedAt: number;
  sequence: number;
}

export interface ProfileSyncState {
  bots: Record<string, SyncedBot>;
  sections: Record<string, SyncedSection>;
  order: SyncOrder;
  tombstones: Record<string, ProfileSyncOperation>;
  conflicts: SyncConflict[];
  appliedOperationIds: string[];
  checkpoint: string;
  fieldVersions: Record<string, FieldVersion>;
}

export interface ProfileSyncEnvelope {
  format: typeof PROFILE_SYNC_FORMAT;
  version: typeof PROFILE_SYNC_VERSION;
  workspaceId: string;
  deviceId: string;
  checkpoint: string;
  operations: ProfileSyncOperation[];
}

export interface ProfileSyncSettings {
  workspaceId: string;
  deviceId: string;
  folder: string | null;
  botMap: Record<string, string>;
  sectionMap: Record<string, string>;
  reviewedResolutions: Record<string, Record<string, string>>;
  nextSequence: number;
  seenCheckpoint: string;
  syncChats: boolean;
  /** `entity:id:field` -> hash of the value this device and the folder last agreed on. */
  syncedHashes: Record<string, string>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().flatMap((key) => {
    const child = (value as Record<string, unknown>)[key];
    return child === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(child)}`];
  }).join(",")}}`;
}

export function profileSyncRevision(operations: Iterable<ProfileSyncOperation>): string {
  const records = [...operations].map(parseSyncOperation).map(canonicalJson).sort().join("\n");
  return createHash("sha256").update(records).digest("hex");
}

export function localIdForSyncId(map: Record<string, string>, syncId: string): string | undefined {
  return Object.entries(map).find(([, mappedId]) => mappedId === syncId)?.[0];
}

export function bindSyncId(map: Record<string, string>, localId: string, syncId: string): void {
  for (const [mappedLocalId, mappedSyncId] of Object.entries(map)) {
    if (mappedLocalId !== localId && mappedSyncId === syncId) delete map[mappedLocalId];
  }
  map[localId] = syncId;
}

export function resolveSyncConflictValue(
  conflicts: readonly SyncConflict[],
  entity: SyncEntity,
  entityId: string,
  field: string,
  resolutions: Record<string, string> | undefined,
  fallback: unknown,
): unknown {
  const conflict = conflicts.find((candidate) => candidate.entity === entity && candidate.entityId === entityId && candidate.field === field);
  if (!conflict) return fallback;
  const selected = resolutions?.[conflict.id];
  const variant = conflict.variants.find((candidate) => candidate.operationId === selected);
  return variant ? clone(variant.value) : fallback;
}

export function flattenReviewedResolutions(
  reviewed: Record<string, Record<string, string>>,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const group of Object.values(reviewed)) Object.assign(flat, group);
  return flat;
}

export function unresolvedSyncConflicts<T extends { id: string; variants: readonly { operationId: string }[] }>(
  conflicts: readonly T[],
  reviewedResolutions: Record<string, Record<string, string>>,
): T[] {
  const reviewed = flattenReviewedResolutions(reviewedResolutions);
  return conflicts.filter((conflict) => !conflict.variants.some((variant) => variant.operationId === reviewed[conflict.id]));
}

export function seenCheckpointAfterSave(seenCheckpoint: string): string {
  return seenCheckpoint;
}

const workspaceSchema = z.object({
  format: z.literal(PROFILE_SYNC_FORMAT),
  version: z.literal(PROFILE_SYNC_VERSION),
  workspaceId: ID,
}).strict();

const settingsSchema = z.object({
  workspaceId: ID,
  deviceId: ID,
  folder: z.string().trim().max(1_000).nullable(),
  botMap: z.record(ID, ID).default({}),
  sectionMap: z.record(z.string().trim().min(1).max(100), ID).default({}),
  reviewedResolutions: z.record(z.string().trim().min(1).max(512), z.record(z.string().trim().min(1).max(240), ID)).default({}),
  nextSequence: z.number().int().positive().max(2_000_000_000).default(1),
  seenCheckpoint: z.string().trim().max(160).default(""),
  syncChats: z.boolean().default(false),
  syncedHashes: z.record(z.string().max(240), z.string().max(64)).default({}),
}).strict();

function versionStamp(version: Pick<FieldVersion, "recordedAt" | "deviceId" | "sequence" | "operationId">): string {
  return `${String(version.recordedAt).padStart(14, "0")}:${version.deviceId}:${String(version.sequence).padStart(12, "0")}:${version.operationId}`;
}

function stamp(operation: ProfileSyncOperation): string {
  return versionStamp(operation);
}

function fieldKey(operation: ProfileSyncOperation, field: string): string {
  return `${operation.entity}:${operation.entityId}:${field}`;
}

function entityKey(operation: ProfileSyncOperation): string {
  return `${operation.entity}:${operation.entityId}`;
}

function valueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateChanges(operation: ProfileSyncOperation): Record<string, unknown> | undefined {
  if (!operation.changes) return undefined;
  const schema = operation.entity === "bot"
    ? portableBotChanges
    : operation.entity === "section"
      ? sectionChanges
      : orderChanges;
  const parsed = schema.safeParse(operation.changes);
  if (!parsed.success) throw new Error(`Invalid ${operation.entity} sync changes`);
  return parsed.data as Record<string, unknown>;
}

export function parseSyncOperation(value: unknown): ProfileSyncOperation {
  const parsed = operationSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid profile sync operation");
  const operation = parsed.data as ProfileSyncOperation;
  if (!operation.deleted && !operation.changes) throw new Error("Sync operation has no changes");
  validateChanges(operation);
  return operation;
}

export function createSyncOperation(input: Omit<ProfileSyncOperation, "format" | "version">): ProfileSyncOperation {
  return parseSyncOperation({ format: PROFILE_SYNC_FORMAT, version: PROFILE_SYNC_VERSION, ...input });
}

export function emptyProfileSyncState(): ProfileSyncState {
  return {
    bots: {},
    sections: {},
    order: { sectionOrder: [], itemOrder: {} },
    tombstones: {},
    conflicts: [],
    appliedOperationIds: [],
    checkpoint: "",
    fieldVersions: {},
  };
}

function operationSawPrior(
  operation: ProfileSyncOperation,
  previous: FieldVersion,
  appliedOrder: Map<string, number>,
): boolean {
  const base = operation.baseCheckpoint;
  if (!base) return false;
  const baseIndex = appliedOrder.get(base);
  const previousIndex = appliedOrder.get(previous.operationId);
  if (baseIndex === undefined || previousIndex === undefined) return false;
  return previousIndex <= baseIndex;
}

function setField(
  state: ProfileSyncState,
  operation: ProfileSyncOperation,
  field: string,
  value: unknown,
  appliedOrder: Map<string, number>,
): void {
  const key = fieldKey(operation, field);
  const previous = state.fieldVersions[key];
  const sawPrior = previous ? operationSawPrior(operation, previous, appliedOrder) : false;
  if (previous && !valueEqual(previous.value, value) && previous.deviceId !== operation.deviceId && !sawPrior) {
    const conflictId = `${key}:${previous.operationId}:${operation.operationId}`;
    if (!state.conflicts.some((conflict) => conflict.id === conflictId || conflict.id === `${key}:${operation.operationId}:${previous.operationId}`)) {
      const versions = [previous, { value, operationId: operation.operationId, deviceId: operation.deviceId, recordedAt: operation.recordedAt, sequence: operation.sequence }];
      versions.sort((left, right) => versionStamp(left).localeCompare(versionStamp(right)));
      const chosen = versions.at(-1)!;
      state.conflicts.push({
        id: conflictId,
        entity: operation.entity,
        entityId: operation.entityId,
        field,
        variants: versions.map(({ value: variantValue, operationId, deviceId, recordedAt }) => ({ value: clone(variantValue), operationId, deviceId, recordedAt })),
        chosenOperationId: chosen.operationId,
      });
    }
  }
  if (sawPrior) {
    state.conflicts = state.conflicts.filter((conflict) =>
      !(conflict.entity === operation.entity && conflict.entityId === operation.entityId && conflict.field === field),
    );
  }
  const current = state.fieldVersions[key];
  const nextVersion: FieldVersion = {
    value: clone(value),
    operationId: operation.operationId,
    deviceId: operation.deviceId,
    recordedAt: operation.recordedAt,
    sequence: operation.sequence,
  };
  if (!current || stamp(operation) >= `${String(current.recordedAt).padStart(14, "0")}:${current.deviceId}:${String(current.sequence).padStart(12, "0")}:${current.operationId}`) {
    state.fieldVersions[key] = nextVersion;
    const target = operation.entity === "bot"
      ? state.bots[operation.entityId] ?? { id: operation.entityId }
      : operation.entity === "section"
        ? state.sections[operation.entityId] ?? { id: operation.entityId }
        : state.order;
    if (operation.entity === "order") {
      if (field === "sectionOrder") state.order.sectionOrder = [...(value as string[])];
      else if (field === "itemOrder") state.order.itemOrder = clone(value as Record<string, string[]>);
    } else {
      (target as Record<string, unknown>)[field] = clone(value);
      if (operation.entity === "bot") state.bots[operation.entityId] = target as SyncedBot;
      else state.sections[operation.entityId] = target as SyncedSection;
    }
  }
}

export function applySyncOperations(
  initial: ProfileSyncState,
  operations: Iterable<ProfileSyncOperation>,
): ProfileSyncState {
  const state = clone(initial);
  const sorted = [...operations].map(parseSyncOperation).sort((left, right) => stamp(left).localeCompare(stamp(right)));
  const appliedOperationIds = new Set(state.appliedOperationIds);
  const appliedOrder = new Map(state.appliedOperationIds.map((id, index) => [id, index]));
  const markApplied = (operationId: string) => {
    appliedOperationIds.add(operationId);
    if (!appliedOrder.has(operationId)) appliedOrder.set(operationId, appliedOrder.size);
  };
  for (const operation of sorted) {
    if (appliedOperationIds.has(operation.operationId)) continue;
    const tombstone = state.tombstones[entityKey(operation)];
    if (operation.deleted) {
      if (!tombstone || stamp(operation) > stamp(tombstone)) {
        state.tombstones[entityKey(operation)] = clone(operation);
        if (operation.entity === "bot") delete state.bots[operation.entityId];
        if (operation.entity === "section") delete state.sections[operation.entityId];
      }
      markApplied(operation.operationId);
      continue;
    }
    if (tombstone) {
      markApplied(operation.operationId);
      continue;
    }
    const changes = validateChanges(operation) ?? {};
    for (const [field, value] of Object.entries(changes)) setField(state, operation, field, value, appliedOrder);
    markApplied(operation.operationId);
  }
  state.appliedOperationIds = [...appliedOperationIds].slice(-10_000);
  state.checkpoint = state.appliedOperationIds.at(-1) ?? state.checkpoint;
  return state;
}

export function serializeSyncOperation(operation: ProfileSyncOperation): string {
  return `${JSON.stringify(parseSyncOperation(operation))}\n`;
}

export function parseSyncOperationText(text: string): ProfileSyncOperation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Profile sync file is not valid JSON");
  }
  return parseSyncOperation(value);
}

export function syncOperationFileName(operation: ProfileSyncOperation): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${String(operation.sequence).padStart(12, "0")}-${safe(operation.deviceId)}-${safe(operation.operationId)}.json`;
}

export function writeSyncOperation(folder: string, operation: ProfileSyncOperation): string {
  const parsed = parseSyncOperation(operation);
  const directory = join(folder, PROFILE_SYNC_CHANGES_DIR);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, syncOperationFileName(parsed));
  writeFileAtomic(path, serializeSyncOperation(parsed));
  return path;
}

export function readSyncOperations(folder: string): { operations: ProfileSyncOperation[]; invalidFiles: string[]; truncated: boolean } {
  const directory = join(folder, PROFILE_SYNC_CHANGES_DIR);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return { operations: [], invalidFiles: [], truncated: false };
  }
  const operations: ProfileSyncOperation[] = [];
  const invalidFiles: string[] = [];
  const jsonNames = names.filter((value) => value.endsWith(".json")).sort();
  const truncated = jsonNames.length > PROFILE_SYNC_MAX_FILES;
  for (const name of jsonNames.slice(0, PROFILE_SYNC_MAX_FILES)) {
    const path = join(directory, basename(name));
    try {
      operations.push(parseSyncOperationText(readFileSync(path, "utf8")));
    } catch {
      invalidFiles.push(name);
    }
  }
  if (truncated) invalidFiles.push("[profile sync change log exceeds the supported file limit]");
  return { operations, invalidFiles, truncated };
}

export function loadOrCreateSyncWorkspace(folder: string, fallbackWorkspaceId: string): string {
  const path = join(folder, PROFILE_SYNC_WORKSPACE_FILE);
  try {
    const parsed = workspaceSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) return parsed.data.workspaceId;
  } catch {}
  const workspaceId = ID.parse(fallbackWorkspaceId);
  writeFileAtomic(path, `${JSON.stringify({ format: PROFILE_SYNC_FORMAT, version: PROFILE_SYNC_VERSION, workspaceId }, null, 2)}\n`);
  return workspaceId;
}

export function createSyncEnvelope(workspaceId: string, deviceId: string, operations: ProfileSyncOperation[]): ProfileSyncEnvelope {
  const parsedWorkspace = ID.parse(workspaceId);
  const parsedDevice = ID.parse(deviceId);
  const safe = operations.map(parseSyncOperation);
  return {
    format: PROFILE_SYNC_FORMAT,
    version: PROFILE_SYNC_VERSION,
    workspaceId: parsedWorkspace,
    deviceId: parsedDevice,
    checkpoint: safe.at(-1)?.operationId ?? "",
    operations: safe,
  };
}

export function loadProfileSyncSettings(dataDir: string): ProfileSyncSettings {
  const path = join(dataDir, "profile-sync.json");
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) return parsed.data;
  } catch {}
  return {
    workspaceId: randomUUID(),
    deviceId: randomUUID(),
    folder: null,
    botMap: {},
    sectionMap: {},
    reviewedResolutions: {},
    nextSequence: 1,
    seenCheckpoint: "",
    syncChats: false,
    syncedHashes: {},
  };
}

export function saveProfileSyncSettings(dataDir: string, settings: ProfileSyncSettings): ProfileSyncSettings {
  const parsed = settingsSchema.parse(settings);
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, "profile-sync.json"), `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

export function validateSyncFolder(folder: string): string {
  const candidate = folder.trim();
  if (!candidate) throw new Error("Choose a Google Drive folder first");
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) throw new Error("The selected sync folder is unavailable");
  return realpathSync(candidate);
}

export const PROFILE_SYNC_ASSETS_DIR = "assets";
export const PROFILE_SYNC_MAX_AVATAR_BYTES = 10 * 1024 * 1024;

const SYNC_AVATAR_EXTS = ["png", "jpg", "gif", "webp"] as const;
const SYNC_AVATAR_NAME = /^assets\/[A-Za-z0-9_-]{1,128}\.(png|jpg|jpeg|gif|webp)$/;

export interface SyncBotMatchCandidate {
  id: string;
  name: string;
  section?: string | null;
  hidden?: boolean;
}

// Sections persist as trimmed display labels; blank means unsectioned.
const syncSectionKey = (section?: string | null): string => section?.trim() || "";

// A first import onto a device that already has these bots leaves botMap
// empty, so a blind create duplicates every bot. Bind an existing unmapped
// visible bot instead, but only on an unambiguous name + section match.
export function findUnmappedLocalBotForImport(
  candidates: readonly SyncBotMatchCandidate[],
  botMap: Record<string, string>,
  name: string,
  section?: string | null,
): string | undefined {
  const mapped = new Set(Object.keys(botMap));
  const wantName = name.trim();
  const wantSection = syncSectionKey(section);
  const matches = candidates.filter(
    (candidate) =>
      !candidate.hidden &&
      !mapped.has(candidate.id) &&
      candidate.name.trim() === wantName &&
      syncSectionKey(candidate.section) === wantSection,
  );
  return matches.length === 1 ? matches[0]!.id : undefined;
}

function normalizeSyncAvatarExt(ext: string): string | null {
  const lower = ext.toLowerCase();
  const normalized = lower === "jpeg" ? "jpg" : lower;
  return (SYNC_AVATAR_EXTS as readonly string[]).includes(normalized) ? normalized : null;
}

// Custom avatars are attachment files; copy the bytes into the sync folder
// under a content hash so both devices converge on one filename per image.
export function writeSyncAvatarAsset(
  folder: string,
  bytes: Buffer,
  ext: string,
  maxBytes = PROFILE_SYNC_MAX_AVATAR_BYTES,
): string {
  const normalized = normalizeSyncAvatarExt(ext);
  if (!normalized) throw new Error("Unsupported sync avatar type");
  if (bytes.byteLength === 0) throw new Error("Empty sync avatar");
  if (bytes.byteLength > maxBytes) throw new Error("Sync avatar exceeds the size limit");
  const name = `${PROFILE_SYNC_ASSETS_DIR}/${createHash("sha256").update(bytes).digest("hex")}.${normalized}`;
  mkdirSync(join(folder, PROFILE_SYNC_ASSETS_DIR), { recursive: true });
  const path = join(folder, PROFILE_SYNC_ASSETS_DIR, basename(name));
  try {
    if (statSync(path).isFile()) return name;
  } catch {}
  writeFileSync(path, bytes, { mode: 0o600 });
  return name;
}

export function resolveSyncAvatarPath(
  folder: string,
  avatarAsset: unknown,
  maxBytes = PROFILE_SYNC_MAX_AVATAR_BYTES,
): string | null {
  if (typeof avatarAsset !== "string" || !SYNC_AVATAR_NAME.test(avatarAsset)) return null;
  const base = resolve(folder);
  const target = resolve(base, avatarAsset);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return null;
  try {
    const stat = statSync(target);
    if (!stat.isFile() || stat.size > maxBytes) return null;
  } catch {
    return null;
  }
  return target;
}

export function readSyncAvatarAsset(
  folder: string,
  avatarAsset: unknown,
  maxBytes = PROFILE_SYNC_MAX_AVATAR_BYTES,
): { bytes: Buffer; ext: string } | null {
  const path = resolveSyncAvatarPath(folder, avatarAsset, maxBytes);
  if (!path) return null;
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
    const ext = normalizeSyncAvatarExt(path.split(".").pop() ?? "");
    if (!ext) return null;
    return { bytes, ext };
  } catch {
    return null;
  }
}

// Ops saved before avatarCrop synced carry none; a photo import then needs a photo crop.
export function importedSyncAvatarCrop(synced: unknown, current: BotAvatarCrop | undefined): BotAvatarCrop {
  const parsed = botAvatarCropSchema.safeParse(synced);
  if (parsed.success) return parsed.data;
  return current && current !== "mascot" ? current : "circle";
}

export function syncAvatarMatches(folder: string, avatarAsset: unknown, bytes: Buffer): boolean {
  const asset = readSyncAvatarAsset(folder, avatarAsset);
  if (!asset) return false;
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  return digest(asset.bytes) === digest(bytes);
}

// Change files are never rewritten in place, so their names alone say whether the log moved.
export function syncOperationsSignature(folder: string): string {
  let names: string[];
  try {
    names = readdirSync(join(folder, PROFILE_SYNC_CHANGES_DIR));
  } catch {
    return "";
  }
  return createHash("sha256").update(names.filter((name) => name.endsWith(".json")).sort().join("\n")).digest("hex");
}

export interface SyncEntityValues {
  entity: SyncEntity;
  entityId: string;
  changes: Record<string, unknown>;
}

const syncedKey = (entity: SyncEntity, entityId: string, field: string) => `${entity}:${entityId}:${field}`;

export function syncValueHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value ?? null)).digest("hex").slice(0, 32);
}

/** Only fields that moved since the last sync; unchanged entities drop out. */
export function unsyncedChanges(synced: Record<string, string>, local: readonly SyncEntityValues[]): SyncEntityValues[] {
  return local.flatMap((item) => {
    const changes = Object.fromEntries(Object.entries(item.changes).filter(([field, value]) =>
      synced[syncedKey(item.entity, item.entityId, field)] !== syncValueHash(value)));
    return Object.keys(changes).length ? [{ ...item, changes }] : [];
  });
}

export function markSynced(synced: Record<string, string>, item: SyncEntityValues): void {
  for (const [field, value] of Object.entries(item.changes)) synced[syncedKey(item.entity, item.entityId, field)] = syncValueHash(value);
}

export function forgetSynced(synced: Record<string, string>, entity: SyncEntity, entityId: string): void {
  const prefix = `${entity}:${entityId}:`;
  for (const key of Object.keys(synced)) if (key.startsWith(prefix)) delete synced[key];
}

/** Newest remote values another device wrote since the last sync; a field also edited here keeps the local edit. */
export function remoteFieldsToApply(
  state: ProfileSyncState,
  deviceId: string,
  synced: Record<string, string>,
  entity: SyncEntity,
  entityId: string,
  remote: Record<string, unknown>,
  local: Record<string, unknown> | null,
): Record<string, unknown> {
  const apply: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(remote)) {
    const key = syncedKey(entity, entityId, field);
    if (field === "id" || state.fieldVersions[key]?.deviceId === deviceId) continue;
    const base = synced[key];
    if (syncValueHash(value) === base) continue;
    if (local && base !== undefined && syncValueHash(local[field]) !== base) continue;
    apply[field] = value;
  }
  return apply;
}

/** Applied fields, and fields both sides already agree on, take the local value as the new base so nothing echoes back. */
export function markImported(
  synced: Record<string, string>,
  entity: SyncEntity,
  entityId: string,
  remote: Record<string, unknown>,
  applied: Record<string, unknown>,
  local: Record<string, unknown>,
): void {
  for (const [field, value] of Object.entries(remote)) {
    if (field === "id") continue;
    const localHash = syncValueHash(local[field]);
    if (field in applied || localHash === syncValueHash(value)) synced[syncedKey(entity, entityId, field)] = localHash;
  }
}

export interface LocalSyncBot extends SyncBotMatchCandidate {
  changes: Record<string, unknown>;
}

export interface ProfileImportPlan {
  /** localId null means create. */
  bots: Array<{ globalId: string; localId: string | null; apply: Record<string, unknown> }>;
  hide: Array<{ globalId: string; localId: string; tombstoneId: string }>;
  order: Record<string, unknown>;
}

export function planProfileImport(input: {
  state: ProfileSyncState;
  deviceId: string;
  workspaceId: string;
  synced: Record<string, string>;
  botMap: Record<string, string>;
  local: readonly LocalSyncBot[];
  localOrder: Record<string, unknown>;
}): ProfileImportPlan {
  const { state, deviceId, synced } = input;
  const botMap = { ...input.botMap };
  const byId = new Map(input.local.map((bot) => [bot.id, bot]));
  const sectionNames = new Map(Object.values(state.sections).map((section) => [section.id, String(section.name ?? "")]));
  const plan: ProfileImportPlan = { bots: [], hide: [], order: {} };
  for (const remote of Object.values(state.bots)) {
    let localId = localIdForSyncId(botMap, remote.id) ?? null;
    // deleted here; its tombstone goes out on the next publish
    if (localId && !byId.has(localId)) continue;
    if (!localId) {
      const section = typeof remote.sectionId === "string" ? sectionNames.get(remote.sectionId) : undefined;
      localId = findUnmappedLocalBotForImport(input.local, botMap, String(remote.name ?? ""), section) ?? null;
      if (localId) bindSyncId(botMap, localId, remote.id);
    }
    const apply = remoteFieldsToApply(state, deviceId, synced, "bot", remote.id, remote, localId ? byId.get(localId)!.changes : null);
    plan.bots.push({ globalId: remote.id, localId, apply });
  }
  for (const [key, tombstone] of Object.entries(state.tombstones)) {
    if (!key.startsWith("bot:")) continue;
    const globalId = key.slice("bot:".length);
    const localId = localIdForSyncId(botMap, globalId);
    if (!localId || !byId.has(localId)) continue;
    // hidden once per tombstone, so a bot unhidden here stays recovered
    if (synced[syncedKey("bot", globalId, "deleted")] === syncValueHash(tombstone.operationId)) continue;
    plan.hide.push({ globalId, localId, tombstoneId: tombstone.operationId });
  }
  const remoteOrder = Object.fromEntries((["sectionOrder", "itemOrder"] as const)
    .filter((field) => state.fieldVersions[syncedKey("order", input.workspaceId, field)])
    .map((field) => [field, state.order[field]]));
  plan.order = remoteFieldsToApply(state, deviceId, synced, "order", input.workspaceId, remoteOrder, input.localOrder);
  return plan;
}
