import { describe, expect, it } from "vitest";

import { readSnapshotCache, SNAPSHOT_CACHE_KEY, writeSnapshotCache } from "./snapshot-cache";
import type { Bot, Message } from "./store";

const KEY = "sk-proj-abcdefghijklmnop1234567890";

class MemoryStorage {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const storage = () => new MemoryStorage() as unknown as Storage & MemoryStorage;

const bot = (messages: Message[]) =>
  ({ id: "b1", threadId: "t1", name: "Scout", unread: false, color: "blue", messages }) as unknown as Bot;

describe("snapshot cache", () => {
  it("redacts secrets from every cached message, user rows included", () => {
    const local = storage();
    const message: Message = { id: "m1", at: 1, role: "user", kind: "text", text: `my key is ${KEY}` };
    writeSnapshotCache({ bots: [bot([message])], groups: [], selectedId: "b1" }, local);
    expect(local.getItem(SNAPSHOT_CACHE_KEY)).not.toContain(KEY);
    expect(readSnapshotCache(local)?.bots[0].messages[0].text).toMatch(/^my key is «redacted \d+ chars»$/);
    expect(message.text).toContain(KEY);
  });

  it("drops an old unredacted cache on read", () => {
    const local = storage();
    const message: Message = { id: "m1", at: 1, role: "user", kind: "text", text: KEY };
    local.setItem("omb-snapshot", JSON.stringify({ bots: [bot([message])], groups: [], selectedId: "b1" }));
    expect(readSnapshotCache(local)).toBeNull();
    expect(local.getItem("omb-snapshot")).toBeNull();
  });
});
