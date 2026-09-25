import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applySyncOperations,
  bindSyncId,
  createSyncOperation,
  emptyProfileSyncState,
  findUnmappedLocalBotForImport,
  importedSyncAvatarCrop,
  loadProfileSyncSettings,
  localIdForSyncId,
  markImported,
  markSynced,
  planProfileImport,
  forgetSynced,
  unsyncedChanges,
  parseSyncOperationText,
  readSyncAvatarAsset,
  readSyncOperations,
  resolveSyncAvatarPath,
  resolveSyncConflictValue,
  profileSyncRevision,
  saveProfileSyncSettings,
  serializeSyncOperation,
  syncAvatarMatches,
  syncOperationFileName,
  unresolvedSyncConflicts,
  seenCheckpointAfterSave,
  writeSyncAvatarAsset,
  writeSyncOperation,
  type ProfileSyncOperation,
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

  it("keeps a concurrent conflict after a later save that only saw this device's own op", () => {
    const first = operation({ operationId: "op-a1", deviceId: "device-a", changes: { name: "Tutor" } });
    const second = operation({
      operationId: "op-b1",
      deviceId: "device-b",
      sequence: 2,
      recordedAt: 1_700_000_000_001,
      changes: { name: "Python Tutor" },
    });
    const conflicted = applySyncOperations(emptyProfileSyncState(), [first, second]);
    expect(conflicted.conflicts).toHaveLength(1);
    const conflictId = conflicted.conflicts[0]?.id;
    const seenCheckpoint = seenCheckpointAfterSave("");
    const save = operation({
      operationId: "op-b2",
      deviceId: "device-b",
      sequence: 3,
      recordedAt: 1_700_000_000_002,
      ...(seenCheckpoint ? { baseCheckpoint: seenCheckpoint } : {}),
      changes: { name: "Python Tutor" },
    });
    const afterSave = applySyncOperations(conflicted, [save]);
    expect(afterSave.conflicts).toHaveLength(1);
    expect(afterSave.conflicts[0]?.id).toBe(conflictId);
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

  it("carries a custom avatar asset through a bot operation", () => {
    const record = operation({ operationId: "avatar-op", changes: { name: "Tutor", avatarAsset: "assets/abc123.png" } });
    expect(record.changes).toMatchObject({ avatarAsset: "assets/abc123.png" });
    const cleared = operation({ operationId: "avatar-clear", changes: { name: "Tutor", avatarAsset: null } });
    expect(cleared.changes).toMatchObject({ avatarAsset: null });
  });
});

describe("sync import matching", () => {
  it("binds an unmapped same-named bot instead of duplicating it", () => {
    const locals = [
      { id: "local-1", name: "Python Tutor", section: "Study" },
      { id: "local-2", name: "Sous Chef", section: undefined },
    ];
    expect(findUnmappedLocalBotForImport(locals, {}, "Python Tutor", "Study")).toBe("local-1");
    expect(findUnmappedLocalBotForImport(locals, {}, "Sous Chef", undefined)).toBe("local-2");
  });

  it("skips hidden and already-mapped bots", () => {
    const locals = [
      { id: "local-1", name: "Python Tutor", hidden: true },
      { id: "local-2", name: "Python Tutor" },
    ];
    expect(findUnmappedLocalBotForImport(locals, {}, "Python Tutor", undefined)).toBe("local-2");
    expect(findUnmappedLocalBotForImport(locals, { "local-2": "remote-9" }, "Python Tutor", undefined)).toBeUndefined();
  });

  it("creates only when there is no unambiguous match", () => {
    const ambiguous = [
      { id: "local-1", name: "Python Tutor" },
      { id: "local-2", name: "Python Tutor" },
    ];
    expect(findUnmappedLocalBotForImport(ambiguous, {}, "Python Tutor", undefined)).toBeUndefined();
    expect(findUnmappedLocalBotForImport([{ id: "local-1", name: "Python Tutor", section: "Study" }], {}, "Python Tutor", "Work")).toBeUndefined();
    expect(findUnmappedLocalBotForImport([{ id: "local-1", name: "Other Bot" }], {}, "Python Tutor", undefined)).toBeUndefined();
  });
});

