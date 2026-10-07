import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CLOCK_SKEW_SEC } from "../../shared/relay-protocol.ts";
import { InviteStore } from "../src/invites.ts";
import { makePc, openControl, startRelay, type Harness } from "./fixtures.ts";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("accepts a revoked identity after the revocation file disappears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wink-security-"));
  dirs.push(dir);
  const file = join(dir, "revoked-labels");
  const pc = makePc();
  await writeFile(file, `${pc.label}\n`);
  h = await startRelay({ revokedLabelsFile: file });
  await expect(openControl(h, pc)).rejects.toThrow();
  await rm(file);
  await h.relay.reloadRevocations();
  const control = await openControl(h, pc);
  expect(h.relay.hub.status(pc.label).online).toBe(true);
  control.socket.destroy();
});

it("retains expired invite entries while the service stays running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wink-security-"));
  dirs.push(dir);
  let now = Date.now();
  const store = await InviteStore.open(dir, () => now);
  const exp = Math.floor(now / 1000) + 60;
  expect(store.consume("expired-test-invite", exp)).toBe(true);
  await store.persist("expired-test-invite", exp);
  now = (exp + CLOCK_SKEW_SEC + 1) * 1000;
  expect(store.consume("current-test-invite", Math.floor(now / 1000) + 60)).toBe(true);
  expect(store.size).toBe(2);
});
