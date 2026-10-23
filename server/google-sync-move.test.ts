import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listDevices } from "./device-sync.ts";
import { decodeDrivePath, drivePathHash, drivePathRule, encodeDrivePath } from "./drive-mirror.ts";
import { readDriveOwnIds } from "./drive-own-ids.ts";
import { GoogleAccount, type GoogleSession } from "./google-account.ts";
import { GOOGLE_REPUBLISHED_FILE, createGoogleSync, googleSyncRoute, readGoogleBinding, type GoogleSync } from "./google-sync.ts";
import { loadOrCreateSyncWorkspace, loadProfileSyncSettings, readSyncOperations, saveProfileSyncSettings, syncedInFolder } from "./profile-sync.ts";
import { FakeDrive } from "./testing/fake-drive.ts";
import type { BotSpec, ReportBot, TestArgs, TestResult } from "./testing/google-sync-pc.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const A: GoogleSession = { refreshToken: "refresh-a", sub: "account-a", email: "a@example.com" };
const tokenFetch: typeof fetch = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));
const BOTS: BotSpec[] = [
  { name: "Counsel", memory: "counsel v1", chats: [{ title: "Case", rows: 50, pictureAges: [2, 45] }] },
  { name: "Research", memory: "research v1", chats: [{ title: "Papers", rows: 5 }] },
];

interface PC {
  dataDir: string; account: GoogleAccount; sync: GoogleSync; activations: number; republishes: number; blockJoin: boolean; skew: number;
  call(method: string, args?: TestArgs): Promise<TestResult>;
  report(): Promise<ReportBot[]>;
  close(): Promise<void>;
}
type Booting = Omit<PC, "sync"> & { sync?: GoogleSync };

let root: string;
let folder: string;
let drive: FakeDrive;
let pcs: PC[];
interface Gate { wait: Promise<void>; open(): void }
let gates: Gate[];

function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((done) => { open = done; });
  const value = { wait, open };
  gates.push(value);
  return value;
}

function files(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(join(dir, entry.name), path) : [path];
  }).sort();
}

const hashes = (dir: string) => Object.fromEntries(files(dir).map((path) => [path, createHash("sha256").update(readFileSync(join(dir, path))).digest("hex")]));
const drivePaths = () => [...drive.records.values()].filter(({ file }) => !file.trashed && file.appProperties?.ph).map(({ file }) => decodeDrivePath(file.name)!);
const sameData = (bots: ReportBot[]) => bots.map(({ pictures: _pictures, ...bot }) => bot);

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function boot(pc: Booting): GoogleSync {
  return createGoogleSync({
    dataDir: pc.dataDir,
    account: pc.account,
    folder: () => loadProfileSyncSettings(pc.dataDir).folder,
    prepare: () => {},
    ownIds: () => readDriveOwnIds(pc.dataDir),
    unusedBots: () => [],
    activate: (mirror, moved = false) => {
      pc.activations++;
      let settings = loadProfileSyncSettings(pc.dataDir);
      if (settings.folder !== mirror) settings = { ...settings, reviewedResolutions: {}, seenCheckpoint: "" };
      const workspaceId = loadOrCreateSyncWorkspace(mirror, settings.workspaceId);
      if (workspaceId !== settings.workspaceId) settings = { ...settings, workspaceId, botMap: {}, sectionMap: {}, reviewedResolutions: {}, seenCheckpoint: "", syncedHashes: {} };
      settings = { ...settings, folder: mirror, syncChats: true, syncedHashes: syncedInFolder(settings.syncedHashes, mirror) };
      saveProfileSyncSettings(pc.dataDir, settings);
      if (!moved) {
        pc.republishes++;
        void pc.call("republish");
      }
      return workspaceId;
    },
    fetch: async (input, init) => {
      if (pc.blockJoin && existsSync(join(pc.dataDir, "google-binding.json"))) return new Response(null, { status: 503 });
      return drive.fetch(input, init);
    },
    log: () => {},
    now: () => Date.now() + pc.skew,
    passMs: 3_600_000,
  });
}

