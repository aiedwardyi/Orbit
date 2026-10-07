// Synthetic sizing probe, off by default. Bounded: at most 2000 PCs.
//   WINK_SIZING=500 pnpm vitest run test/sizing.test.ts
// Both ends of every socket live in this one process, so the per-PC figure is
// an upper bound for the relay side, not a measurement of a deployed relay.

import { expect, it } from "vitest";
import { event, makePc, openControl, openData, startRelay } from "./fixtures.ts";

const N = Math.min(2000, Number(process.env.WINK_SIZING ?? 0));
const POOL = 3;

it.skipIf(!N)(`holds ${N} synthetic PCs with ${POOL} idle channels each`, { timeout: 600_000 }, async () => {
  const h = await startRelay({ limits: { connPerIpBurst: 1e9, connPerIpPerSec: 1e9, controlAuthPerIpPerMin: 1e9 } });
  const gc = globalThis.gc;
  gc?.();
  const before = process.memoryUsage();
  const started = performance.now();
  const sockets = [];
  for (let i = 0; i < N; i++) {
    const ctl = await openControl(h, makePc());
    sockets.push(ctl.socket);
    for (let j = 0; j < POOL; j++) sockets.push(await openData(h, ctl.ready.session, ctl.ready.poolToken));
  }
  await h.waitLog(event("join", { reason: "parked" }), N * POOL);
  const elapsed = performance.now() - started;
  gc?.();
  const after = process.memoryUsage();
  const mib = (b: number) => (b / 1024 / 1024).toFixed(1);
  const perPc = (after.rss - before.rss) / N;
  console.log(
    JSON.stringify({
      synthetic: true,
      pcs: N,
      tlsSocketsPerSide: N * (1 + POOL),
      rssDeltaMiB: mib(after.rss - before.rss),
      heapDeltaMiB: mib(after.heapUsed - before.heapUsed),
      upperBoundKiBPerPc: (perPc / 1024).toFixed(1),
      connectMsPerPc: (elapsed / N).toFixed(2),
    }),
  );
  expect(h.relay.hub.sessionCount).toBe(N);
  for (const s of sockets) s.destroy();
  await h.close();
});
