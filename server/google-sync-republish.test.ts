import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodeDrivePath } from "./drive-mirror.ts";
import { GoogleAccount, type GoogleSession } from "./google-account.ts";
import { GOOGLE_REPUBLISHED_FILE, createGoogleSync, type GoogleSync } from "./google-sync.ts";
import { loadOrCreateSyncWorkspace, loadProfileSyncSettings, readSyncOperations, saveProfileSyncSettings, syncedInFolder } from "./profile-sync.ts";
import { FakeDrive } from "./testing/fake-drive.ts";
import type { BotSpec, ReportBot, TestArgs, TestResult } from "./testing/google-sync-pc.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const A: GoogleSession = { refreshToken: "refresh-a", sub: "account-a", email: "a@example.com" };
const tokenFetch: typeof fetch = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));
const BOTS: BotSpec[] = [
  { name: "Counsel", memory: "Counsel: the client prefers email.\n", chats: [{ title: "Case one", rows: 30, pictureAges: [2, 45] }] },
  { name: "Scribe", memory: "Scribe memory.\n", chats: [{ title: "Notes", rows: 3 }] },
  { name: "Ledger", chats: [{ title: "Books", rows: 2, pictureAges: [60] }] },
];

interface PC {
  dataDir: string; account: GoogleAccount; sync: GoogleSync; activations: number; fixed: boolean;
  call(method: string, args?: TestArgs): Promise<TestResult>;
  report(): Promise<ReportBot[]>;
  close(): Promise<void>;
}

type Booting = Omit<PC, "sync"> & { sync?: GoogleSync };

let root: string;
let drive: FakeDrive;
let pcs: PC[];

const drivePaths = () => [...drive.records.values()].filter(({ file }) => file.appProperties?.ph).map(({ file }) => decodeDrivePath(file.name)!);
const sameData = (bots: ReportBot[]) => bots.map(({ pictures: _pictures, ...bot }) => bot);

function boot(pc: Booting): GoogleSync {
  return createGoogleSync({
    dataDir: pc.dataDir,
    account: pc.account,
    folder: () => loadProfileSyncSettings(pc.dataDir).folder,
    prepare: () => {},
    unusedBots: () => [],
    // index.ts activate; `fixed: false` is the 1.0.170 one.
    activate: (mirror) => {
      pc.activations++;
      let settings = loadProfileSyncSettings(pc.dataDir);
      if (settings.folder !== mirror) settings = { ...settings, reviewedResolutions: {}, seenCheckpoint: "" };
      const workspaceId = loadOrCreateSyncWorkspace(mirror, settings.workspaceId);
      if (workspaceId !== settings.workspaceId) settings = { ...settings, workspaceId, botMap: {}, sectionMap: {}, reviewedResolutions: {}, seenCheckpoint: "", syncedHashes: {} };
      settings = { ...settings, folder: mirror, syncChats: true };
      if (pc.fixed) settings.syncedHashes = syncedInFolder(settings.syncedHashes, mirror);
      saveProfileSyncSettings(pc.dataDir, settings);
      if (pc.fixed) void pc.call("republish");
      return workspaceId;
    },
    fetch: (input, init) => drive.fetch(input, init),
    log: () => {},
  });
}

function makePC(name: string, fixed = true): PC {
  const dataDir = join(root, name);
  const worker = new Worker(new URL("./testing/google-sync-pc.ts", import.meta.url), {
    workerData: { dataDir }, env: { ...process.env, OMB_DATA_DIR: dataDir, OMB_THREAD_SYNC_V2: "1" }, execArgv: ["--experimental-strip-types"],
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: TestResult): void; reject(error: Error): void }>();
  worker.on("message", ({ id, value, error }: { id: number; value: TestResult; error?: string }) => {
    const request = pending.get(id);
    pending.delete(id);
    if (error) request?.reject(new Error(error));
    else request?.resolve(value);
  });
  const exited = new Promise<void>((resolve) => worker.on("exit", () => resolve()));
  const base: Booting = {
    dataDir, activations: 0, fixed,
    account: new GoogleAccount(CLIENT, null, { fetch: tokenFetch, log: () => {} }),
    call: (method, args = {}) => new Promise<TestResult>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    }),
    // SAFETY: the fixture's report method answers ReportBot[].
    report: async () => await base.call("report") as ReportBot[],
    async close() {
      base.sync?.stop();
      await base.call("close");
      await worker.terminate();
      await exited;
    },
  };
  const pc: PC = Object.assign(base, { sync: boot(base) });
  pcs.push(pc);
  return pc;
}

async function pass(pc: PC): Promise<void> {
  await pc.call("pass");
  await pc.sync.kick();
  await pc.sync.idle();
}

async function start(pc: PC): Promise<void> {
  pc.account.setSession(A);
  await pc.sync.read();
  await pc.sync.start();
  await pc.sync.idle();
}

/** Folder-sync PC with three bots, then Disconnect. */
async function folderEra(fixed: boolean): Promise<{ home: PC; workspaceId: string }> {
  const home = makePC("home", fixed);
  await home.call("seed", { bots: BOTS });
  await home.call("folder", { folder: join(root, "random-folder") });
  await home.call("pass");
  await home.call("chat", { bot: "Counsel", chat: { title: "After sync", rows: 2, pictureAges: [0] } });
  await home.call("pass");
  const workspaceId = loadProfileSyncSettings(home.dataDir).workspaceId;
  await home.call("folder", { folder: null });
  return { home, workspaceId };
}

