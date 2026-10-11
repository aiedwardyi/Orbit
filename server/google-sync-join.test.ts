import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeDeviceRecord } from "./device-sync.ts";
import { GoogleAccount, type GoogleSession } from "./google-account.ts";
import { createGoogleSync, readGoogleBinding, type GoogleSync } from "./google-sync.ts";
import { ensureMemorySyncDevice, type MemorySyncLedger } from "./memory-sync.ts";
import { createSyncOperation, loadOrCreateSyncWorkspace, readSyncOperations, writeSyncOperation } from "./profile-sync.ts";
import { FakeDrive } from "./testing/fake-drive.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const A: GoogleSession = { refreshToken: "refresh-a", sub: "account-a", email: "a@example.com" };
const tokenFetch: typeof fetch = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));

interface LocalBot { id: string; syncId: string; name: string; talked: boolean; published: boolean }
interface Fault { match: (method: string, url: URL) => boolean; skip: number; reply: () => Response; hits: number }
interface PC {
  name: string; dataDir: string; deviceId: string; account: GoogleAccount; sync: GoogleSync; ledger: MemorySyncLedger;
  bots: LocalBot[]; folder: string | null; workspaceId: string; sequence: number; activations: Array<string | null>; fault: Fault | null;
}

type Booting = Omit<PC, "sync"> & { sync?: GoogleSync };

let root: string;
let drive: FakeDrive;
let pcs: PC[];

const bot = (name: string, talked = true): LocalBot => ({ id: `local-${name}`, syncId: randomUUID(), name, talked, published: false });
const botNames = (folder: string) => readSyncOperations(folder).operations.filter((op) => op.entity === "bot").map((op) => String(op.changes?.name)).sort();
const listing = (method: string, url: URL) => method === "GET" && url.pathname === "/drive/v3/files";
const rootLookup = (method: string, url: URL) => listing(method, url) && (url.searchParams.get("q") ?? "").includes("winkRoot");
const download = (method: string, url: URL) => method === "GET" && url.searchParams.get("alt") === "media";
const driveError = (status: number, domain: string, reason: string) => () => new Response(JSON.stringify({ error: { code: status, errors: [{ domain, reason }] } }), { status, headers: { "content-type": "application/json" } });
const fault = (match: Fault["match"], reply: Fault["reply"], skip = 0): Fault => ({ match, skip, reply, hits: 0 });

function publish(pc: Booting): void {
  const folder = pc.folder;
  if (!folder) return;
  for (const item of pc.bots) {
    if ((pc.sync?.held(item.id) && !item.talked) || item.published) continue;
    writeSyncOperation(folder, createSyncOperation({
      operationId: randomUUID(), deviceId: pc.deviceId, sequence: pc.sequence++, recordedAt: 1_800_000_000_000,
      entity: "bot", entityId: item.syncId, changes: { name: item.name },
    }));
    item.published = true;
  }
  writeDeviceRecord(folder, { deviceId: pc.deviceId, name: pc.name, host: `${pc.name}.example.ts.net`, chatSync: 2 }, 1_800_000_000_000);
}

function boot(pc: Booting): GoogleSync {
  return createGoogleSync({
    dataDir: pc.dataDir,
    account: pc.account,
    folder: () => pc.folder,
    prepare: () => void ensureMemorySyncDevice(pc.ledger),
    ownIds: () => ({ profileDeviceId: pc.deviceId, writerId: `writer-${pc.name}`, memoryDeviceId: pc.ledger.device! }),
    unusedBots: () => pc.bots.filter((item) => !item.talked).map((item) => item.id),
    activate: (mirror) => {
      pc.activations.push(existsSync(join(mirror, "workspace.json")) ? readFileSync(join(mirror, "workspace.json"), "utf8") : null);
      pc.folder = mirror;
      pc.workspaceId = loadOrCreateSyncWorkspace(mirror, pc.workspaceId);
      publish(pc);
      return pc.workspaceId;
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const armed = pc.fault;
      if (armed?.match(request.method, url)) {
        if (armed.skip > 0) armed.skip -= 1;
        else {
          armed.hits += 1;
          return armed.reply();
        }
      }
      return drive.fetch(input, init);
    },
    log: () => {},
  });
}

function makePC(name: string, bots: LocalBot[]): PC {
  const dataDir = join(root, name);
  mkdirSync(dataDir, { recursive: true });
  const base: Booting = {
    name, dataDir, deviceId: `device-${name}`, ledger: { bots: {} }, bots, folder: null, workspaceId: randomUUID(), sequence: 1, activations: [], fault: null,
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

async function startOn(pc: PC): Promise<void> {
  pc.account.setSession(A);
  await pc.sync.start();
  await pc.sync.idle();
}

/** Home uploads one bot; work signs in to the same account with one unused bot and taps Start while the fault is armed. */
async function joinUnder(armed: Fault) {
  const home = makePC("home", [bot("Counsel")]);
  await startOn(home);
  const work = makePC("work", [bot("Starter", false)]);
  work.account.setSession(A);
  await work.sync.read();
  work.fault = armed;
  await work.sync.start();
  await work.sync.idle();
  return { home, work };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-google-join-"));
  drive = new FakeDrive();
  pcs = [];
});

afterEach(() => {
  for (const pc of pcs) pc.sync.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("Google sync join under Drive errors", () => {
  it.each([
    ["a bare 429 on the mirror's first listing", () => fault(rootLookup, () => new Response(null, { status: 429 }), 1)],
    ["a 429 on the first download", () => fault(download, () => new Response(null, { status: 429 }))],
    ["a 403 userRateLimitExceeded on a listing", () => fault(rootLookup, driveError(403, "usageLimits", "userRateLimitExceeded"), 1)],
  ])("keeps joining after %s and joins the home workspace on a clean pass", async (_name, make) => {
    const armed = make();
    const { home, work } = await joinUnder(armed);
    expect(armed.hits).toBeGreaterThan(0);
    expect(readGoogleBinding(work.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "joining", workspaceId: null } });
    expect(work.activations).toEqual([]);
    expect(work.sync.status().state).not.toBe("up-to-date");

    work.fault = null;
    await settle(work);
    expect(readGoogleBinding(work.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "ready", workspaceId: home.workspaceId } });
    expect(work.workspaceId).toBe(home.workspaceId);
    expect(work.sync.held("local-Starter")).toBe(true);
    await settle(home);
    expect(botNames(home.folder!)).toEqual(["Counsel"]);
    expect(botNames(work.folder!)).toEqual(["Counsel"]);
  });

  it("reads a permanent Drive error during the join as error, then recovers on a clean pass", async () => {
    const { home, work } = await joinUnder(fault(listing, driveError(403, "global", "insufficientPermissions")));
    expect(readGoogleBinding(work.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "joining" } });
    expect(work.sync.status().state).toBe("error");

    work.fault = null;
    await settle(work);
    expect(work.sync.status().state).toBe("up-to-date");
    expect(work.workspaceId).toBe(home.workspaceId);
    expect(work.sync.held("local-Starter")).toBe(true);
  });
});
