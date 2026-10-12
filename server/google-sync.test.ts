import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeDeviceRecord } from "./device-sync.ts";
import { decodeDrivePath } from "./drive-mirror.ts";
import { GoogleAccount, type GoogleSession } from "./google-account.ts";
import { GOOGLE_BINDING_FILE, GOOGLE_TABLE_FILE, createGoogleSync, googleSyncRoute, readGoogleBinding, type GoogleSync } from "./google-sync.ts";
import { ensureMemorySyncDevice, syncBotMemory, type MemorySyncLedger } from "./memory-sync.ts";
import { createSyncOperation, loadOrCreateSyncWorkspace, readSyncOperations, writeSyncOperation } from "./profile-sync.ts";
import { FakeDrive } from "./testing/fake-drive.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const A: GoogleSession = { refreshToken: "refresh-a", sub: "account-a", email: "a@example.com" };
const B: GoogleSession = { refreshToken: "refresh-b", sub: "account-b", email: "b@example.com" };
const tokenFetch: typeof fetch = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));

interface LocalBot { id: string; syncId: string; name: string; talked: boolean; memory: string; chats: string[]; published: boolean }
interface PC {
  name: string; dataDir: string; deviceId: string; writerId: string; account: GoogleAccount; sync: GoogleSync; ledger: MemorySyncLedger;
  bots: LocalBot[]; pictures: Record<string, string>; folder: string | null; workspaceId: string; sequence: number;
  activations: Array<string | null>; logs: string[]; hang: boolean; republishing: boolean;
}

type Booting = Omit<PC, "sync"> & { sync?: GoogleSync };

let root: string;
let drives: Map<string, FakeDrive>;
let pcs: PC[];

const driveA = () => drives.get(A.sub)!;
const driveFiles = (drive: FakeDrive) => [...drive.records.values()].filter(({ file }) => file.appProperties?.ph).map(({ file, bytes }) => ({ path: decodeDrivePath(file.name)!, bytes: bytes.toString("utf8") }));
const drivePaths = (drive: FakeDrive) => driveFiles(drive).map((file) => file.path).sort();

function files(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(join(dir, entry.name), path) : [path];
  }).sort();
}

function bot(name: string, options: Partial<LocalBot> = {}): LocalBot {
  return { id: `local-${name}`, syncId: randomUUID(), name, talked: true, memory: `${name} remembers the case.\n`, chats: [`thread-${name}`], published: false, ...options };
}

