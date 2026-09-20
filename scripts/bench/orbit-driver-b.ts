#!/usr/bin/env node
/**
 * Orbit driver path (condition B) for turn-latency bench.
 * Mirrors server/drivers/acp/acp.test.ts: createAcpDriver + fake-acp-cli + sendTurn.
 *
 * Env (set by turn-latency.mjs before spawn):
 *   ORBIT_TURN_TIMING=1
 *   OMB_DATA_DIR=<scripts/bench/results/.../data>  — turn-timing.jsonl lands here
 *   BENCH_OUT=<path.json>  — results written here (also printed as JSON on stdout last line marker)
 *   BENCH_RUNS / BENCH_PROMPTS optional
 *
 * Must set OMB_DATA_DIR before this process starts (module-level DATA_DIR).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDirs } from "../../server/config.ts";
import { recordEvents } from "../../server/testing/events.ts";
import { createAcpDriver } from "../../server/drivers/acp/core.ts";
import { grokSupport } from "../../server/drivers/acp/grok.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const FAKE_CLI = join(ROOT, "server", "testing", "fake-acp-cli.ts");

const PROMPTS = (process.env.BENCH_PROMPTS ?? "say hi|what is 2+2|list three colors").split("|").filter(Boolean);
const RUNS = Number(process.env.BENCH_RUNS ?? "5") || 5;
const COLD_N = Number(process.env.BENCH_B_COLD_N ?? "5") || 0;
const OUT = process.env.BENCH_OUT ?? join(__dirname, "results", `orbit-b-${Date.now()}.json`);

function median(xs: Array<number | null | undefined>): number | null {
  const a = xs.filter((x): x is number => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

function p90(xs: Array<number | null | undefined>): number | null {
  const a = xs.filter((x): x is number => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)];
}

const BenchDriver = createAcpDriver({
  ...grokSupport,
  // Deterministic identity — do not depend on ~/.grok/auth.json for bench.
  warmSessionIdentity: () => "bench-b-identity",
  warmIdleMs: 60_000,
  isAuthenticated: () => true,
  // Skip billing probe noise for latency bench.
  rateLimits: false,
  billingMethod: undefined,
});

type Row = {
  prompt: string;
  i: number;
  engine: string;
  condition: string;
  cold: boolean;
  ttftMs: number | null;
  totalMs: number;
  code: number;
  turnId?: string;
  error?: string;
  timingMarks?: Record<string, unknown>;
};

async function main() {
  if (!existsSync(FAKE_CLI)) {
    throw new Error(`fake-acp-cli missing: ${FAKE_CLI}`);
  }
  chmodSync(FAKE_CLI, 0o755);
  ensureDirs();

  const dataDir = process.env.OMB_DATA_DIR;
  if (!dataDir) {
    console.error("WARN: OMB_DATA_DIR unset — turn-timing may write to ~/.orbit");
  } else {
    mkdirSync(dataDir, { recursive: true });
  }
  const timingPath = dataDir ? join(dataDir, "turn-timing.jsonl") : null;
  if (timingPath && existsSync(timingPath)) {
    writeFileSync(timingPath, "");
  }

  const scratch = mkdtempSync(join(tmpdir(), "omb-bench-b-"));
  process.env.FAKE_ACP_MODE = "happy";

  const rows: Row[] = [];
  let instance = await BenchDriver.create({
    instanceId: "bench-orbit-b",
    displayName: "Bench Orbit B",
    environment: {},
    enabled: true,
    config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch },
  });
  let recorder = recordEvents(instance.adapter);
  let sessionId: string | undefined;
  let turnIndex = 0;

  try {
    for (const prompt of PROMPTS) {
      for (let i = 0; i < RUNS; i++) {
        // Dedicated cold samples: dispose+recreate for the first COLD_N turns
        // (and whenever BENCH_B_ALWAYS_COLD=1). Remaining turns stay warm.
        const forceCold =
          process.env.BENCH_B_ALWAYS_COLD === "1" || turnIndex < COLD_N;
        const cold = forceCold;
        if (turnIndex > 0 && forceCold) {
          recorder.stop();
          await instance.dispose();
          instance = await BenchDriver.create({
            instanceId: "bench-orbit-b",
            displayName: "Bench Orbit B",
            environment: {},
            enabled: true,
            config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch },
          });
          recorder = recordEvents(instance.adapter);
          sessionId = undefined;
        }

        const t0 = performance.now();
        let firstVisible: number | null = null;
        const beforeLen = recorder.events.length;
        const unsub = instance.adapter.onEvent((e) => {
          if (firstVisible == null && e.type === "content.delta") {
            firstVisible = performance.now();
          }
        });

        let turnId: string | undefined;
        let err: string | undefined;
        let code = 0;
        try {
          const sent = await instance.adapter.sendTurn({
            threadId: "bench-b",
            text: prompt,
            resumeCursor: sessionId,
          });
          turnId = sent.turnId;
          await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId, 30_000);
          const started = recorder.events.find(
            (e) => e.type === "session.started" && (e as { turnId?: string }).turnId === turnId,
          ) as { sessionId?: string } | undefined;
          if (started?.sessionId) sessionId = started.sessionId;
        } catch (e) {
          code = 1;
          err = e instanceof Error ? e.message : String(e);
        } finally {
          unsub();
        }

        const totalMs = Math.round(performance.now() - t0);
        const ttftMs = firstVisible == null ? null : Math.round(firstVisible - t0);

        // Pair latest turn-timing.jsonl line if present.
        let timingMarks: Record<string, unknown> | undefined;
        if (timingPath && existsSync(timingPath)) {
          const lines = readFileSync(timingPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
          if (lines.length) {
            try {
              timingMarks = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
            } catch {
              /* ignore */
            }
          }
        }

        const row: Row = {
          prompt,
          i,
          engine: "orbit-acp-fake",
          condition: cold ? "B_orbit_driver_cold" : "B_orbit_driver_warm",
          cold: cold || (timingMarks?.reusedSession === false),
          ttftMs,
          totalMs,
          code,
          turnId,
          error: err,
          timingMarks,
        };
        // Prefer instrumentation firstVisible when available.
        if (timingMarks && typeof timingMarks.firstVisibleMs === "number") {
          row.ttftMs = timingMarks.firstVisibleMs as number;
        }
        if (timingMarks && typeof timingMarks.turnDoneMs === "number") {
          // Keep wall totalMs; also surface turnDone in marks.
        }
        rows.push(row);
        console.log(
          `orbit-acp-fake B ${cold ? "cold" : "warm"} ${prompt} #${i + 1}: ttft=${row.ttftMs} total=${row.totalMs} code=${row.code}` +
            (timingMarks
              ? ` marks[dispatch=${timingMarks.dispatchMs} probed=${timingMarks.cliProbedMs} spawn=${timingMarks.spawnOrReuseMs} ready=${timingMarks.cliReadyMs} first=${timingMarks.firstVisibleMs} done=${timingMarks.turnDoneMs} reuse=${timingMarks.reusedSession}]`
              : ""),
        );
        turnIndex++;
        void beforeLen;
      }
    }
  } finally {
    recorder.stop();
    await instance.dispose();
    await removeTempDir(scratch);
    delete process.env.FAKE_ACP_MODE;
  }

  const by = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.engine}|${r.condition}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(r);
  }
  const summary = [...by.entries()].map(([k, rs]) => {
    const [engine, condition] = k.split("|");
    return {
      engine,
      condition,
      n: rs.length,
      ttftMedian: median(rs.map((r) => r.ttftMs)),
      ttftP90: p90(rs.map((r) => r.ttftMs)),
      totalMedian: median(rs.map((r) => r.totalMs)),
      totalP90: p90(rs.map((r) => r.totalMs)),
      firstVisibleMedian: median(rs.map((r) => (r.timingMarks?.firstVisibleMs as number | undefined) ?? null)),
      cliProbedMedian: median(rs.map((r) => (r.timingMarks?.cliProbedMs as number | undefined) ?? null)),
      spawnOrReuseMedian: median(rs.map((r) => (r.timingMarks?.spawnOrReuseMs as number | undefined) ?? null)),
      cliReadyMedian: median(rs.map((r) => (r.timingMarks?.cliReadyMs as number | undefined) ?? null)),
      turnDoneMedian: median(rs.map((r) => (r.timingMarks?.turnDoneMs as number | undefined) ?? null)),
    };
  });

  const out = {
    stamp: new Date().toISOString(),
    condition: "B_orbit_driver",
    note: "Orbit ACP driver path via createAcpDriver + fake-acp-cli (happy). Not live CLI. ORBIT_TURN_TIMING marks included when present.",
    ombDataDir: dataDir ?? null,
    timingPath,
    orbitTiming: process.env.ORBIT_TURN_TIMING ?? null,
    summary,
    rows,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log("BENCH_B_OUT=" + OUT);
  console.log(JSON.stringify({ summary }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
