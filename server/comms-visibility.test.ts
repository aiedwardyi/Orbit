// The bot⇄bot channel a peer exchange mirrors into. A pair channel is a
// real room in the sidebar: the user can rename it, file it, and talk in
// it, so ask_bot must not quietly move it out from under them.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { getOrCreateChannel, mirrorExchange, mirrorOutcomeToRoom, settleAskChip, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord, type StoreChange } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("settleAskChip", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let bus: CommsBus;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.patchBot(store.createBot().id, { name: "Atlas" })!;
    target = store.patchBot(store.createBot().id, { name: "Helper" })!;
    bus = { store, broadcast: () => {} };
  });

  it("rewrites the asker's row on a real reply, preserving its link and other transcripts", () => {
    const channel = getOrCreateChannel(store, from, target);
    const chipId = mirrorExchange(bus, from, target, "Check the release.", channel);
    const before = store.messagesFor(from.threadId);
    const chip = before.find((message) => message.id === chipId)!;
    const targetBefore = JSON.stringify(store.messagesFor(target.threadId));
    const channelBefore = JSON.stringify(store.messagesFor(channel.threadId));
    const events: StoreChange[] = [];
    store.onChange((change) => events.push(change));

    settleAskChip(bus, target, from.threadId, chipId, true);
    settleAskChip(bus, target, from.threadId, chipId, true);

    const after = store.messagesFor(from.threadId);
    expect(after).toHaveLength(before.length);
    expect(after.find((message) => message.id === chipId)).toEqual({ ...chip, tool: { name: "@Helper replied" } });
    expect(events).toContainEqual(expect.objectContaining({ type: "message.patch", threadId: from.threadId, message: expect.objectContaining({ id: chipId, comm: chip.comm }) }));
    expect(events.some((event) => event.type === "message")).toBe(false);
    expect(JSON.stringify(store.messagesFor(target.threadId))).toBe(targetBefore);
    expect(JSON.stringify(store.messagesFor(channel.threadId))).toBe(channelBefore);
  });

  it.each(["timeout", "no text", "start failure"])("leaves the source chip unchanged after %s", () => {
    const channel = getOrCreateChannel(store, from, target);
    const chipId = mirrorExchange(bus, from, target, "Check the release.", channel);
    const before = JSON.stringify(store.messagesFor(from.threadId));
    const events: StoreChange[] = [];
    store.onChange((change) => events.push(change));

    settleAskChip(bus, target, from.threadId, chipId, false);

    expect(JSON.stringify(store.messagesFor(from.threadId))).toBe(before);
    expect(store.messagesFor(from.threadId).find((message) => message.id === chipId)?.tool?.name).toBe("Messaged @Helper");
    expect(events).toHaveLength(0);
  });

  it("rewrites a room source in place, keeping the asking bot's attribution", () => {
    const room = store.createGroup("Release", [from.id, target.id], false);
    const channel = getOrCreateChannel(store, from, target);
    const chipId = mirrorExchange(bus, from, target, "Check the release.", channel, room.threadId);
    const before = store.messagesFor(room.threadId).length;

    settleAskChip(bus, target, room.threadId, chipId, true);

    expect(store.messagesFor(room.threadId)).toHaveLength(before);
    expect(store.messagesFor(room.threadId).find((message) => message.id === chipId)).toMatchObject({
      kind: "activity", tool: { name: "@Helper replied" }, from: { botId: from.id },
      comm: { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color },
    });
    expect(store.messagesFor(from.threadId).some((message) => message.comm)).toBe(false);
  });
});

describe("getOrCreateChannel", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.patchBot(store.createBot().id, { name: "Atlas", section: "Launch" })!;
    target = store.patchBot(store.createBot().id, { name: "Helper", section: "Launch" })!;
  });

  it("files a new pair channel under the sender's section", () => {
    const channel = getOrCreateChannel(store, from, target);

    expect(channel.name).toBe("Atlas ⇄ Helper");
    expect(channel.section).toBe("Launch");
  });

  it("keeps a channel the user renamed and filed where they put it", () => {
    const channel = getOrCreateChannel(store, from, target);
    store.patchGroup(channel.id, { name: "PR 39 triage", section: "Archive" });

    const moved = store.patchBot(from.id, { section: "Ops" })!;
    const movedTarget = store.patchBot(target.id, { section: "Ops" })!;
    const reused = getOrCreateChannel(store, moved, movedTarget);

    expect(reused.id).toBe(channel.id);
    expect(reused.name).toBe("PR 39 triage");
    expect(reused.section).toBe("Archive");
  });
});

describe("mirrorOutcomeToRoom", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let bus: CommsBus;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.patchBot(store.createBot().id, { name: "Atlas" })!;
    target = store.patchBot(store.createBot().id, { name: "Helper" })!;
    bus = { store, broadcast: () => {} };
  });

  it("closes the loop in the room the handoff was queued from", () => {
    const room = store.createGroup("Launch", [from.id, target.id], false);
    const channel = getOrCreateChannel(store, from, target);

    mirrorOutcomeToRoom(bus, target, room.threadId, channel, "@Helper finished the delegated task", true);

    const chip = store.messagesFor(room.threadId).at(-1)!;
    expect(chip.kind).toBe("activity");
    expect(chip.tool).toMatchObject({ name: "@Helper finished the delegated task", ok: true });
    expect(chip.from?.botId).toBe(target.id);
    expect(chip.comm?.groupId).toBe(channel.id);
    // the sidebar's room dot reads this flag, so an outcome that leaves it
    // false is invisible to anyone sitting in another conversation
    expect(store.group(room.id)!.unread).toBe(true);
  });

  it("reports a failed handoff in the room too", () => {
    const room = store.createGroup("Launch", [from.id, target.id], false);

    mirrorOutcomeToRoom(bus, target, room.threadId, undefined, "Delegated turn did not finish", false);

    expect(store.messagesFor(room.threadId).at(-1)!.tool).toMatchObject({ ok: false });
  });

  it("adds nothing to a 1:1 source, which already carries the channel chip", () => {
    const channel = getOrCreateChannel(store, from, target);
    const before = store.messagesFor(from.threadId).length;

    mirrorOutcomeToRoom(bus, target, from.threadId, channel, "@Helper finished the delegated task", true);

    expect(store.messagesFor(from.threadId)).toHaveLength(before);
  });

  it("does not double-report into the pair channel itself", () => {
    const channel = getOrCreateChannel(store, from, target);
    const before = store.messagesFor(channel.threadId).length;

    mirrorOutcomeToRoom(bus, target, channel.threadId, channel, "@Helper finished the delegated task", true);

    expect(store.messagesFor(channel.threadId)).toHaveLength(before);
  });
});