describe("sync avatar assets", () => {
  it("round trips avatar bytes through save and import", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-profile-sync-avatar-"));
    roots.push(root);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const name = writeSyncAvatarAsset(root, bytes, "png");
    expect(name).toMatch(/^assets\/[0-9a-f]{64}\.png$/);
    expect(writeSyncAvatarAsset(root, bytes, "png")).toBe(name);
    const back = readSyncAvatarAsset(root, name);
    expect(back?.ext).toBe("png");
    expect(back?.bytes.equals(bytes)).toBe(true);
  });

  it("rejects paths that escape the sync folder", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-profile-sync-avatar-evil-"));
    roots.push(root);
    for (const evil of ["../evil.png", "assets/../../evil.png", "/etc/passwd", "assets/evil.svg", "assets/.png", 42, null]) {
      expect(resolveSyncAvatarPath(root, evil)).toBeNull();
      expect(readSyncAvatarAsset(root, evil)).toBeNull();
    }
    expect(resolveSyncAvatarPath(root, "assets/missing.png")).toBeNull();
  });

  it("caps avatar file size", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-profile-sync-avatar-cap-"));
    roots.push(root);
    expect(() => writeSyncAvatarAsset(root, Buffer.alloc(16), "png", 8)).toThrow();
    const name = writeSyncAvatarAsset(root, Buffer.alloc(8), "png", 8);
    expect(resolveSyncAvatarPath(root, name, 4)).toBeNull();
    expect(() => writeSyncAvatarAsset(root, Buffer.from([1]), "svg")).toThrow();
  });

  it("keeps a mascot icon through save and import on a fresh state", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-profile-sync-avatar-crop-"));
    roots.push(root);
    const avatarAsset = writeSyncAvatarAsset(root, Buffer.from([1, 2, 3]), "png");
    writeSyncOperation(root, operation({
      operationId: "crop-op",
      changes: { name: "Tutor", mascotStyle: "icon-05", avatarAsset, avatarCrop: "mascot" },
    }));
    const bot = applySyncOperations(emptyProfileSyncState(), readSyncOperations(root).operations).bots["bot-1"]!;
    expect(bot.mascotStyle).toBe("icon-05");
    expect(bot.avatarAsset).toBe(avatarAsset);
    expect(importedSyncAvatarCrop(bot.avatarCrop, undefined)).toBe("mascot");
    expect(importedSyncAvatarCrop(bot.avatarCrop, "square")).toBe("mascot");
  });

  it("imports an op without avatarCrop with the old photo crop", () => {
    const bot = applySyncOperations(emptyProfileSyncState(), [
      operation({ changes: { name: "Tutor", avatarAsset: "assets/abc123.png" } }),
    ]).bots["bot-1"]!;
    expect(bot.avatarCrop).toBeUndefined();
    expect(importedSyncAvatarCrop(bot.avatarCrop, undefined)).toBe("circle");
    expect(importedSyncAvatarCrop(bot.avatarCrop, "mascot")).toBe("circle");
    expect(importedSyncAvatarCrop(bot.avatarCrop, "rounded")).toBe("rounded");
  });

  it("matches identical avatar bytes so a second import keeps the attachment", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-profile-sync-avatar-match-"));
    roots.push(root);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x09]);
    const name = writeSyncAvatarAsset(root, bytes, "png");
    expect(syncAvatarMatches(root, name, Buffer.from(bytes))).toBe(true);
    expect(syncAvatarMatches(root, name, Buffer.from([0x89, 0x50]))).toBe(false);
    expect(syncAvatarMatches(root, "assets/missing.png", bytes)).toBe(false);
  });
});

