import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// deleteBotFully and removeSyncedBots are private to index.ts, which these
// tests must not boot; their wiring is pinned on source, same idiom as chief-of-staff.test.ts.
const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
const fn = (name: string) => {
  const start = index.indexOf(`async function ${name}(`);
  return index.slice(start, index.indexOf("\n}\n", start));
};

let home: string;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "omb-delete-bot-rooms-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store, roomResponders } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })), roomResponders };
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("deleting a bot that leads a room", () => {
  it("drops it from the roster, hands the lead on, and clears its busy claim", async () => {
    const { store, roomResponders } = await freshStore();
    const lead = store.createBot();
    const other = store.createBot();
    const room = store.createGroup("Product", [lead.id, other.id]);
    store.patchGroup(room.id, { busyBotId: lead.id });
    const changes: unknown[] = [];
    store.onChange((change) => changes.push(change));

    expect(store.deleteBot(lead.id)).toBe(true);

    const after = store.group(room.id)!;
    expect(after.memberIds).toEqual([other.id]);
    expect(after.defaultResponder).toEqual({ kind: "member", botId: other.id });
    expect(after.busyBotId).toBeNull();
    const members = after.memberIds.map((id) => store.bot(id)!);
    expect(roomResponders("ship it", members, after.defaultResponder).map((bot) => bot.id)).toEqual([other.id]);
    expect(changes).toContainEqual({ type: "group", groupId: room.id });
  });

  it("keeps a mentions-only room on mentions", async () => {
    const { store } = await freshStore();
    const lead = store.createBot();
    const other = store.createBot();
    const room = store.createGroup("Product", [lead.id, other.id]);
    store.patchGroup(room.id, { defaultResponder: { kind: "mentions" } });

    store.deleteBot(lead.id);

    expect(store.group(room.id)).toMatchObject({ memberIds: [other.id], defaultResponder: { kind: "mentions" } });
  });

  it("leaves a DM pair and a sole-member room as a member edit would", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const peer = store.createBot();
    const solo = store.createGroup("Solo", [bot.id]);
    const dm = store.createGroup("DM", [bot.id, peer.id], true);
    store.patchGroup(dm.id, { busyBotId: bot.id });

    store.deleteBot(bot.id);

    expect(store.group(solo.id)?.memberIds).toEqual([bot.id]);
    expect(store.group(dm.id)).toMatchObject({ memberIds: [bot.id, peer.id], busyBotId: null });
  });
});

describe("deleteBotFully", () => {
  it("is the path a delete synced from another PC takes", async () => {
    expect(fn("removeSyncedBots")).toContain("await deleteBotFully(bot);");
    expect(fn("deleteBotFully")).toContain("store.deleteBot(bot.id);");
    // what that path does to rooms here
    const { store } = await freshStore();
    const lead = store.createBot();
    const other = store.createBot();
    const room = store.createGroup("Product", [lead.id, other.id]);
    store.deleteBot(lead.id);
    expect(store.group(room.id)?.memberIds).toEqual([other.id]);
  });

  it("interrupts a room turn the bot is running before the store forgets the room claim", () => {
    const body = fn("deleteBotFully");
    const lookup = body.indexOf("store.groups.find((g) => g.busyBotId === bot.id)");
    const interrupt = body.indexOf("interruptTurn(busyGroup.threadId)");
    expect(lookup).toBeGreaterThan(-1);
    expect(interrupt).toBeGreaterThan(lookup);
    expect(body.indexOf("store.deleteBot(bot.id);")).toBeGreaterThan(interrupt);
  });
});
