import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import type { Message } from "../server/store.ts";

const fixture = resolve(process.argv[2] ?? "");
if (!fixture.startsWith(resolve(tmpdir()) + "\\") && !fixture.startsWith(resolve(tmpdir()) + "/")) {
  throw new Error("Copy the fixture into a temp directory before running this benchmark");
}
const root = mkdtempSync(join(tmpdir(), "sync-v2-bench-"));
process.env.OMB_DATA_DIR = join(root, "script");
mkdirSync(process.env.OMB_DATA_DIR);
const { ThreadSyncV2 } = await import("../server/thread-sync-v2.ts");
const source: { messages: Message[] } = JSON.parse(readFileSync(fixture, "utf8"));
const scope = { botSyncId: "bench", threadId: "thread" };
const percentile = (values: number[], p = 0.95) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

async function timed<T>(work: () => Promise<T>) {
  let last = performance.now();
  let stall = 0;
  const tick = () => {
    const now = performance.now();
    stall = Math.max(stall, now - last - 2);
    last = now;
  };
  const timer = setInterval(tick, 2);
  const start = performance.now();
  try {
    const value = await work();
    const elapsed = performance.now() - start;
    await delay(3);
    tick();
    return { value, elapsed, stall: Math.max(0, stall) };
  } finally {
    clearInterval(timer);
  }
}

const reports = [];
for (const count of [source.messages.length, 330_000]) {
  const folder = join(root, String(count), "sync");
  const a = new ThreadSyncV2({ folder, dataDir: join(root, String(count), "a"), deviceId: "a" });
  const b = new ThreadSyncV2({ folder, dataDir: join(root, String(count), "b"), deviceId: "b" });
  try {
    const start = performance.now();
    for (let offset = 0; offset < count; offset += 128) {
      const page = Array.from({ length: Math.min(128, count - offset) }, (_, index): Message => {
        if (count === source.messages.length) return source.messages[offset + index];
        const n = offset + index;
        return { id: `m${n}`, role: n % 2 ? "bot" : "user", kind: "text", at: n + 1, parentId: n ? `m${n - 1}` : null, text: "Synthetic transcript row. ".repeat(18) };
      });
      await a.commit(scope, page.map((value) => ({ kind: "row", value })));
      if (offset % 32768 === 0) console.log(JSON.stringify({ rows: count, seeded: offset }));
    }
    const seedMs = performance.now() - start;
    const initialFlush = await timed(() => a.flush(scope));
    const initialApply = await timed(() => b.pull(scope));
    const row = (await a.scan(scope.threadId, 0, 1)).messages[0];
    const writes: number[] = [];
    const flushStalls: number[] = [];
    const applyStalls: number[] = [];
    const flushTimes: number[] = [];
    const applyTimes: number[] = [];
    const headSizes: number[] = [];
    const localSql: number[] = [];
    const remoteSql: number[] = [];
    const messageRows: number[] = [];
    let segments = initialFlush.value.segments;
    for (let i = 0; i < 128; i++) {
      const local = await a.commit(scope, [{ kind: "row", value: { ...row, reactions: [{ emoji: `reaction-${i}`, by: "user" }] } }]);
      const flushed = await timed(() => a.flush(scope));
      const applied = await timed(() => b.pull(scope));
      writes.push(flushed.value.bytesWritten);
      headSizes.push(flushed.value.headBytes);
      flushStalls.push(flushed.stall);
      applyStalls.push(applied.stall);
      flushTimes.push(flushed.elapsed);
      applyTimes.push(applied.elapsed);
      localSql.push(local.sqlRowsTouched);
      remoteSql.push(applied.value.sqlRowsTouched);
      messageRows.push(applied.value.rowsTouched);
      segments = flushed.value.segments;
      if (applied.value.rowsTouched !== 1) throw new Error("One changed row must touch one message row");
    }
    await a.commit(scope, [{ kind: "row", value: { ...row, text: "oversized ".repeat(65_536) } }]);
    const sealFlush = await timed(() => a.flush(scope));
    const sealApply = await timed(() => b.pull(scope));
    const report = {
      rows: count, samples: writes.length, seedMs, initialFlush, initialApply,
      bytesPerChangeMean: writes.reduce((sum, value) => sum + value, 0) / writes.length,
      bytesPerChangeP95: percentile(writes), headBytesMax: Math.max(...headSizes), segments,
      p95StallMs: { flush: percentile(flushStalls), apply: percentile(applyStalls) },
      p95WallMs: { flush: percentile(flushTimes), apply: percentile(applyTimes) },
      sqlRowsPerChange: { local: [...new Set(localSql)], remote: [...new Set(remoteSql)], messages: [...new Set(messageRows)] },
      sealFlush, sealApply,
    };
    reports.push(report);
    writeFileSync(join(root, "results.json"), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await a.close();
    await b.close();
  }
}
console.log(`Results: ${join(root, "results.json")}`);
