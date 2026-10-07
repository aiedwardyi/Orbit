import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CLOCK_SKEW_SEC } from "../../shared/relay-protocol.ts";
import { InviteStore, nonceHash } from "../src/invites.ts";
import { makePc, openControl, startRelay, type Harness } from "./fixtures.ts";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("keeps a revoked identity blocked after the revocation file disappears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wink-security-"));
  dirs.push(dir);
  const file = join(dir, "revoked-labels");
  const pc = makePc();
  await writeFile(file, `${pc.label}\n`);
  h = await startRelay({ revokedLabelsFile: file });
  await expect(openControl(h, pc)).rejects.toThrow();
  await rm(file);
  await h.relay.reloadRevocations();
  await expect(openControl(h, pc)).rejects.toThrow();
  expect(h.relay.hub.status(pc.label).online).toBe(false);
  expect(h.logs.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: "revocation-reload-failed", reason: "missing" }));
  await writeFile(file, "");
  await h.relay.reloadRevocations();
  const control = await openControl(h, pc);
  expect(h.relay.hub.status(pc.label).online).toBe(true);
  control.socket.destroy();
});

it("prunes expired invite entries while the service stays running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wink-security-"));
  dirs.push(dir);
  let now = Date.now();
  const store = await InviteStore.open(dir, () => now);
  const exp = Math.floor(now / 1000) + 60;
  expect(store.consume("expired-test-invite", exp)).toBe(true);
  await store.persist("expired-test-invite", exp);
  now = (exp + CLOCK_SKEW_SEC + 1) * 1000;
  expect(store.consume("current-test-invite", Math.floor(now / 1000) + 60)).toBe(true);
  expect(store.size).toBe(1);
  await store.persist("current-test-invite", Math.floor(now / 1000) + 60);
  expect(await store.readRaw()).not.toContain(nonceHash("expired-test-invite"));
  const reopened = await InviteStore.open(dir, () => now);
  expect(reopened.consume("current-test-invite", Math.floor(now / 1000) + 60)).toBe(false);
  expect(reopened.consume("expired-test-invite", exp)).toBe(false);
});

it("retains clock-skew entries and concurrent consumes through journal compaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wink-security-"));
  dirs.push(dir);
  let now = Date.now();
  const store = await InviteStore.open(dir, () => now);
  const exp = Math.floor(now / 1000) + 60;
  store.consume("old", exp);
  await store.persist("old", exp);
  now = (exp + CLOCK_SKEW_SEC - 1) * 1000;
  expect(store.consume("old", exp)).toBe(false);
  now += 1000;
  const liveExp = Math.floor(now / 1000) + 86400;
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    const nonce = `live-${i}`;
    expect(store.consume(nonce, liveExp)).toBe(true);
    writes.push(store.persist(nonce, liveExp));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(writes);
  const reopened = await InviteStore.open(dir, () => now);
  expect(reopened.size).toBe(20);
  for (let i = 0; i < 20; i++) expect(reopened.consume(`live-${i}`, liveExp)).toBe(false);
  expect(await reopened.readRaw()).not.toContain(nonceHash("old"));
});

it("keeps durable consumes when compaction fails and recovers on the next write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wink-security-"));
  dirs.push(dir);
  let now = Date.now();
  const store = await InviteStore.open(dir, () => now);
  const exp = Math.floor(now / 1000) + 60;
  const liveExp = exp + 86400;
  for (const [nonce, expiry] of [["old", exp], ["durable", liveExp]] as const) {
    store.consume(nonce, expiry);
    await store.persist(nonce, expiry);
  }
  now = (exp + CLOCK_SKEW_SEC) * 1000;
  store.consume("pending", liveExp);
  const tmp = join(dir, "used-invites.tmp");
  await mkdir(tmp);
  await expect(store.persist("pending", liveExp)).rejects.toThrow();
  expect(store.consume("pending", liveExp)).toBe(false);
  expect(await store.readRaw()).toContain(nonceHash("durable"));
  await rm(tmp, { recursive: true });
  await store.persist("pending", liveExp);
  const reopened = await InviteStore.open(dir, () => now);
  expect(reopened.consume("durable", liveExp)).toBe(false);
  expect(reopened.consume("pending", liveExp)).toBe(false);
});

it("bounds journal growth across runtime expiry cycles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wink-security-"));
  dirs.push(dir);
  let now = Date.now();
  const store = await InviteStore.open(dir, () => now);
  for (let i = 0; i < 30; i++) {
    const exp = Math.floor(now / 1000) + 1;
    store.consume(`cycle-${i}`, exp);
    await store.persist(`cycle-${i}`, exp);
    expect(store.size).toBe(1);
    expect((await store.readRaw()).length).toBeLessThanOrEqual(78);
    now = (exp + CLOCK_SKEW_SEC) * 1000;
  }
});