describe("automatic bot sync", () => {
  type Device = {
    id: string;
    bots: Map<string, { name: string; hidden?: boolean; changes: Record<string, unknown> }>;
    botMap: Record<string, string>;
    synced: Record<string, string>;
    sequence: number;
    created: number;
  };
  const device = (id: string): Device => ({ id, bots: new Map(), botMap: {}, synced: {}, sequence: 1, created: 0 });
  const log: ProfileSyncOperation[] = [];
  let clock = 1_700_000_000_000;

  function publish(host: Device): ProfileSyncOperation[] {
    const record = (input: Omit<Parameters<typeof createSyncOperation>[0], "operationId" | "deviceId" | "sequence" | "recordedAt">) => {
      const sequence = host.sequence++;
      return createSyncOperation({ ...input, operationId: `${host.id}-${sequence}`, deviceId: host.id, sequence, recordedAt: clock++ });
    };
    const changed = unsyncedChanges(host.synced, [...host.bots].map(([localId, bot]) => ({
      entity: "bot" as const,
      entityId: (host.botMap[localId] ??= `g-${host.id}-${localId}`),
      changes: bot.changes,
    })));
    const operations = changed.map((item) => {
      markSynced(host.synced, item);
      return record(item);
    });
    for (const [localId, globalId] of Object.entries(host.botMap)) {
      if (host.bots.has(localId)) continue;
      operations.push(record({ entity: "bot", entityId: globalId, deleted: true }));
      delete host.botMap[localId];
      forgetSynced(host.synced, "bot", globalId);
    }
    log.push(...operations);
    return operations;
  }

  function importInto(host: Device) {
    const state = applySyncOperations(emptyProfileSyncState(), log);
    const plan = planProfileImport({
      state,
      deviceId: host.id,
      workspaceId: "workspace",
      synced: host.synced,
      botMap: host.botMap,
      local: [...host.bots].map(([id, bot]) => ({ id, name: String(bot.changes.name), hidden: bot.hidden, changes: bot.changes })),
      localOrder: {},
    });
    for (const item of plan.bots) {
      const localId = item.localId ?? `${host.id}-bot-${++host.created}`;
      const bot = host.bots.get(localId) ?? { name: "", changes: {} };
      const { id: _id, ...applied } = item.apply;
      Object.assign(bot.changes, applied);
      host.bots.set(localId, bot);
      bindSyncId(host.botMap, localId, item.globalId);
      markImported(host.synced, "bot", item.globalId, state.bots[item.globalId]!, item.apply, bot.changes);
    }
    for (const item of plan.hide) {
      const bot = host.bots.get(item.localId)!;
      bot.hidden = true;
      bot.changes.chiefOfStaff = false;
      markSynced(host.synced, { entity: "bot", entityId: item.globalId, changes: { ...bot.changes, deleted: item.tombstoneId } });
    }
    return plan;
  }

  afterEach(() => {
    log.length = 0;
  });

  it("publishes only the bots and fields that changed", () => {
    const a = device("a");
    a.bots.set("tutor", { name: "Tutor", changes: { name: "Tutor", title: "Teacher", color: "blue" } });
    a.bots.set("coder", { name: "Coder", changes: { name: "Coder", title: "Engineer", color: "green" } });
    expect(publish(a)).toHaveLength(2);
    expect(publish(a)).toEqual([]);
    a.bots.get("coder")!.changes.title = "Staff engineer";
    const operations = publish(a);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ entityId: "g-a-coder", changes: { title: "Staff engineer" } });
  });

  it("imports a new bot without echoing it back or re-applying its own ops", () => {
    const a = device("a");
    const b = device("b");
    a.bots.set("tutor", { name: "Tutor", changes: { name: "Tutor", description: "Teaches Python", color: "blue", model: "opus" } });
    publish(a);
    importInto(b);
    expect([...b.bots.values()][0]!.changes).toEqual({ name: "Tutor", description: "Teaches Python", color: "blue", model: "opus" });
    expect(publish(b)).toEqual([]);
    expect(importInto(a).bots[0]!.apply).toEqual({});
    expect(importInto(b).bots[0]!.apply).toEqual({});
  });

  it("keeps a local edit that has not published yet over an older remote value", () => {
    const a = device("a");
    const b = device("b");
    a.bots.set("tutor", { name: "Tutor", changes: { name: "Tutor", color: "blue" } });
    publish(a);
    importInto(b);
    a.bots.get("tutor")!.changes.color = "red";
    publish(a);
    const local = [...b.bots.values()][0]!;
    local.changes.color = "green";
    expect(importInto(b).bots[0]!.apply).toEqual({});
    expect(local.changes.color).toBe("green");
    expect(publish(b)[0]).toMatchObject({ changes: { color: "green" } });
    expect(importInto(a).bots[0]!.apply).toEqual({ color: "green" });
  });

  it("hides a bot deleted on another device once and never brings it back", () => {
    const a = device("a");
    const b = device("b");
    a.bots.set("tutor", { name: "Tutor", changes: { name: "Tutor", chiefOfStaff: true } });
    publish(a);
    importInto(b);
    const [[bLocalId, bBot]] = [...b.bots];
    bBot!.changes.name = "Tutor 2";
    a.bots.delete("tutor");
    // a has not published the delete yet: b's edit must not recreate it
    publish(b);
    expect(importInto(a).bots).toEqual([]);
    expect(a.bots.size).toBe(0);
    expect(publish(a)).toMatchObject([{ entityId: "g-a-tutor", deleted: true }]);
    expect(importInto(a).bots).toEqual([]);
    expect(importInto(b).hide).toEqual([{ globalId: "g-a-tutor", localId: bLocalId, tombstoneId: "a-2" }]);
    expect(bBot!.hidden).toBe(true);
    expect(publish(b)).toEqual([]);
    bBot!.hidden = false;
    expect(importInto(b).hide).toEqual([]);
    expect(applySyncOperations(emptyProfileSyncState(), log).bots).toEqual({});
  });
});