function write(folder: string, path: string, text: string): void {
  const target = join(folder, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

const workspace = (pc: Booting, item: LocalBot) => join(pc.dataDir, "bots", item.id);

/** What the engines write into the folder they are pointed at. */
function publish(pc: Booting): void {
  const folder = pc.folder;
  if (!folder) return;
  for (const item of pc.bots) {
    if (pc.sync?.held(item.id) && !item.talked) continue;
    if (!item.published) {
      writeSyncOperation(folder, createSyncOperation({
        operationId: randomUUID(), deviceId: pc.deviceId, sequence: pc.sequence++, recordedAt: 1_800_000_000_000,
        entity: "bot", entityId: item.syncId, changes: { name: item.name },
      }));
      item.published = true;
    }
    mkdirSync(workspace(pc, item), { recursive: true });
    if (item.memory && !existsSync(join(workspace(pc, item), "MEMORY.md"))) writeFileSync(join(workspace(pc, item), "MEMORY.md"), item.memory);
    syncBotMemory(folder, item.syncId, workspace(pc, item), pc.ledger);
    for (const thread of item.chats) {
      const dir = `threads-v2/${item.syncId}/${thread}/${pc.writerId}`;
      if (!existsSync(join(folder, ...dir.split("/"), "seg-1-1.json.gz"))) write(folder, `${dir}/seg-1-1.json.gz`, `${thread} rows`);
      write(folder, `${dir}/head.json`, JSON.stringify({ thread, cut: 1 }));
    }
  }
  for (const [name, text] of Object.entries(pc.pictures)) if (!existsSync(join(folder, "pictures", name))) write(folder, `pictures/${name}`, text);
  writeDeviceRecord(folder, { deviceId: pc.deviceId, name: pc.name, host: `${pc.name}.example.ts.net`, chatSync: 2 }, 1_800_000_000_000);
}

/** What the engines read back from the folder: peers' bots and their memory. */
function importPeers(pc: PC): void {
  const folder = pc.folder!;
  for (const op of readSyncOperations(folder).operations) {
    if (op.entity !== "bot" || op.deviceId === pc.deviceId || pc.bots.some((item) => item.syncId === op.entityId)) continue;
    pc.bots.push(bot(String(op.changes?.name), { id: `imported-${op.entityId}`, syncId: op.entityId, talked: false, memory: "", chats: [], published: true }));
  }
  for (const item of pc.bots) {
    mkdirSync(workspace(pc, item), { recursive: true });
    syncBotMemory(folder, item.syncId, workspace(pc, item), pc.ledger);
  }
}

function boot(pc: Booting): GoogleSync {
  return createGoogleSync({
    dataDir: pc.dataDir,
    account: pc.account,
    folder: () => pc.folder,
    prepare: () => void ensureMemorySyncDevice(pc.ledger),
    ownIds: () => ({ profileDeviceId: pc.deviceId, writerId: pc.writerId, memoryDeviceId: pc.ledger.device! }),
    unusedBots: () => pc.bots.filter((item) => !item.talked).map((item) => item.id),
    activate: (mirror) => {
      pc.activations.push(existsSync(join(mirror, "workspace.json")) ? readFileSync(join(mirror, "workspace.json"), "utf8") : null);
      pc.folder = mirror;
      pc.workspaceId = loadOrCreateSyncWorkspace(mirror, pc.workspaceId);
      publish(pc);
      return pc.workspaceId;
    },
    republishing: () => pc.republishing,
    fetch: (input, init) => {
      if (pc.hang) return new Promise(() => {});
      const owner = pc.account.owner();
      return owner ? drives.get(owner.sub)!.fetch(input, init) : Promise.reject(new Error("signed out"));
    },
    log: (line) => void pc.logs.push(line),
  });
}

function makePC(name: string, options: { bots?: LocalBot[]; pictures?: Record<string, string> } = {}): PC {
  const dataDir = join(root, name);
  mkdirSync(dataDir, { recursive: true });
  const base: Booting = {
    name, dataDir, deviceId: `device-${name}`, writerId: `writer-${name}`, ledger: { bots: {} }, bots: options.bots ?? [], pictures: options.pictures ?? {},
    folder: null, workspaceId: randomUUID(), sequence: 1, activations: [], logs: [], hang: false, republishing: false,
    account: new GoogleAccount(CLIENT, null, { fetch: tokenFetch, log: () => {} }),
  };
  const pc: PC = Object.assign(base, { sync: boot(base) });
  pcs.push(pc);
  return pc;
}

async function settle(pc: PC): Promise<void> {
  await pc.sync.kick();
  await pc.sync.idle();
}

async function startOn(pc: PC, session = A) {
  pc.account.setSession(session);
  const started = await pc.sync.start();
  await pc.sync.idle();
  return started;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-google-sync-"));
  drives = new Map([[A.sub, new FakeDrive()], [B.sub, new FakeDrive()]]);
  pcs = [];
});

afterEach(() => {
  for (const pc of pcs) {
    pc.sync.stop();
    if (pc.folder) expect(statSync(pc.folder).isDirectory()).toBe(true);
  }
  rmSync(root, { recursive: true, force: true });
});

describe("Google sync journeys", () => {
  it("journey 1: weeks of local data reach Drive and a fresh second PC gets it all", async () => {
    const home = makePC("home", { bots: [bot("Counsel"), bot("Clerk")], pictures: { "scan.png": "scan bytes" } });
    home.account.setSession(A);
    expect(await home.sync.read()).toMatchObject({ state: "ready", email: A.email, boundEmail: null, join: { first: true, pcs: 0 } });
    expect((await home.sync.start()).body.state).toBe("joining");
    await home.sync.idle();
    expect(home.sync.status()).toMatchObject({ state: "up-to-date", boundEmail: A.email, progress: null });
    expect(drivePaths(driveA())).toEqual(files(home.folder!));

    const work = makePC("work");
    work.account.setSession(A);
    expect((await work.sync.read()).join).toEqual({ first: false, pcs: 1 });
    await work.sync.start();
    await work.sync.idle();
    importPeers(work);
    expect(work.workspaceId).toBe(home.workspaceId);
    expect(work.bots.map((item) => item.name).sort()).toEqual(["Clerk", "Counsel"]);
    for (const item of work.bots) expect(readFileSync(join(workspace(work, item), "MEMORY.md"), "utf8")).toBe(`${item.name} remembers the case.\n`);
    for (const path of files(home.folder!).filter((path) => path.startsWith("threads-v2/") || path.startsWith("pictures/"))) {
      expect(readFileSync(join(work.folder!, ...path.split("/")), "utf8")).toBe(readFileSync(join(home.folder!, ...path.split("/")), "utf8"));
    }
  });

  it("journey 2: a fresh PC joins mid-upload, keeps the workspace and holds its unused first bot", async () => {
    const home = makePC("home", { bots: [bot("Counsel")] });
    await startOn(home);
    home.bots.push(bot("Paralegal"));
    publish(home);

    const work = makePC("work", { bots: [bot("Starter", { talked: false })] });
    await startOn(work);
    expect(work.activations).toHaveLength(1);
    expect(JSON.parse(work.activations[0]!).workspaceId).toBe(home.workspaceId);
    expect(work.workspaceId).toBe(home.workspaceId);
    expect(work.sync.held("local-Starter")).toBe(true);

    await settle(home);
    await settle(work);
    importPeers(work);
    const names = () => readSyncOperations(work.folder!).operations.filter((op) => op.entity === "bot").map((op) => String(op.changes?.name)).sort();
    expect(names()).toEqual(["Counsel", "Paralegal"]);
    expect(drivePaths(driveA()).filter((path) => path.startsWith("changes/"))).toHaveLength(2);

    work.bots.find((item) => item.name === "Starter")!.talked = true;
    publish(work);
    await settle(work);
    await settle(home);
    expect(readSyncOperations(home.folder!).operations.filter((op) => op.entity === "bot").map((op) => String(op.changes?.name)).sort()).toEqual(["Counsel", "Paralegal", "Starter"]);
  });

  it("stays syncing until the engines finish republishing into the mirror", async () => {
    const home = makePC("home", { bots: [bot("Counsel")] });
    home.republishing = true;
    await startOn(home);
    expect(home.sync.status().state).toBe("syncing");

    home.pictures["late.png"] = "late bytes";
    publish(home);
    home.republishing = false;
    await settle(home);
    expect(home.sync.status().state).toBe("up-to-date");
    expect(drivePaths(driveA())).toContain("pictures/late.png");
  });

  it("publishes an unused bot on the first PC of an account", async () => {
    const home = makePC("home", { bots: [bot("Starter", { talked: false })] });
    await startOn(home);
    expect(home.sync.held("local-Starter")).toBe(false);
    expect(drivePaths(driveA()).filter((path) => path.startsWith("changes/"))).toHaveLength(1);
  });

  it("journey 3: two PCs with weeks of data end with both sets, no duplicates, nothing overwritten", async () => {
    const home = makePC("home", { bots: [bot("Counsel"), bot("Clerk")], pictures: { "home.png": "home" } });
    const work = makePC("work", { bots: [bot("Research")], pictures: { "work.png": "work" } });
    await startOn(home);
    const homeMemory = driveFiles(driveA()).filter((file) => file.path.startsWith("memory-v2/"));
    await startOn(work);
    expect(work.workspaceId).toBe(home.workspaceId);
    for (let round = 0; round < 2; round++) {
      for (const pc of [home, work]) {
        importPeers(pc);
        publish(pc);
        await settle(pc);
      }
    }
    expect(files(home.folder!)).toEqual(files(work.folder!));
    expect(drivePaths(driveA())).toEqual(files(home.folder!));
    expect(new Set(drivePaths(driveA())).size).toBe(drivePaths(driveA()).length);
    for (const pc of [home, work]) expect(pc.bots.map((item) => item.name).sort()).toEqual(["Clerk", "Counsel", "Research"]);
    for (const pc of [home, work]) for (const item of pc.bots) expect(readFileSync(join(workspace(pc, item), "MEMORY.md"), "utf8")).toBe(`${item.name} remembers the case.\n`);
    expect(driveFiles(driveA()).filter((file) => homeMemory.some((old) => old.path === file.path))).toEqual(homeMemory);
  });

  it("journey 4: a PC bound to A refuses B and uploads nothing to it", async () => {
    const home = makePC("home", { bots: [bot("Counsel")] });
    await startOn(home);
    const before = driveFiles(driveA());
    const mirror = files(home.folder!);
    home.account.setSession(B);
    expect(await home.sync.read()).toMatchObject({ state: "other-account", email: B.email, boundEmail: A.email, join: null });
    expect((await home.sync.start()).status).toBe(409);
    await settle(home);
    expect(drives.get(B.sub)!.records.size).toBe(0);
    expect(drives.get(B.sub)!.calls).toEqual([]);
    expect(driveFiles(driveA())).toEqual(before);
    expect(files(home.folder!)).toEqual(mirror);
    expect(readGoogleBinding(home.dataDir)).toMatchObject({ kind: "ok", binding: { owner: { sub: A.sub }, emailHint: A.email, phase: "ready" } });
  });

  it("signs out without touching the mirror and resumes the same account with no re-upload", async () => {
    const home = makePC("home", { bots: [bot("Counsel")], pictures: { "old.png": "old" } });
    await startOn(home);
    const uploads = driveA().uploads.length;
    home.account.setSession(null);
    expect(home.sync.status()).toMatchObject({ state: "signed-out", email: null, boundEmail: A.email });
    const calls = driveA().calls.length;
    home.pictures["new.png"] = "new";
    publish(home);
    await settle(home);
    expect(driveA().calls.length).toBe(calls);
    expect(existsSync(join(home.folder!, "pictures", "old.png"))).toBe(true);

    home.account.setSession(A);
    await home.sync.idle();
    expect(driveA().uploads.slice(uploads).map((upload) => decodeDrivePath(upload.name) ?? upload.id)).toEqual(["pictures/new.png"]);
    expect(home.sync.status().state).toBe("up-to-date");
  });
});

describe("Google sync binding", () => {
  it("resumes the join after a crash between the binding write and the first pass", async () => {
    const home = makePC("home", { bots: [bot("Counsel")] });
    home.account.setSession(A);
    await home.sync.read();
    home.hang = true;
    expect((await home.sync.start()).body.state).toBe("joining");
    expect(readGoogleBinding(home.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "joining", rootId: null } });
    home.sync.stop();
    home.hang = false;
    home.sync = boot(home);
    expect(home.sync.status().state).toBe("joining");
    expect(home.activations).toEqual([]);
    expect(driveA().records.size).toBe(0);
    home.sync.resume();
    await home.sync.idle();
    expect(home.activations).toHaveLength(1);
    expect(home.sync.status().state).toBe("up-to-date");
    expect(readGoogleBinding(home.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "ready", rootId: driveA().root().id, workspaceId: home.workspaceId } });
  });

  it.each([
    ["a corrupt binding", (pc: PC) => writeFileSync(join(pc.dataDir, GOOGLE_BINDING_FILE), "{\"version\":1,")],
    ["a binding with an unknown field", (pc: PC) => {
      const binding = JSON.parse(readFileSync(join(pc.dataDir, GOOGLE_BINDING_FILE), "utf8"));
      writeFileSync(join(pc.dataDir, GOOGLE_BINDING_FILE), JSON.stringify({ ...binding, extra: true }));
    }],
    ["a missing binding next to a table", (pc: PC) => rmSync(join(pc.dataDir, GOOGLE_BINDING_FILE))],
    ["a bound PC that lost its table", (pc: PC) => rmSync(join(pc.dataDir, GOOGLE_TABLE_FILE))],
  ])("fails closed on %s", async (_name, damage) => {
    const home = makePC("home", { bots: [bot("Counsel")] });
    await startOn(home);
    home.sync.stop();
    damage(home);
    const calls = driveA().calls.length;
    home.pictures["new.png"] = "new";
    publish(home);
    home.sync = boot(home);
    home.sync.resume();
    await home.sync.idle();
    expect(await home.sync.read()).toMatchObject({ state: "error" });
    expect((await home.sync.start()).status).toBe(409);
    expect(driveA().calls.length).toBe(calls);
    expect(home.activations).toHaveLength(1);
    expect(existsSync(join(home.folder!, "pictures", "new.png"))).toBe(true);
  });

  it("says why a corrupt binding pauses sync", () => {
    const home = makePC("home");
    writeFileSync(join(home.dataDir, GOOGLE_BINDING_FILE), "not json");
    home.sync = boot(home);
    expect(home.logs).toContain("[google-sync] google-binding.json is unreadable; Google sync is paused");
  });

  it("refuses Start in folder mode and never touches that folder", async () => {
    const legacy = join(root, "Drive folder");
    write(legacy, "workspace.json", "{\"legacy\":true}");
    const home = makePC("home", { bots: [bot("Counsel")] });
    home.folder = legacy;
    home.account.setSession(A);
    expect(await home.sync.read()).toMatchObject({ state: "folder", join: null });
    expect((await home.sync.start()).status).toBe(409);
    await settle(home);
    expect(files(legacy)).toEqual(["workspace.json"]);
    expect(readFileSync(join(legacy, "workspace.json"), "utf8")).toBe("{\"legacy\":true}");
    expect(readGoogleBinding(home.dataDir)).toEqual({ kind: "none" });
    expect(driveA().calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(home.activations).toEqual([]);
  });
});

