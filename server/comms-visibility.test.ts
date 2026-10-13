// The bot⇄bot channel a peer exchange mirrors into. A pair channel is a
// real room in the sidebar: the user can rename it, file it, and talk in
// it, so ask_bot must not quietly move it out from under them.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { getOrCreateChannel, mirrorExchange, mirrorOutcomeToRoom, postPeerReply, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { prepareModelContext } from "./context-compaction.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord } from "./store.ts";
import { countSessionToolRounds } from "./turn-context.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("postPeerReply", () => {
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

  it("shows the message and the reply under their chips in the asker's chat, in order", () => {
    const channel = getOrCreateChannel(store, from, target);
    mirrorExchange(bus, from, target, "Check the release.", channel);
    const targetBefore = JSON.stringify(store.messagesFor(target.threadId));
    const channelBefore = JSON.stringify(store.messagesFor(channel.threadId));

    expect(postPeerReply(bus, from, target, "Release is green.", channel)).toBe(true);

    const link = { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color };
    expect(store.messagesFor(from.threadId).filter((message) => message.kind === "activity")).toMatchObject([
      { kind: "activity", tool: { name: "Message to @Helper" }, comm: { ...link, peer: "message" }, text: "Check the release." },
      { kind: "activity", tool: { name: "Reply from @Helper" }, comm: { ...link, peer: "reply" }, text: "Release is green." },
    ]);
    expect(store.messagesFor(from.threadId).some((message) => message.from)).toBe(false);
    const received = store.messagesFor(target.threadId).at(-1)!;
    expect(received.tool).toEqual({ name: "Message from @Atlas" });
    expect(received.text).toBeUndefined();
    expect(received.comm?.peer).toBe("from");
    expect(JSON.stringify(store.messagesFor(target.threadId))).toBe(targetBefore);
    expect(JSON.stringify(store.messagesFor(channel.threadId))).toBe(channelBefore);
  });

  it.each([["no text", " \n"], ["no channel", "Release is green."]])("posts no reply row with %s", (_, reply) => {
    const channel = reply.trim() ? undefined : getOrCreateChannel(store, from, target);
    mirrorExchange(bus, from, target, "Check the release.", channel);
    const before = JSON.stringify(store.messagesFor(from.threadId));

    expect(postPeerReply(bus, from, target, reply, channel)).toBe(false);

    expect(JSON.stringify(store.messagesFor(from.threadId))).toBe(before);
  });

  it("keeps the asking bot's attribution on both rows in a room", () => {
    const room = store.createGroup("Release", [from.id, target.id], false);
    const channel = getOrCreateChannel(store, from, target);
    mirrorExchange(bus, from, target, "Check the release.", channel, room.threadId);

    expect(postPeerReply(bus, from, target, "Release is green.", channel, room.threadId)).toBe(true);

    expect(store.messagesFor(room.threadId)).toMatchObject([
      { tool: { name: "Message to @Helper" }, from: { botId: from.id }, comm: { peer: "message" }, text: "Check the release." },
      { tool: { name: "Reply from @Helper" }, from: { botId: from.id }, comm: { peer: "reply" }, text: "Release is green." },
    ]);
    expect(store.messagesFor(from.threadId).some((message) => message.comm)).toBe(false);
  });

  it("leaves the pair channel as today when the ask comes from it", () => {
    const channel = getOrCreateChannel(store, from, target);
    mirrorExchange(bus, from, target, "Check the release.", channel, channel.threadId);

    expect(postPeerReply(bus, from, target, "Release is green.", channel, channel.threadId)).toBe(false);

    const chip = store.messagesFor(channel.threadId).find((message) => message.kind === "activity")!;
    expect(chip.text).toBeUndefined();
    expect(chip.comm?.peer).toBe("message");
    expect(store.messagesFor(channel.threadId).filter((message) => message.kind === "activity")).toHaveLength(1);
  });

  it("keeps both bodies out of the model's replay and the tool-round count", async () => {
    const channel = getOrCreateChannel(store, from, target);
    mirrorExchange(bus, from, target, "Check the zebra release.", channel);
    postPeerReply(bus, from, target, "The okapi build is green.", channel);
    store.appendMessage(from.threadId, { role: "bot", kind: "text", text: "Helper says it is fine." });
    const messages = store.messagesFor(from.threadId);

    const prepared = await prepareModelContext({ messages, contextWindow: 200_000, taskRecordText: "" });

    expect(prepared.status).toBe("ready");
    const replay = JSON.stringify(prepared);
    expect(replay).toContain("Helper says it is fine.");
    expect(replay).not.toContain("zebra");
    expect(replay).not.toContain("okapi");
    expect(countSessionToolRounds(messages)).toBe(0);
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
