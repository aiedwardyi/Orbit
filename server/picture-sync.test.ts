import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { publishThreadPictures, publishUnsyncedPictures, pruneSyncedPictures, pullSyncedPicture, PICTURE_MAX_BYTES, PICTURE_MAX_AGE_MS, PICTURES_DIR } from "./picture-sync.ts";
import { loadThreadSyncLedger, saveThreadSyncLedger, uploadThread, type LocalThread, type ThreadSyncHost } from "./thread-sync.ts";

const roots: string[] = [];
const BOT = "sync-bot-1";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function hostFor(dataDir: string, folder: string, threads: Map<string, LocalThread>): ThreadSyncHost {
  const host: ThreadSyncHost = {
    folder,
    dataDir,
    deviceId: "device-a",
    ledger: loadThreadSyncLedger(dataDir),
    saveLedger: () => saveThreadSyncLedger(dataDir, host.ledger),
    local: (threadId) => threads.get(threadId) ?? null,
    running: () => false,
    adopt: (_botId, file) => {
      threads.set(file.task.threadId, {
        title: file.task.title,
        createdAt: file.task.createdAt,
        messages: structuredClone(file.messages),
        activeLeafId: file.activeLeafId,
      });
    },
    remove: (_botId, threadId) => void threads.delete(threadId),
    conflicted: () => {},
    now: () => 1_700_000_000_500,
  };
  return host;
}