function makePC(name: string): PC {
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
  worker.on("error", (error: Error) => { for (const request of pending.values()) request.reject(error); });
  const base: Booting = {
    dataDir, activations: 0, republishes: 0, blockJoin: false, skew: 0,
    account: new GoogleAccount(CLIENT, null, { fetch: tokenFetch, log: () => {} }),
    call: (method, args = {}) => new Promise<TestResult>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    }),
    // SAFETY: The fixture's report method returns ReportBot[].
    report: async () => await base.call("report") as ReportBot[],
    async close() {
      base.sync?.stop();
      await base.sync?.idle();
      await base.call("close");
      await worker.terminate();
    },
  };
  const pc: PC = Object.assign(base, { sync: boot(base) });
  pcs.push(pc);
  return pc;
}

async function seed(pc: PC, bots = BOTS): Promise<void> {
  await pc.call("seed", { bots });
  await pc.call("folder", { folder });
  await pc.call("pass");
}

async function begin(pc: PC, move = false): Promise<void> {
  pc.account.setSession(A);
  const started = await pc.sync.start({ move });
  expect(started.status).toBe(200);
}

async function start(pc: PC, move = false): Promise<void> {
  const before = hashes(folder);
  await begin(pc, move);
  await pc.sync.idle();
  expect(hashes(folder)).toEqual(before);
}

async function rounds(google: PC[], n = 2): Promise<void> {
  for (let i = 0; i < n; i++) for (const pc of google) {
    await pc.call("pass");
    await pc.sync.kick();
    await pc.sync.idle();
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-google-move-"));
  folder = join(root, "folder");
  drive = new FakeDrive();
  drive.pageSize = 1000;
  pcs = [];
  gates = [];
});

