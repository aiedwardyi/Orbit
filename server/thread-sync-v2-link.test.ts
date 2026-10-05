import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "./store.ts";
import { DATA_DIR } from "./config.ts";
import { createSyncEngine } from "./thread-sync-v2-engine.ts";
import { ThreadSyncV2 } from "./thread-sync-v2.ts";

const links = vi.hoisted(() => ({ n: 0 }));

// oxlint-disable-next-line anti-slop/no-module-mocking -- This volume allows hard links, so the refusal has to be injected.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: () => {
      links.n += 1;
      const error = new Error("EPERM");
      Object.assign(error, { code: "EPERM" });
      throw error;
    },
  };
});

const roots: string[] = [];
const clients: ThreadSyncV2[] = [];
const scope = { botSyncId: "bot", threadId: "thread" };
const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", at: 1, text, parentId: null });

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hard-link fallback", () => {
  it("publishes a sealed chat when hard links are refused", async () => {
    links.n = 0;
    const folder = mkdtempSync(join(tmpdir(), "sync-v2-link-"));
    roots.push(folder);
    const engine = createSyncEngine({ folder, dataDir: DATA_DIR, deviceId: "a", headBytes: 4096 });
    for (let i = 0; i < 12; i++) engine.commit(scope, [{ kind: "row", value: msg(`m${i}`, "x".repeat(700)) }]);
    const flushed = engine.flush(scope);
    expect(links.n).toBeGreaterThan(0);
    expect(flushed.segments).toBeGreaterThan(0);
    expect(flushed.sealedThrough).toBeGreaterThan(0);
    const dataDir = mkdtempSync(join(tmpdir(), "sync-v2-link-"));
    roots.push(dataDir);
    const peer = new ThreadSyncV2({ folder, dataDir, deviceId: "b", headBytes: 4096 });
    clients.push(peer);
    await peer.pull(scope);
    const rows = (await peer.scan(scope.threadId)).messages;
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 12 }, (_, i) => `m${i}`));
    expect(rows.every((row) => row.text === "x".repeat(700))).toBe(true);
  });
});
