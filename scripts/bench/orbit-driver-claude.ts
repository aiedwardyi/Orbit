#!/usr/bin/env node
/**
 * Real Claude via Orbit ClaudeDriver — 5 cold + 5 warm.
 * Env: ORBIT_TURN_TIMING=1, OMB_DATA_DIR, BENCH_OUT, BENCH_CLAUDE_CLI, BENCH_CLAUDE_PROMPT
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDirs } from "../../server/config.ts";
import { ClaudeDriver } from "../../server/drivers/claude.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { recordEvents } from "../../server/testing/events.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLD_N = Number(process.env.BENCH_CLAUDE_COLD_N ?? "5") || 5;
const WARM_N = Number(process.env.BENCH_CLAUDE_WARM_N ?? "5") || 5;
const PROMPT = process.env.BENCH_CLAUDE_PROMPT ?? "Reply with exactly: ok";
const OUT = process.env.BENCH_OUT ?? join(__dirname, "results", `orbit-claude-${Date.now()}.json`);
const CLI = process.env.BENCH_CLAUDE_CLI ?? "claude";

function median(xs: Array<number | null | undefined>): number | null {
  const a = xs.filter((x): x is number => typeof x === "number").sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : Math.round((a[m - 1]! + a[m]!) / 2);
}

type Row = {
  i: number;
  cold: boolean;
  ttftMs: number | null;
  totalMs: number;
  code: number;
  turnId?: string;
  error?: string;
  timingMarks?: Record<string, unknown>;
};

async function createInstance() {
  return ClaudeDriver.create({
    instanceId: "bench-orbit-claude",
    displayName: "Bench Orbit Claude",
    environment: {},
    enabled: true,
    config: { cli: CLI, permissionMode: "bypassPermissions" },
  });
}

async function main() {
  ensureDirs();
  const dataDir = process.env.OMB_DATA_DIR;
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const timingPath = dataDir ? join(dataDir, "turn-timing.jsonl") : null;
  if (timingPath) writeFileSync(timingPath, "");

  const scratch = mkdtempSync(join(tmpdir(), "omb-bench-claude-"));
  const rows: Row[] = [];
  let instance = await createInstance();
  let recorder = recordEvents(instance.adapter);
  let resumeCursor: string | undefined;

  try {
    const total = COLD_N + WARM_N;
    for (let i = 0; i < total; i++) {
      const cold = i < COLD_N;
      if (i > 0 && cold) {
        recorder.stop();
        await instance.dispose();
        instance = await createInstance();
        recorder = recordEvents(instance.adapter);
        resumeCursor = undefined;
      }

      const t0 = performance.now();
      let firstVisible: number | null = null;
      const unsub = instance.adapter.onEvent((e) => {
        if (firstVisible == null && e.type === "content.delta") firstVisible = performance.now();
      });

      let turnId: string | undefined;
      let err: string | undefined;
      let code = 0;
      try {
        const sent = await instance.adapter.sendTurn({
          threadId: cold ? `claude-cold-${i}` : "claude-warm",
          text: PROMPT,
          cwd: scratch,
          ...(process.env.BENCH_CLAUDE_MODEL ? { model: process.env.BENCH_CLAUDE_MODEL } : {}),
          ...(resumeCursor ? { resumeCursor } : {}),
        });
        turnId = sent.turnId;
        await recorder.until(
          (e) => e.type === "turn.completed" && (e as { turnId?: string }).turnId === turnId,
          180_000,
        );
        const started = recorder.events.find(
          (e) => e.type === "session.started" && (e as { turnId?: string }).turnId === turnId,
        ) as { sessionId?: string } | undefined;
        if (started?.sessionId) resumeCursor = started.sessionId;
      } catch (e) {
        code = 1;
        err = e instanceof Error ? e.message : String(e);
      } finally {
        unsub();
      }

      const totalMs = Math.round(performance.now() - t0);
      let ttftMs = firstVisible == null ? null : Math.round(firstVisible - t0);
      let timingMarks: Record<string, unknown> | undefined;
      if (timingPath && existsSync(timingPath)) {
        const lines = readFileSync(timingPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
        if (lines.length) {
          try {
            timingMarks = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
            if (typeof timingMarks.firstVisibleMs === "number") ttftMs = timingMarks.firstVisibleMs as number;
          } catch {
            /* ignore */
          }
        }
      }

      rows.push({ i, cold, ttftMs, totalMs, code, turnId, error: err, timingMarks });
      console.log(
        `claude ${cold ? "cold" : "warm"} #${i + 1}: ttft=${ttftMs} total=${totalMs} code=${code}` +
          (err ? ` err=${err}` : ""),
      );
    }
  } finally {
    recorder.stop();
    await instance.dispose();
    await removeTempDir(scratch);
  }

  const cold = rows.filter((r) => r.cold);
  const warm = rows.filter((r) => !r.cold);
  const markMed = (subset: Row[], key: string) =>
    median(subset.map((r) => (typeof r.timingMarks?.[key] === "number" ? (r.timingMarks![key] as number) : null)));

  const summary = {
    engine: "claude",
    measuredAt: new Date().toISOString(),
    prompt: PROMPT,
    coldN: COLD_N,
    warmN: WARM_N,
    cold: {
      ttftMedianMs: median(cold.map((r) => r.ttftMs)),
      totalMedianMs: median(cold.map((r) => r.totalMs)),
      dispatchMedianMs: markMed(cold, "dispatchMs"),
      spawnOrReuseMedianMs: markMed(cold, "spawnOrReuseMs"),
      cliReadyMedianMs: markMed(cold, "cliReadyMs"),
      firstVisibleMedianMs: markMed(cold, "firstVisibleMs"),
      turnDoneMedianMs: markMed(cold, "turnDoneMs"),
      failures: cold.filter((r) => r.code !== 0).length,
    },
    warm: {
      ttftMedianMs: median(warm.map((r) => r.ttftMs)),
      totalMedianMs: median(warm.map((r) => r.totalMs)),
      dispatchMedianMs: markMed(warm, "dispatchMs"),
      spawnOrReuseMedianMs: markMed(warm, "spawnOrReuseMs"),
      cliReadyMedianMs: markMed(warm, "cliReadyMs"),
      firstVisibleMedianMs: markMed(warm, "firstVisibleMs"),
      turnDoneMedianMs: markMed(warm, "turnDoneMs"),
      failures: warm.filter((r) => r.code !== 0).length,
    },
    rows,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`WROTE ${OUT}`);
  console.log(JSON.stringify({ cold: summary.cold, warm: summary.warm }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