describe("Google sync routes", () => {
  it("returns the exact status shape", async () => {
    const home = makePC("home");
    const reply = await googleSyncRoute("GET", "/api/google-sync", { relay: false, bearerOk: true }, home.sync);
    expect(reply?.status).toBe(200);
    expect(Object.keys(reply!.body).sort()).toEqual(["boundEmail", "email", "join", "lastSyncAt", "progress", "state"]);
    expect(reply!.body).toEqual({ state: "signed-out", email: null, boundEmail: null, join: null, progress: null, lastSyncAt: null });
  });

  it("starts only from ready and answers 409 otherwise", async () => {
    const home = makePC("home");
    const post = () => googleSyncRoute("POST", "/api/google-sync/start", { relay: false, bearerOk: true }, home.sync);
    expect(await post()).toMatchObject({ status: 409, body: { state: "signed-out" } });
    home.account.setSession(A);
    expect(await post()).toMatchObject({ status: 200, body: { state: "joining", email: A.email, boundEmail: A.email } });
    expect(await post()).toMatchObject({ status: 409 });
    await home.sync.idle();
    expect(await post()).toMatchObject({ status: 409, body: { state: "up-to-date" } });
  });

  it.each([
    ["the phone relay", { relay: true, bearerOk: false }],
    ["a remote cookie", { relay: false, bearerOk: false }],
  ])("refuses %s", async (_name, caller) => {
    const home = makePC("home");
    home.account.setSession(A);
    for (const [method, path] of [["GET", "/api/google-sync"], ["POST", "/api/google-sync/start"]]) {
      expect(await googleSyncRoute(method, path, caller, home.sync)).toEqual({ status: 404, body: { error: "not found" } });
    }
    expect(readGoogleBinding(home.dataDir)).toEqual({ kind: "none" });
  });

  it("leaves other paths alone and rejects other methods", async () => {
    const home = makePC("home");
    expect(await googleSyncRoute("GET", "/api/google-account", { relay: false, bearerOk: true }, home.sync)).toBeNull();
    expect(await googleSyncRoute("PUT", "/api/google-sync", { relay: false, bearerOk: true }, home.sync)).toEqual({ status: 405, body: { error: "method not allowed" } });
  });

  it("is wired behind the API auth gate with the relay and bearer flags", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const route = source.indexOf("googleSyncRoute(method, path, { relay, bearerOk: credentials.bearerOk }, googleSync)");
    expect(route).toBeGreaterThan(source.indexOf("return json(res, 401, { error: \"unauthorized\" });"));
    expect(source.includes("const bots = profileSyncBots();")).toBe(true);
    expect(source.indexOf("googleSync.resume();")).toBeGreaterThan(source.lastIndexOf("\nsyncAllThreads();"));
  });
});
