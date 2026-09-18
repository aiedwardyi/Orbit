import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { botAvatarChoiceSchema } from "../shared/bot-avatar.ts";

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
  sectionId: ID.nullable().optional(),
  pinned: z.boolean().optional(),
  chiefOfStaff: z.boolean().optional(),
  instanceId: z.string().trim().max(160).nullable().optional(),
  model: z.string().trim().max(160).nullable().optional(),
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
  nextSequence: number;
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
  sectionMap: z.record(ID, ID).default({}),
  nextSequence: z.number().int().positive().max(2_000_000_000).default(1),
}).strict();

function stamp(operation: ProfileSyncOperation): string {
  return `${String(operation.recordedAt).padStart(14, "0")}:${operation.deviceId}:${String(operation.sequence).padStart(12, "0")}:${operation.operationId}`;
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

function setField(state: ProfileSyncState, operation: ProfileSyncOperation, field: string, value: unknown): void {
  const key = fieldKey(operation, field);
  const previous = state.fieldVersions[key];
  if (previous && !valueEqual(previous.value, value) && previous.deviceId !== operation.deviceId) {
    const conflictId = `${key}:${previous.operationId}:${operation.operationId}`;
    if (!state.conflicts.some((conflict) => conflict.id === conflictId || conflict.id === `${key}:${operation.operationId}:${previous.operationId}`)) {
      const versions = [previous, { value, operationId: operation.operationId, deviceId: operation.deviceId, recordedAt: operation.recordedAt, sequence: operation.sequence }];
      versions.sort((left, right) => `${left.recordedAt}:${left.deviceId}:${left.sequence}:${left.operationId}`.localeCompare(`${right.recordedAt}:${right.deviceId}:${right.sequence}:${right.operationId}`));
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
  for (const operation of sorted) {
    if (state.appliedOperationIds.includes(operation.operationId)) continue;
    const tombstone = state.tombstones[entityKey(operation)];
    if (operation.deleted) {
      if (!tombstone || stamp(operation) > stamp(tombstone)) {
        state.tombstones[entityKey(operation)] = clone(operation);
        delete state.bots[operation.entityId];
        delete state.sections[operation.entityId];
      }
      state.appliedOperationIds.push(operation.operationId);
      continue;
    }
    if (tombstone) {
      state.appliedOperationIds.push(operation.operationId);
      continue;
    }
    const changes = validateChanges(operation) ?? {};
    for (const [field, value] of Object.entries(changes)) setField(state, operation, field, value);
    state.appliedOperationIds.push(operation.operationId);
  }
  state.appliedOperationIds = [...new Set(state.appliedOperationIds)].slice(-10_000);
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
  return { workspaceId: randomUUID(), deviceId: randomUUID(), folder: null, botMap: {}, sectionMap: {}, nextSequence: 1 };
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