async function rounds(n: number): Promise<void> {
  for (let i = 0; i < n; i++) for (const pc of pcs) await pass(pc);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-google-republish-"));
  drive = new FakeDrive();
  drive.pageSize = 1000;
  pcs = [];
});

afterEach(async () => {
  for (const pc of pcs) await pc.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Google Start after folder sync", () => {
  it("uploads every bot, chat, memory and fresh picture for a second PC", { timeout: 120_000 }, async () => {
    const { home, workspaceId } = await folderEra(true);
    await start(home);
    await rounds(2);
    const work = makePC("work");
    await start(work);
    await rounds(3);

    const want = await home.report();
    const got = await work.report();
    expect(sameData(got)).toEqual(sameData(want));
    expect(got.map((bot) => `${bot.name} ${bot.pictures}`)).toEqual(["Counsel 2/3", "Ledger 0/1", "Scribe 0/0"]);
    expect(want.find((bot) => bot.name === "Counsel")!.chats).toEqual(["After sync:3", "Case one:32"]);
    expect(loadProfileSyncSettings(work.dataDir).workspaceId).toBe(workspaceId);
    expect(drivePaths().filter((path) => /^threads-v2\/.*\/seg-/.test(path)).length).toBeGreaterThan(0);
    expect([home.sync.status().state, work.sync.status().state]).toEqual(["up-to-date", "up-to-date"]);
  });

  it("heals a PC that tapped Start on 1.0.170 once, and fills in a PC that joined before", { timeout: 120_000 }, async () => {
    const { home } = await folderEra(false);
    await start(home);
    rmSync(join(home.dataDir, GOOGLE_REPUBLISHED_FILE));
    await rounds(2);
    const work = makePC("work");
    await start(work);
    await rounds(2);
    await home.call("rename", { bot: "Counsel", to: "Counsel 2" });
    await rounds(2);
    expect((await work.report()).map((bot) => `${bot.name} ${bot.chats.join(",")}`)).toEqual(["Counsel 2 After sync:3"]);

    home.sync.stop();
    home.fixed = true;
    home.sync = boot(home);
    home.sync.resume();
    expect(home.activations).toBe(2);
    expect(existsSync(join(home.dataDir, GOOGLE_REPUBLISHED_FILE))).toBe(true);
    await rounds(3);

    const want = await home.report();
    const got = await work.report();
    expect(sameData(got)).toEqual(sameData(want));
    expect(got.map((bot) => `${bot.name} ${bot.pictures}`)).toEqual(["Counsel 2 2/3", "Ledger 0/1", "Scribe 0/0"]);
    const names = readSyncOperations(join(work.dataDir, "google-drive")).operations.map((op) => op.entityId);
    expect(new Set(names).size).toBe(3);

    home.sync.stop();
    home.sync = boot(home);
    home.sync.resume();
    expect(home.activations).toBe(2);
  });

  it("keeps a joining PC's chats under its bots' current sync ids", { timeout: 120_000 }, async () => {
    const { home } = await folderEra(true);
    await start(home);
    await rounds(2);
    const work = makePC("work");
    await work.call("seed", { bots: [{ name: "Local QA", chats: [{ title: "QA notes", rows: 4 }] }] });
    await work.call("folder", { folder: join(root, "other-qa-folder") });
    await work.call("pass");
    await work.call("folder", { folder: null });
    await start(work);
    await rounds(4);
    const local = await work.report();
    const remote = await home.report();
    const qa = local.find((bot) => bot.name === "Local QA");
    const synced = remote.find((bot) => bot.name === "Local QA");
    expect(qa?.chats).toEqual(["QA notes:4"]);
    expect(synced?.chats).toEqual(["QA notes:4"]);
    expect(synced?.syncId).toBe(qa?.syncId);
    expect(drivePaths().some((path) => path.startsWith(`threads-v2/${qa?.syncId}/`))).toBe(true);
    expect([home.sync.status().state, work.sync.status().state]).toEqual(["up-to-date", "up-to-date"]);
  });

  it("heals a PC that already joined under the old bot ids, once", { timeout: 120_000 }, async () => {
    const { home } = await folderEra(true);
    await start(home);
    await rounds(2);
    const work = makePC("work", false);
    await work.call("seed", { bots: [{ name: "Local QA", chats: [{ title: "QA notes", rows: 4 }] }] });
    await work.call("folder", { folder: join(root, "other-qa-folder") });
    await work.call("pass");
    await work.call("folder", { folder: null });
    await start(work);
    await rounds(3);
    const missed = (await home.report()).find((bot) => bot.name === "Local QA");
    expect(missed?.syncId).toBeTruthy();
    expect(missed?.chats).toEqual([]);
    expect((await work.report()).find((bot) => bot.name === "Local QA")?.chats).toEqual(["QA notes:4"]);

    await work.call("start");
    await rounds(4);
    const once = await home.report();
    const local = await work.report();
    const qa = local.find((bot) => bot.name === "Local QA");
    const synced = once.find((bot) => bot.name === "Local QA");
    expect(qa?.chats).toEqual(["QA notes:4"]);
    expect(synced?.chats).toEqual(["QA notes:4"]);
    expect(synced?.syncId).toBe(qa?.syncId);
    expect(once.filter((bot) => bot.name === "Local QA")).toHaveLength(1);
    expect(local.filter((bot) => bot.name === "Local QA")).toHaveLength(1);
    expect([home.sync.status().state, work.sync.status().state]).toEqual(["up-to-date", "up-to-date"]);

    await work.call("start");
    await rounds(2);
    expect(await home.report()).toEqual(once);
    expect(await work.report()).toEqual(local);
    expect(work.activations).toBe(1);
  });
});
