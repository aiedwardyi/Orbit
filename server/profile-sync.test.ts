import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applySyncOperations,
  createSyncOperation,
  emptyProfileSyncState,
  parseSyncOperationText,
  readSyncOperations,
  serializeSyncOperation,
  syncOperationFileName,
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

  it("keeps a delete tombstone from being undone by delayed offline edits", () => {
    const state = applySyncOperations(emptyProfileSyncState(), [
      operation({ operationId: "create", changes: { name: "Old" } }),
      operation({ operationId: "delete", deviceId: "device-b", sequence: 2, recordedAt: 1_700_000_000_010, deleted: true, changes: undefined }),
      operation({ operationId: "late-edit", deviceId: "device-a", sequence: 3, recordedAt: 1_700_000_000_011, changes: { name: "Resurrected" } }),
    ]);
    expect(state.bots["bot-1"]).toBeUndefined();
    expect(state.tombstones["bot:bot-1"]?.operationId).toBe("delete");
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
