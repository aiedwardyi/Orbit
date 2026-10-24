import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGroupRoutes } from "./group-routes.ts";
import { Store, type GroupRecord } from "./store.ts";
import { DATA_DIR } from "./config.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let dir: string | undefined;
afterEach(async () => { if (dir) await removeTempDir(dir); });

function fixture() {
  dir = mkdtempSync(join(tmpdir(), "folder-pick-"));
  const missing = join(dir, "gone");
  const replacement = join(dir, "new-project");
  mkdirSync(replacement);
  const store = new Store(() => ({ instanceId: "fake", model: "m" }));
  const a = store.createBot();
  const b = store.createBot();
  const group = store.createGroup("Project", [a.id, b.id]);
  store.patchGroup(group.id, { cwd: missing, pinnedMessageId: "pin" });
  store.titleGroupTaskFromFirstMessage(group.id, "Keep this task", group.threadId);
  store.pinGroupCwd(group.id, group.threadId);
  store.appendMessage(group.threadId, { role: "user", kind: "text", text: "Keep this transcript" });
  for (const bot of [a, b]) {
    bot.tasks!.push({ threadId: group.threadId, title: "Room", createdAt: 1, resumeCursors: {} });
    store.setResumeCursor(bot.id, "fake", "old-room", group.threadId);
    store.setResumeCursor(bot.id, "fake", "own-task", bot.threadId);
  }
  const routes = createGroupRoutes({ store, groupIsWorking: () => false, publicGroupState: (value: GroupRecord) => value } as unknown as Parameters<typeof createGroupRoutes>[0]);
  const patch = async (cwd: string | null) => {
    const req = Readable.from([JSON.stringify({ cwd })]) as unknown as IncomingMessage;
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await routes.patch(req, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
    return { status: res.writeHead.mock.calls[0][0], body: JSON.parse(res.end.mock.calls[0][0]) };
  };
  return { store, a, b, group, missing, replacement, patch };
}

describe("room folder recovery", () => {
  it("re-pins a missing folder without replacing the task and clears only its members' cursors", async () => {
    const { store, a, b, group, replacement, patch } = fixture();
    const threadId = group.threadId;
    const before = store.messagesFor(threadId);
    expect((await patch(replacement)).status).toBe(200);
    expect(group).toMatchObject({ threadId, cwd: replacement, pinnedCwd: replacement, pinnedMessageId: "pin" });
    expect(store.groupTaskByThread(group.id, threadId)).toMatchObject({ threadId, title: "Keep this task", pinnedCwd: replacement, pinnedMessageId: "pin" });
    expect(store.messagesFor(threadId)).toEqual(before);
    for (const bot of [a, b]) {
      expect(store.taskByThread(bot.id, threadId)?.resumeCursors).toEqual({});
      expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({ fake: "own-task" });
    }
    const saved = JSON.parse(readFileSync(join(DATA_DIR, "groups.json"), "utf8"));
    expect(saved.find((entry: { id: string }) => entry.id === group.id)).toMatchObject({ pinnedCwd: replacement });
  });

  it("keeps the original 409 for an existing pinned directory", async () => {
    const { store, group, missing, replacement, patch } = fixture();
    mkdirSync(missing);
    expect(await patch(replacement)).toEqual({ status: 409, body: { error: "the room's working folder is fixed after its first turn" } });
    expect(store.group(group.id)?.pinnedCwd).toBe(missing);
  });

  it("recovers a pinned path that became a file", async () => {
    const { group, missing, replacement, patch } = fixture();
    writeFileSync(missing, "moved");
    expect((await patch(replacement)).status).toBe(200);
    expect(group.pinnedCwd).toBe(replacement);
  });

  it("rejects a missing replacement without changing the old pin or cursors", async () => {
    const { store, a, group, missing, patch } = fixture();
    expect((await patch(join(dir!, "also-gone"))).status).toBe(400);
    expect(group.pinnedCwd).toBe(missing);
    expect(store.taskByThread(a.id, group.threadId)?.resumeCursors).toEqual({ fake: "old-room" });
  });
});