describe("picture sync", () => {
  it("copies a picture once and leaves the thread JSON byte-identical", () => {
    const folder = temp("pic-sync-");
    const dataDir = temp("pic-a-");
    const attachments = join(dataDir, "attachments");
    mkdirSync(attachments, { recursive: true });
    const shown = "11111111-1111-4111-8111-111111111111.png";
    const attached = "22222222-2222-4222-8222-222222222222.png";
    const shownBytes = Buffer.from("shown-pixels-phone-media");
    const attachedBytes = Buffer.from("attached-pixels-phone-media");
    writeFileSync(join(attachments, shown), shownBytes);
    writeFileSync(join(attachments, attached), attachedBytes);
    const attachedPath = join(attachments, attached);
    const threads = new Map<string, LocalThread>();
    threads.set("t1", {
      title: "Pics",
      createdAt: 1_700_000_000_000,
      activeLeafId: "m2",
      messages: [
        { id: "m1", role: "bot", kind: "screen", image: shown, shown: true, text: "Mockup", at: 1_700_000_000_000, parentId: null },
        { id: "m2", role: "user", kind: "text", text: `see\n\n<attached-image path="${attachedPath}" />`, at: 1_700_000_000_000, parentId: "m1" },
      ],
    });
    const host = hostFor(dataDir, folder, threads);
    expect(uploadThread(host, BOT, "t1")).toBe("written");
    const threadPath = join(folder, "threads", BOT, "t1.json");
    const threadBytes = readFileSync(threadPath);
    expect(threadBytes.includes(shownBytes)).toBe(false);
    expect(threadBytes.includes(attachedBytes)).toBe(false);
    expect(readFileSync(join(folder, PICTURES_DIR, shown)).equals(shownBytes)).toBe(true);
    expect(readFileSync(join(folder, PICTURES_DIR, attached)).equals(attachedBytes)).toBe(true);

    writeFileSync(join(attachments, shown), Buffer.from("rewritten-pixels"));
    const again = threads.get("t1")!;
    publishThreadPictures({ folder, dataDir, messages: again.messages, now: 1_700_000_000_500 });
    expect(readFileSync(threadPath).equals(threadBytes)).toBe(true);
    expect(readFileSync(join(folder, PICTURES_DIR, shown)).equals(shownBytes)).toBe(true);
    expect(statSync(join(dataDir, "attachments", shown)).isFile()).toBe(true);
  });

  it("serves a synced picture on a second PC after a local miss", () => {
    const folder = temp("pic-share-");
    const dataA = temp("pic-pc-a-");
    const attachmentsA = join(dataA, "attachments");
    mkdirSync(attachmentsA, { recursive: true });
    const name = "33333333-3333-4333-8333-333333333333.png";
    const bytes = Buffer.from("cross-pc-pixels");
    writeFileSync(join(attachmentsA, name), bytes);
    const threads = new Map<string, LocalThread>();
    threads.set("t1", {
      title: "Pics",
      createdAt: 1,
      activeLeafId: "m1",
      messages: [{ id: "m1", role: "bot", kind: "screen", image: name, shown: true, at: 1_700_000_000_000, parentId: null }],
    });
    expect(uploadThread(hostFor(dataA, folder, threads), BOT, "t1")).toBe("written");

    const dataB = temp("pic-pc-b-");
    const attachmentsB = join(dataB, "attachments");
    expect(pullSyncedPicture(folder, attachmentsB, name)).toBe(true);
    expect(readFileSync(join(attachmentsB, name)).equals(bytes)).toBe(true);
    expect(readFileSync(join(attachmentsA, name)).equals(bytes)).toBe(true);
  });

  it("skips pictures over 10 MB", () => {
    const folder = temp("pic-big-");
    const dataDir = temp("pic-big-a-");
    const attachments = join(dataDir, "attachments");
    mkdirSync(attachments, { recursive: true });
    const name = "44444444-4444-4444-8444-444444444444.png";
    writeFileSync(join(attachments, name), Buffer.alloc(PICTURE_MAX_BYTES + 1, 7));
    publishThreadPictures({
      folder,
      dataDir,
      now: 1_700_000_000_000,
      messages: [{ image: name, text: "", at: 1_700_000_000_000 }],
    });
    expect(statSync(join(attachments, name)).isFile()).toBe(true);
    let copied = true;
    try {
      statSync(join(folder, PICTURES_DIR, name));
    } catch {
      copied = false;
    }
    expect(copied).toBe(false);
  });

  it("prunes only this PC's pictures older than 30 days", () => {
    const folder = temp("pic-prune-");
    const dataDir = temp("pic-prune-a-");
    const attachments = join(dataDir, "attachments");
    mkdirSync(attachments, { recursive: true });
    const oldName = "55555555-5555-4555-8555-555555555555.png";
    const keptName = "66666666-6666-4666-8666-666666666666.png";
    const foreign = "77777777-7777-4777-8777-777777777777.png";
    const oldBytes = Buffer.from("old");
    const keptBytes = Buffer.from("kept");
    writeFileSync(join(attachments, oldName), oldBytes);
    writeFileSync(join(attachments, keptName), keptBytes);
    const t0 = 1_700_000_000_000;
    publishThreadPictures({
      folder,
      dataDir,
      now: t0,
      messages: [{ image: oldName, at: t0 }],
    });
    publishThreadPictures({
      folder,
      dataDir,
      now: t0 + 2 * 24 * 60 * 60 * 1000,
      messages: [{ image: keptName, at: t0 + 2 * 24 * 60 * 60 * 1000 }],
    });
    mkdirSync(join(folder, PICTURES_DIR), { recursive: true });
    writeFileSync(join(folder, PICTURES_DIR, foreign), Buffer.from("other-pc"));
    pruneSyncedPictures(folder, dataDir, t0 + PICTURE_MAX_AGE_MS + 24 * 60 * 60 * 1000);
    let oldGone = false;
    try {
      statSync(join(folder, PICTURES_DIR, oldName));
    } catch {
      oldGone = true;
    }
    expect(oldGone).toBe(true);
    expect(readFileSync(join(folder, PICTURES_DIR, keptName)).equals(keptBytes)).toBe(true);
    expect(readFileSync(join(folder, PICTURES_DIR, foreign)).equals(Buffer.from("other-pc"))).toBe(true);
    expect(readFileSync(join(attachments, oldName)).equals(oldBytes)).toBe(true);
    expect(readFileSync(join(attachments, keptName)).equals(keptBytes)).toBe(true);
  });

  it("keeps a prune entry while the picture cannot be deleted", () => {
    const folder = temp("pic-prune-locked-");
    const dataDir = temp("pic-prune-locked-a-");
    const attachments = join(dataDir, "attachments");
    mkdirSync(attachments, { recursive: true });
    const name = "dddddddd-dddd-4ddd-8ddd-dddddddddddd.png";
    writeFileSync(join(attachments, name), Buffer.from("locked"));
    const t0 = 1_700_000_000_000;
    publishThreadPictures({ folder, dataDir, now: t0, messages: [{ image: name, at: t0 }] });
    const dest = join(folder, PICTURES_DIR, name);
    rmSync(dest);
    mkdirSync(dest);
    const later = t0 + PICTURE_MAX_AGE_MS + 1;
    pruneSyncedPictures(folder, dataDir, later);
    expect(readFileSync(join(dataDir, "picture-sync.json"), "utf8").includes(name)).toBe(true);
    rmSync(dest, { recursive: true });
    pruneSyncedPictures(folder, dataDir, later);
    expect(readFileSync(join(dataDir, "picture-sync.json"), "utf8").includes(name)).toBe(false);
  });

  it("does not republish a picture once its message is 30 days old", () => {
    const folder = temp("pic-age-");
    const dataDir = temp("pic-age-a-");
    const attachments = join(dataDir, "attachments");
    mkdirSync(attachments, { recursive: true });
    const oldName = "88888888-8888-4888-8888-888888888888.png";
    const freshName = "99999999-9999-4999-8999-999999999999.png";
    const day = 24 * 60 * 60 * 1000;
    const t0 = 1_700_000_000_000;
    writeFileSync(join(attachments, oldName), Buffer.from("old-picture"));
    writeFileSync(join(attachments, freshName), Buffer.from("fresh-picture"));
    publishThreadPictures({
      folder,
      dataDir,
      now: t0,
      messages: [{ image: oldName, at: t0 }],
    });
    expect(readFileSync(join(folder, PICTURES_DIR, oldName)).equals(Buffer.from("old-picture"))).toBe(true);
    publishThreadPictures({
      folder,
      dataDir,
      now: t0 + 31 * day,
      messages: [{ image: oldName, at: t0 }],
    });
    let oldGone = false;
    try {
      statSync(join(folder, PICTURES_DIR, oldName));
    } catch {
      oldGone = true;
    }
    expect(oldGone).toBe(true);
    expect(readFileSync(join(dataDir, "picture-sync.json"), "utf8").includes(oldName)).toBe(false);
    publishThreadPictures({
      folder,
      dataDir,
      now: t0 + 29 * day,
      messages: [{ image: freshName, at: t0 }],
    });
    expect(readFileSync(join(folder, PICTURES_DIR, freshName)).equals(Buffer.from("fresh-picture"))).toBe(true);
  });

  it("publishes a recent picture from a clean synced thread once", () => {
    const folder = temp("pic-backfill-");
    const dataDir = temp("pic-backfill-a-");
    const attachments = join(dataDir, "attachments");
    mkdirSync(attachments, { recursive: true });
    const name = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
    const bytes = Buffer.from("backfill-pixels");
    writeFileSync(join(attachments, name), bytes);
    const now = 1_700_000_000_500;
    const threads = new Map<string, LocalThread>();
    threads.set("t1", {
      title: "Pics",
      createdAt: now,
      activeLeafId: "m1",
      messages: [{ id: "m1", role: "bot", kind: "screen", image: name, shown: true, at: now, parentId: null }],
    });
    const host = hostFor(dataDir, folder, threads);
    expect(uploadThread(host, BOT, "t1")).toBe("written");
    const threadPath = join(folder, "threads", BOT, "t1.json");
    const threadBytes = readFileSync(threadPath);
    rmSync(join(folder, PICTURES_DIR), { recursive: true, force: true });
    rmSync(join(dataDir, "picture-sync.json"), { force: true });
    let reads = 0;
    const pass = () => publishUnsyncedPictures({
      folder,
      dataDir,
      now,
      threadIds: ["t1"],
      messagesFor: () => {
        reads += 1;
        return threads.get("t1")!.messages;
      },
    });
    pass();
    expect(reads).toBe(1);
    expect(readFileSync(join(folder, PICTURES_DIR, name)).equals(bytes)).toBe(true);
    expect(readFileSync(threadPath).equals(threadBytes)).toBe(true);
    pass();
    expect(reads).toBe(1);
    expect(readFileSync(threadPath).equals(threadBytes)).toBe(true);
  });

  it("retries a picture the next pass after publish fails", () => {
    const folder = temp("pic-retry-");
    const dataDir = temp("pic-retry-a-");
    const attachments = join(dataDir, "attachments");
    mkdirSync(attachments, { recursive: true });
    const name = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png";
    const bytes = Buffer.from("retry-pixels");
    writeFileSync(join(attachments, name), bytes);
    const now = 1_700_000_000_500;
    const messages = [{ id: "m1", role: "bot" as const, kind: "screen" as const, image: name, shown: true, at: now, parentId: null }];
    const threads = new Map<string, LocalThread>();
    threads.set("t1", { title: "Pics", createdAt: now, activeLeafId: "m1", messages });
    const host = hostFor(dataDir, folder, threads);
    expect(uploadThread(host, BOT, "t1")).toBe("written");
    const threadPath = join(folder, "threads", BOT, "t1.json");
    const threadBytes = readFileSync(threadPath);
    rmSync(join(folder, PICTURES_DIR), { recursive: true, force: true });
    rmSync(join(dataDir, "picture-sync.json"), { force: true });
    writeFileSync(join(folder, PICTURES_DIR), "blocked");
    const input = {
      folder,
      dataDir,
      now,
      threadIds: ["t1"],
      messagesFor: () => messages,
    };
    publishUnsyncedPictures(input);
    let blocked = true;
    try {
      statSync(join(folder, PICTURES_DIR, name));
    } catch {
      blocked = false;
    }
    expect(blocked).toBe(false);
    expect(readFileSync(threadPath).equals(threadBytes)).toBe(true);
    rmSync(join(folder, PICTURES_DIR), { force: true });
    publishUnsyncedPictures({ ...input, messagesFor: () => { throw new Error("scanned twice"); } });
    expect(readFileSync(join(folder, PICTURES_DIR, name)).equals(bytes)).toBe(true);
    expect(readFileSync(threadPath).equals(threadBytes)).toBe(true);
  });

  it("retries a picture from a scanned thread after its upload publish fails", () => {
    const folder = temp("pic-dirty-retry-");
    const dataDir = temp("pic-dirty-retry-a-");
    const attachments = join(dataDir, "attachments");
    mkdirSync(attachments, { recursive: true });
    const name = "cccccccc-cccc-4ccc-8ccc-cccccccccccc.png";
    const bytes = Buffer.from("dirty-retry-pixels");
    writeFileSync(join(attachments, name), bytes);
    const now = 1_700_000_000_500;
    const input = { folder, dataDir, now, threadIds: ["t1"], messagesFor: () => [] };
    publishUnsyncedPictures(input);
    writeFileSync(join(folder, PICTURES_DIR), "blocked");
    publishThreadPictures({ folder, dataDir, now, messages: [{ image: name, at: now }] });
    rmSync(join(folder, PICTURES_DIR), { force: true });
    publishUnsyncedPictures({ ...input, messagesFor: () => { throw new Error("scanned twice"); } });
    expect(readFileSync(join(folder, PICTURES_DIR, name)).equals(bytes)).toBe(true);
  });

  it("never publishes a picture older than 30 days from a clean thread", () => {
    const folder = temp("pic-old-backfill-");
    const dataDir = temp("pic-old-backfill-a-");
    const attachments = join(dataDir, "attachments");
    mkdirSync(attachments, { recursive: true });
    const name = "cccccccc-cccc-4ccc-8ccc-cccccccccccc.png";
    writeFileSync(join(attachments, name), Buffer.from("too-old"));
    const now = 1_700_000_000_000 + PICTURE_MAX_AGE_MS + 24 * 60 * 60 * 1000;
    publishUnsyncedPictures({
      folder,
      dataDir,
      now,
      threadIds: ["t1"],
      messagesFor: () => [{ image: name, at: 1_700_000_000_000 }],
    });
    let published = true;
    try {
      statSync(join(folder, PICTURES_DIR, name));
    } catch {
      published = false;
    }
    expect(published).toBe(false);
    let ledger = "";
    try {
      ledger = readFileSync(join(dataDir, "picture-sync.json"), "utf8");
    } catch {
      ledger = "";
    }
    expect(ledger.includes(name)).toBe(false);
  });
});