afterEach(async () => {
  for (const value of gates) value.open();
  for (const pc of pcs) await pc.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Move from folder sync to Google", { timeout: 60_000 }, () => {
  it("moves three folder PCs and restores every bot, row, memory and fresh picture on D", { timeout: 120_000 }, async () => {
    const home = makePC("home");
    const work = makePC("work");
    const laptop = makePC("laptop");
    await seed(home);
    await seed(work, [{ name: "Ops", memory: "ops v1", chats: [{ title: "Deploys", rows: 40, pictureAges: [3] }] }]);
    await seed(laptop, [{ name: "Travel", memory: "travel v1", chats: [{ title: "Trip", rows: 45, pictureAges: [1] }] }]);
    for (let i = 0; i < 2; i++) for (const pc of pcs) await pc.call("pass");

    const writer = readDriveOwnIds(laptop.dataDir).writerId;
    const writers = new Set(files(join(folder, "threads-v2")).filter((path) => path.split("/")[2] === writer).map((path) => path.split("/").slice(0, 3).join("/")));
    expect(writers.size).toBeGreaterThan(0);
    for (const path of writers) {
      mkdirSync(dirname(join(folder, "threads-v2 (1)", path)), { recursive: true });
      renameSync(join(folder, "threads-v2", path), join(folder, "threads-v2 (1)", path));
    }
    for (const pc of pcs) await pc.call("pass");
    const workspaceId = loadProfileSyncSettings(home.dataDir).workspaceId;
    const maps = pcs.map((pc) => loadProfileSyncSettings(pc.dataDir).botMap);

    home.account.setSession(A);
    expect(await home.sync.read()).toMatchObject({ state: "ready", move: true, join: { first: true, pcs: 0 } });
    await start(home, true);
    expect(new Set(drivePaths())).toEqual(new Set(files(folder)));
    await home.call("chat", { bot: "Counsel", chat: { title: "Home gap", rows: 3, pictureAges: [0] } });
    await rounds([home], 1);

    for (const pc of [work, laptop]) {
      pc.account.setSession(A);
      expect(await pc.sync.read()).toMatchObject({ state: "ready", move: true, join: { first: false, pcs: 3 } });
      if (pc === laptop) {
        await laptop.call("chat", { bot: "Travel", chat: { title: "Laptop gap", rows: 3, pictureAges: [0] } });
        await laptop.call("memory", { bot: "Travel", text: "travel v2 from laptop gap" });
        await laptop.call("pass");
        await work.call("memory", { bot: "Ops", text: "ops v2 from Google" });
        await rounds([home, work]);
      }
      const existing = new Set(drivePaths());
      const uploads = drive.uploads.length;
      await start(pc, true);
      for (const upload of drive.uploads.slice(uploads)) {
        const path = decodeDrivePath(upload.name)!;
        expect(existing.has(path) && drivePathRule(path, readDriveOwnIds(pc.dataDir)) === "once").toBe(false);
      }
      await rounds(pc === work ? [home, work] : [home, work, laptop]);
    }

    const d = makePC("d");
    await d.call("report");
    await start(d);
    await rounds(pcs, 3);
    const want = await home.report();
    const got = await d.report();
    expect(got.map((bot) => `${bot.name} ${bot.chats.join(",")}`)).toEqual([
      "Counsel Case:52,Home gap:4", "Ops Deploys:41", "Research Papers:5", "Travel Laptop gap:4,Trip:46",
    ]);
    expect(got.map((bot) => bot.memory)).toEqual(["counsel v1", "ops v2 from Google", "research v1", "travel v2 from laptop gap"]);
    expect(got.map((bot) => `${bot.name} ${bot.pictures}`)).toEqual(["Counsel 2/3", "Ops 1/1", "Research 0/0", "Travel 2/2"]);
    for (const pc of pcs) {
      expect(sameData(await pc.report())).toEqual(sameData(want));
      expect(loadProfileSyncSettings(pc.dataDir).workspaceId).toBe(workspaceId);
      expect(listDevices(join(pc.dataDir, "google-drive"), "none", Date.now())).toHaveLength(4);
      expect(pc.sync.status().state).toBe("up-to-date");
    }
    for (const [i, pc] of [home, work, laptop].entries()) {
      expect(loadProfileSyncSettings(pc.dataDir).botMap).toEqual(maps[i]);
      expect(pc.republishes).toBe(0);
    }
    expect(drivePaths().some((path) => /^threads-v2 \(1\)\/.*\/seg-/.test(path))).toBe(true);
    expect(drivePaths().filter((path) => path.startsWith("changes/"))).toHaveLength(4);
    expect(new Set(drivePaths()).size).toBe(drivePaths().length);
  });

  it("tops up new files and every own file written during the first upload before switching engines", { timeout: 120_000 }, async () => {
    const home = makePC("home");
    await seed(home);
    const entered = gate();
    const release = gate();
    drive.onCreate = async (file) => {
      if (decodeDrivePath(file.name) !== "workspace.json") return;
      entered.open();
      await release.wait;
    };
    await begin(home, true);
    await entered.wait;
    expect(loadProfileSyncSettings(home.dataDir).folder).toBe(folder);
    expect(home.sync.status()).toMatchObject({ state: "joining", move: true });
    expect(home.activations).toBe(0);
    await home.call("append", { bot: "Counsel", chat: { title: "Case", rows: 3 } });
    await home.call("chat", { bot: "Counsel", chat: { title: "During upload", rows: 2, pictureAges: [0] } });
    await home.call("rename", { bot: "Research", to: "Research 2" });
    await home.call("memory", { bot: "Counsel", text: "memory during upload" });
    await home.call("pass");
    const before = hashes(folder);
    const own = files(folder).filter((path) => drivePathRule(path, readDriveOwnIds(home.dataDir)) === "own");
    expect(own.some((path) => path.startsWith("changes/"))).toBe(true);
    expect(own.some((path) => path.startsWith("devices/"))).toBe(true);
    expect(own.some((path) => path.startsWith("memory-v2/"))).toBe(true);
    expect(own.some((path) => path.endsWith("/head.json"))).toBe(true);
    release.open();
    await home.sync.idle();
    expect(hashes(folder)).toEqual(before);
    for (const path of own) expect(readFileSync(join(home.dataDir, "google-drive", path))).toEqual(readFileSync(join(folder, path)));
    const d = makePC("d");
    await d.call("report");
    await start(d);
    await rounds(pcs, 3);
    expect(sameData(await d.report())).toEqual(sameData(await home.report()));
    expect((await d.report()).map((bot) => `${bot.name} ${bot.chats.join(",")} ${bot.memory} ${bot.pictures}`)).toEqual([
      "Counsel Case:55,During upload:3 memory during upload 2/3", "Research 2 Papers:5 research v1 0/0",
    ]);
    expect(home.republishes).toBe(0);
  });

  it.each([false, true])("refuses another Drive workspace without copying, including a changed preview (%s)", async (changed) => {
    const home = makePC("home");
    await seed(home);
    const workspace = readFileSync(join(folder, "workspace.json"));
    const rootId = drive.root().id;
    const file = drive.add(encodeDrivePath("workspace.json"), { ph: drivePathHash("workspace.json") }, workspace, [rootId]);
    home.account.setSession(A);
    if (changed) expect(await home.sync.read()).toMatchObject({ state: "ready", move: true });
    drive.edit(file.id, Buffer.from(workspace.toString().replace(loadProfileSyncSettings(home.dataDir).workspaceId, "other-workspace")));
    const before = hashes(folder);
    if (!changed) expect(await home.sync.read()).toMatchObject({ move: true, problem: "This Google account syncs other Wink data." });
    expect(await home.sync.start({ move: true })).toMatchObject({ status: 409, body: { move: true, problem: "This Google account syncs other Wink data." } });
    expect(hashes(folder)).toEqual(before);
    expect(files(join(home.dataDir, "google-drive"))).toEqual([]);
    expect(existsSync(join(home.dataDir, "google-move.json"))).toBe(false);
    expect(readGoogleBinding(home.dataDir)).toEqual({ kind: "none" });
    expect(drive.uploads).toEqual([]);
    expect(home.activations).toBe(0);
  });

  it("seeds only accepted missing files, then replaces own files without overwriting peer files", async () => {
    const home = makePC("home");
    await seed(home);
    write(folder, "assets/avatar.png", "folder avatar");
    write(folder, "assets/avatar.png.tmp", "temporary");
    write(folder, "notes.txt", "unknown");
    write(folder, "threads-v2/bot/chat/writer/unknown.json", "unknown nested");
    const mirror = join(home.dataDir, "google-drive");
    write(mirror, "assets/avatar.png", "kept mirror avatar");
    const ownHead = files(folder).find((path) => path.endsWith("/head.json"))!;
    write(mirror, ownHead, "old mirror head");
    write(folder, "devices/peer.json", "old folder peer");
    write(mirror, "devices/peer.json", "new mirror peer");
    const entered = gate();
    const release = gate();
    drive.onCreate = async (file) => {
      if (decodeDrivePath(file.name) !== "workspace.json") return;
      entered.open();
      await release.wait;
    };
    const before = hashes(folder);
    await begin(home, true);
    await entered.wait;
    expect(readFileSync(join(mirror, "assets/avatar.png"), "utf8")).toBe("kept mirror avatar");
    expect(readFileSync(join(mirror, ownHead), "utf8")).toBe("old mirror head");
    expect(files(mirror)).not.toContain("assets/avatar.png.tmp");
    expect(files(mirror)).not.toContain("notes.txt");
    expect(files(mirror)).not.toContain("threads-v2/bot/chat/writer/unknown.json");
    release.open();
    await home.sync.idle();
    expect(readFileSync(join(mirror, ownHead))).toEqual(readFileSync(join(folder, ownHead)));
    expect(readFileSync(join(mirror, "devices/peer.json"), "utf8")).toBe("new mirror peer");
    expect(hashes(folder)).toEqual(before);
    expect(drivePaths()).not.toContain("assets/avatar.png.tmp");
    expect(drivePaths()).not.toContain("notes.txt");
    expect(drivePaths()).not.toContain("threads-v2/bot/chat/writer/unknown.json");
  });

  it("resumes a crash after seed and before the join while engines still use the folder", { timeout: 120_000 }, async () => {
    const home = makePC("home");
    await seed(home);
    const before = hashes(folder);
    home.blockJoin = true;
    await begin(home, true);
    await home.sync.idle();
    expect(hashes(join(home.dataDir, "google-drive"))).toEqual(before);
    expect(readGoogleBinding(home.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "joining" } });
    expect(JSON.parse(readFileSync(join(home.dataDir, "google-move.json"), "utf8"))).toEqual({ from: folder, at: expect.any(Number) });
    expect(home.activations).toBe(0);
    expect(drive.uploads).toEqual([]);
    home.sync.stop();
    home.blockJoin = false;
    home.sync = boot(home);
    home.sync.resume();
    await home.sync.idle();
    expect(home.activations).toBe(1);
    expect(hashes(folder)).toEqual(before);
    expect(home.sync.status().state).toBe("up-to-date");
    expect(home.republishes).toBe(0);
    const d = makePC("d");
    await d.call("report");
    await start(d);
    await rounds(pcs, 3);
    expect(sameData(await d.report())).toEqual(sameData(await home.report()));
  });

  it("keeps ledgers and bot ids and never heals a moved PC twice across restart", async () => {
    const home = makePC("home");
    await seed(home);
    const settings = loadProfileSyncSettings(home.dataDir);
    const ops = readSyncOperations(folder).operations;
    await start(home, true);
    const moved = loadProfileSyncSettings(home.dataDir);
    expect(moved.botMap).toEqual(settings.botMap);
    expect(moved.syncedHashes).toEqual(settings.syncedHashes);
    expect(moved.workspaceId).toBe(settings.workspaceId);
    expect(moved.syncChats).toBe(true);
    expect(home.republishes).toBe(0);
    expect(readSyncOperations(moved.folder!).operations).toEqual(ops);
    expect(existsSync(join(home.dataDir, GOOGLE_REPUBLISHED_FILE))).toBe(true);
    home.sync.stop();
    home.sync = boot(home);
    home.sync.resume();
    await rounds([home]);
    expect(home.activations).toBe(1);
    expect(readSyncOperations(moved.folder!).operations).toEqual(ops);
    expect(home.republishes).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(join(home.dataDir, "google-move.json"), "utf8"))).sort()).toEqual(["at", "from"]);
    expect(readGoogleBinding(home.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "ready", workspaceId: settings.workspaceId } });
  });

  it("holds a Move while Google Drive is full and finishes once Drive has space", async () => {
    const home = makePC("home");
    await seed(home);
    drive.full = true;
    await start(home, true);
    expect(home.sync.status()).toMatchObject({ state: "drive-full", move: true, progress: null });
    expect(readGoogleBinding(home.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "joining" } });
    expect(home.activations).toBe(0);
    drive.full = false;
    home.skew = 5 * 60_000;
    await home.sync.kick();
    await home.sync.idle();
    expect(readGoogleBinding(home.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "ready" } });
    expect(home.activations).toBe(1);
    expect(home.sync.status().state).not.toBe("drive-full");
  });

  it("accepts Move only through the authenticated desktop Start body and leaves plain Start guarded", async () => {
    const home = makePC("home");
    await seed(home);
    expect((await home.sync.start({ move: true })).status).toBe(409);
    home.account.setSession(A);
    expect((await home.sync.start()).status).toBe(409);
    for (const caller of [{ relay: true, bearerOk: true }, { relay: false, bearerOk: false }]) {
      expect(await googleSyncRoute("POST", "/api/google-sync/start", caller, home.sync, async () => ({ move: true }))).toMatchObject({ status: 404 });
    }
    expect(readGoogleBinding(home.dataDir)).toEqual({ kind: "none" });
    expect(await googleSyncRoute("POST", "/api/google-sync/start", { relay: false, bearerOk: true }, home.sync, async () => ({ move: true }))).toMatchObject({ status: 200, body: { state: "joining", move: true } });
    await home.sync.idle();
    expect((await home.sync.start({ move: true })).status).toBe(409);
  });

  it("wires Move activation and the Start body without booting the server", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("activate: (mirror, move)");
    expect(source).toContain("if (!move) threadSyncV2?.republish();");
    expect(source).toContain("googleSync, () => readBody(req)");
  });
});
