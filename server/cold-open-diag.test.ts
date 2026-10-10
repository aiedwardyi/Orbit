import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { COLD_OPEN_FILE, COLD_OPEN_KEEP, COLD_OPEN_MAX_BYTES, receiveColdOpen } from "./cold-open-diag.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wink-cold-open-"));
  dirs.push(dir);
  return dir;
}

const post = (body: string) => Readable.from([Buffer.from(body)]);

const record = {
  label: "notification",
  t0: -2100,
  nav: { fetchStart: 3, responseEnd: 310, domContentLoadedEventEnd: 951 },
  firstPaint: 700,
  hello: 1590,
  bots: { start: 1600, end: 2401, transferSize: 285111, encodedBodySize: 284811 },
  chatPaint: 2701,
  jsCached: true,
  navigationType: "navigate",
  displayMode: "standalone",
  visibility: "visible",
  build: "index-DNyEQLOj.js",
  userAgent: "Mozilla/5.0 (Linux; Android 14) SamsungBrowser/27.0",
};

const lines = (dir: string) => readFileSync(join(dir, COLD_OPEN_FILE), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

describe("cold-open diagnostics", () => {
  it("appends one line with the server's receive time", async () => {
    const dir = freshDir();
    expect(await receiveColdOpen(post(JSON.stringify(record)), dir, Date.UTC(2026, 9, 11, 1, 2, 3))).toEqual({ status: 200 });
    expect(await receiveColdOpen(post(JSON.stringify({ ...record, label: "warm" })), dir, Date.UTC(2026, 9, 11, 1, 5))).toEqual({ status: 200 });
    expect(lines(dir)).toEqual([
      { receivedAt: "2026-10-11T01:02:03.000Z", ...record },
      { receivedAt: "2026-10-11T01:05:00.000Z", ...record, label: "warm" },
    ]);
  });

  it("keeps the newest 200 lines", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, "diag"));
    const old = Array.from({ length: COLD_OPEN_KEEP }, (_, i) => JSON.stringify({ receivedAt: "old", n: i })).join("\n");
    writeFileSync(join(dir, COLD_OPEN_FILE), `${old}\n`);
    await receiveColdOpen(post(JSON.stringify(record)), dir);
    const kept = lines(dir);
    expect(kept).toHaveLength(COLD_OPEN_KEEP);
    expect(kept[0]).toEqual({ receivedAt: "old", n: 1 });
    expect(kept.at(-1)).toMatchObject({ label: "notification", chatPaint: 2701 });
  });

  it("rejects a body over 8 KB", async () => {
    const dir = freshDir();
    const big = JSON.stringify({ ...record, userAgent: "x".repeat(COLD_OPEN_MAX_BYTES) });
    expect(await receiveColdOpen(post(big), dir)).toEqual({ status: 413, error: "body too large" });
    expect(existsSync(join(dir, COLD_OPEN_FILE))).toBe(false);
  });

  it.each([
    ["not JSON", "{label:"],
    ["an unknown field", JSON.stringify({ ...record, threadId: "t-secret" })],
    ["an unknown label", JSON.stringify({ ...record, label: "boot" })],
    ["no display mode", JSON.stringify({ ...record, displayMode: undefined })],
    ["a text timing", JSON.stringify({ ...record, hello: "1590" })],
    ["an unknown request field", JSON.stringify({ ...record, bots: { ...record.bots, url: "/api/bots" } })],
    ["an array", "[]"],
  ])("rejects %s", async (_name, body) => {
    const dir = freshDir();
    expect((await receiveColdOpen(post(body), dir)).status).toBe(400);
    expect(existsSync(join(dir, COLD_OPEN_FILE))).toBe(false);
  });
});
