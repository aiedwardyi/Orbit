import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applySyncOperations,
  bindSyncId,
  createSyncOperation,
  emptyProfileSyncState,
  loadProfileSyncSettings,
  localIdForSyncId,
  parseSyncOperationText,
  readSyncOperations,
  resolveSyncConflictValue,
  profileSyncRevision,
  saveProfileSyncSettings,
  serializeSyncOperation,
  syncOperationFileName,
  unresolvedSyncConflicts,
  writeSyncOperation,
} from "./profile-sync.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function operation(input: Partial<Parameters<typeof createSyncOperation>[0]> = {}) {
  return createSyncOperation({
    operationId: input.operationId ?? "op-1",
    deviceId: input.deviceId ?? "device-a",
    sequence: input.sequence ?? 1,
    recordedAt: input.recordedAt ?? 1_700_000_000_000,
    entity: input.entity ?? "bot",
    entityId: input.entityId ?? "bot-1",
    changes: input.changes ?? { name: "Python Tutor" },
    ...input,
  });
}

describe("profile sync operations", () => {
  it("replays duplicate and out-of-order records idempotently", () => {
    const newer = operation({ operationId: "op-2", deviceId: "device-b", sequence: 2, recordedAt: 1_700_000_000_002, changes: { title: "Teacher" } });
    const older = operation({ operationId: "op-1", deviceId: "device-a", sequence: 1, recordedAt: 1_700_000_000_001 });
    const first = applySyncOperations(emptyProfileSyncState(), [newer, older, newer]);
    const second = applySyncOperations(emptyProfileSyncState(), [older, newer]);
    expect(first.bots).toEqual(second.bots);
    expect(first.appliedOperationIds).toEqual(["op-1", "op-2"]);
    expect(first.bots["bot-1"]).toMatchObject({ name: "Python Tutor", title: "Teacher" });
  });

  it("retains a cross-device field conflict while choosing a deterministic value", () => {
    const state = applySyncOperations(emptyProfileSyncState(), [
      operation({ operationId: "op-a", deviceId: "device-a", changes: { name: "Tutor" } }),
      operation({ operationId: "op-b", deviceId: "device-b", recordedAt: 1_700_000_000_001, changes: { name: "Python Tutor" } }),
    ]);
    expect(state.bots["bot-1"]?.name).toBe("Python Tutor");
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]?.variants.map((variant) => variant.value)).toEqual(["Tutor", "Python Tutor"]);
  });

  it("does not conflict when a later device save is based on the earlier device's operation", () => {
    const first = operation({ operationId: "op-a", deviceId: "device-a", changes: { name: "Tutor" } });
    const second = operation({
      operationId: "op-b",
      deviceId: "device-b",
      sequence: 2,
      recordedAt: 1_700_000_000_001,
      baseCheckpoint: "op-a",
      changes: { name: "Python Tutor" },
    });
    const state = applySyncOperations(emptyProfileSyncState(), [first, second]);
    expect(state.bots["bot-1"]?.name).toBe("Python Tutor");
    expect(state.conflicts).toEqual([]);
  });

  it("still conflicts when neither device based its save on the other", () => {
    const shared = operation({ operationId: "op-0", deviceId: "device-a", changes: { name: "Seed" } });
    const first = operation({
      operationId: "op-a",
      deviceId: "device-a",
      sequence: 2,
      recordedAt: 1_700_000_000_001,
      baseCheckpoint: "op-0",
      changes: { name: "Tutor" },
    });
    const second = operation({
      operationId: "op-b",
      deviceId: "device-b",
      sequence: 2,
      recordedAt: 1_700_000_000_002,
      baseCheckpoint: "op-0",
      changes: { name: "Python Tutor" },
    });
    const state = applySyncOperations(emptyProfileSyncState(), [shared, first, second]);
    expect(state.bots["bot-1"]?.name).toBe("Python Tutor");
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]?.variants.map((variant) => variant.value)).toEqual(["Tutor", "Python Tutor"]);
  });

  it("drops a resolved field conflict after a later save that saw both variants", () => {
    const first = operation({ operationId: "op-a", deviceId: "device-a", changes: { name: "Tutor" } });
    const second = operation({
      operationId: "op-b",
      deviceId: "device-b",
      sequence: 2,
      recordedAt: 1_700_000_000_001,
      changes: { name: "Python Tutor" },
    });
    const resolved = applySyncOperations(emptyProfileSyncState(), [first, second]);
    expect(resolved.conflicts).toHaveLength(1);
    const save = operation({
      operationId: "op-c",
      deviceId: "device-b",
      sequence: 3,
      recordedAt: 1_700_000_000_002,
      baseCheckpoint: "op-b",
      changes: { name: "Tutor" },
    });
    const afterSave = applySyncOperations(resolved, [save]);
    expect(afterSave.bots["bot-1"]?.name).toBe("Tutor");
    expect(afterSave.conflicts).toEqual([]);
  });

  it("keeps a reviewed resolution after later operations change the revision hash", () => {
    const first = operation({ operationId: "op-a", deviceId: "device-a", changes: { name: "Tutor" } });
    const second = operation({
      operationId: "op-b",
      deviceId: "device-b",
      recordedAt: 1_700_000_000_001,
      changes: { name: "Python Tutor" },
    });
    const conflicted = applySyncOperations(emptyProfileSyncState(), [first, second]);
    const conflict = conflicted.conflicts[0]!;
    const oldRevision = profileSyncRevision([first, second]);
    const later = operation({
      operationId: "op-c",
      deviceId: "device-a",
      sequence: 3,
      recordedAt: 1_700_000_000_002,
      changes: { title: "Teacher" },
    });
    const afterSave = applySyncOperations(conflicted, [later]);
    expect(profileSyncRevision([first, second, later])).not.toBe(oldRevision);
    expect(afterSave.conflicts).toHaveLength(1);
    const reviewed = { [oldRevision]: { [conflict.id]: conflict.chosenOperationId } };
    expect(unresolvedSyncConflicts(afterSave.conflicts, reviewed)).toEqual([]);
  });

  it("binds the local-to-remote map without leaving a stale reverse alias", () => {
    const map = { localA: "remote-1", stale: "remote-1", localB: "remote-2" };
    expect(localIdForSyncId(map, "remote-1")).toBe("localA");
    bindSyncId(map, "localC", "remote-1");
    expect(map).toEqual({ localB: "remote-2", localC: "remote-1" });
  });

  it("keeps revisions content-bound and resolves an explicit null variant", () => {
    const first = operation({ operationId: "revision", changes: { mascotExpression: "happy" } });
    const changed = operation({ operationId: "revision", changes: { mascotExpression: null } });
    expect(profileSyncRevision([first])).not.toBe(profileSyncRevision([changed]));
    const state = applySyncOperations(emptyProfileSyncState(), [
      operation({ operationId: "null-a", deviceId: "device-a", changes: { mascotExpression: "happy" } }),
      operation({ operationId: "null-b", deviceId: "device-b", recordedAt: 1_700_000_000_001, changes: { mascotExpression: null } }),
    ]);
    const conflict = state.conflicts[0]!;
    expect(resolveSyncConflictValue(state.conflicts, "bot", "bot-1", "mascotExpression", { [conflict.id]: "null-b" }, "fallback")).toBeNull();
  });

  it("persists reviewed resolutions across a settings reload", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-profile-sync-settings-"));
    roots.push(root);
    const initial = loadProfileSyncSettings(root);
    initial.reviewedResolutions = { revision: { conflict: "variant-null" } };
    saveProfileSyncSettings(root, initial);
    expect(loadProfileSyncSettings(root).reviewedResolutions).toEqual(initial.reviewedResolutions);
  });

  it("saves sectionMap keys that include spaces", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-profile-sync-section-"));
    roots.push(root);
    const initial = loadProfileSyncSettings(root);
    initial.sectionMap = { "area 1": "section-1" };
    saveProfileSyncSettings(root, initial);
    expect(loadProfileSyncSettings(root).sectionMap).toEqual({ "area 1": "section-1" });
  });

  it("keeps a delete tombstone from being undone by delayed offline edits", () => {
    const state = applySyncOperations(emptyProfileSyncState(), [
      operation({ operationId: "create", changes: { name: "Old" } }),
      operation({ operationId: "delete", deviceId: "device-b", sequence: 2, recordedAt: 1_700_000_000_010, deleted: true, changes: undefined }),
      operation({ operationId: "late-edit", deviceId: "device-a", sequence: 3, recordedAt: 1_700_000_000_011, changes: { name: "Resurrected" } }),
    ]);
    expect(state.bots["bot-1"]).toBeUndefined();
    expect(state.tombstones["bot:bot-1"]?.operationId).toBe("delete");
  });

  it("deletes only the matching entity namespace", () => {
    const state = applySyncOperations(emptyProfileSyncState(), [
      operation({ operationId: "bot-create", entity: "bot", entityId: "same-id", changes: { name: "Tutor" } }),
      operation({ operationId: "section-create", entity: "section", entityId: "same-id", changes: { name: "Area" } }),
      operation({ operationId: "bot-delete", entity: "bot", entityId: "same-id", deleted: true, changes: undefined, sequence: 3, recordedAt: 1_700_000_000_003 }),
    ]);
    expect(state.bots["same-id"]).toBeUndefined();
    expect(state.sections["same-id"]).toMatchObject({ id: "same-id", name: "Area" });
  });

  it("round trips atomic folder records and reports corrupt files without applying them", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-profile-sync-"));
    roots.push(root);
    const record = operation({ operationId: "folder-op" });
    const path = writeSyncOperation(root, record);
    expect(path).toContain(syncOperationFileName(record));
    expect(parseSyncOperationText(serializeSyncOperation(record))).toEqual(record);
    const result = readSyncOperations(root);
    expect(result.operations).toEqual([record]);
    expect(result.invalidFiles).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
