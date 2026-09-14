// Turn-latency baseline runner: drives ONE fixed tiny task headlessly through
// Orbit's real driver code (create → sendTurn → adapter events) and records a
// decomposed timeline per turn. Live engines spend their own quota; fake-CLI
// engines calibrate the Orbit-side overhead floor deterministically offline.
//
// Run docs (from the repo root; engines without credentials are skipped):
//   node --experimental-strip-types scripts/turn-latency-baseline.ts \
//     --engines=claude,codex --reps=3 --out=/tmp/qa-perf
// Env (only needed for live engines):
//   CLAUDE_CLI=claude.exe CLAUDE_CONFIG_DIR=/mnt/c/Users/mredw/.claude
//   CODEX_BIN=codex CODEX_HOME=/mnt/c/Users/mredw/.codex
//   (Windows .exe CLIs get a C:\-style cwd automatically.)
// Fake calibration (no credentials, offline):
//   node --experimental-strip-types scripts/turn-latency-baseline.ts \
//     --engines=fake-claude,fake-codex --reps=3 --out=/tmp/qa-perf
// Output: <out>/<engine>-<task>-rep<N>.jsonl (raw marks) plus
// <out>/summary.json (per-rep summaries + aggregates). Exit non-zero when any
// live turn fails or times out.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stats, summarizeTurn } from "./turn-latency-math.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const server = join(root, "server");
const { ClaudeDriver } = await import(join(server, "drivers", "claude.ts"));
const { CodexDriver } = await import(join(server, "drivers", "codex.ts"));

const TURN_TIMEOUT_MS = 240_000;
const FIXTURE_LINES = 24;

function usage() {
  console.error("usage: turn-latency-baseline.ts --engines=a,b --reps=N --out=DIR [--tasks=a,b]");
  process.exit(2);
}

const argv = new Map<string, string>();
for (const chunk of process.argv.slice(2)) {
  const match = chunk.match(/^--([^=]+)=(.*)$/);
  if (!match) usage();
  argv.set(match[1], match[2]);
}
const engines = (argv.get("engines") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const reps = Number(argv.get("reps") ?? "0");
const out = (argv.get("out") ?? "").replace(/^~(?=\/|$)/, process.env.HOME ?? "");
const tasks = (argv.get("tasks") ?? "a,b").split(",").map((name) => name.trim()).filter(Boolean);
if (engines.length === 0 || !Number.isInteger(reps) || reps < 1 || !out) usage();

// The fixed task. Task A needs no tools (pure generation floor); task B
// forces exactly one file read so tool round-trips show up in the timeline.
const FIXTURE_TEXT = Array.from({ length: FIXTURE_LINES }, (_, index) => `fixture line ${index + 1} of ${FIXTURE_LINES}`).join("\n");
const TASK_PROMPTS: Record<string, (fixturePath: string) => string> = {
  a: () => `Reply with exactly one sentence of at most fifteen words: what is this chat for? No tools.`,
  b: (fixturePath) => `Read the file at ${fixturePath} and reply with exactly: "<N> lines". Use one file read, nothing else.`,
};

function toWindowsPath(posix: string): string {
  const match = posix.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (match) return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
  return posix;
}

type EngineSpec = {
  driver: typeof ClaudeDriver;
  config: Record<string, unknown>;
  environment: Record<string, string>;
  model: string;
  live: boolean;
  cwd: string;
  fixturePath: string;
};

async function specFor(engine: string, workdir: string): Promise<EngineSpec | null> {
  const skipped = (reason: string) => {
    console.log(`engine ${engine}: SKIP (${reason})`);
    return null;
  };
  if (engine === "fake-claude") {
    return {
      driver: ClaudeDriver,
      config: { cli: join(server, "testing", "fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "stream" },
      model: "claude-haiku-4-5",
      live: false,
      cwd: workdir,
      fixturePath: join(workdir, "fixture.txt"),
    };
  }
  if (engine === "fake-codex") {
    return {
      driver: CodexDriver,
      config: { cli: join(server, "testing", "fake-codex-app-server.ts"), fullAuto: true },
      environment: {},
      model: "gpt-5.6-sol",
      live: false,
      cwd: workdir,
      fixturePath: join(workdir, "fixture.txt"),
    };
  }
  if (engine === "claude") {
    const cli = process.env.CLAUDE_CLI ?? "claude.exe";
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? "";
    if (!configDir) return skipped("CLAUDE_CONFIG_DIR not set");
    return {
      driver: ClaudeDriver,
      config: { cli },
      environment: { CLAUDE_CONFIG_DIR: configDir },
      model: "claude-haiku-4-5",
      live: true,
      cwd: workdir,
      fixturePath: join(workdir, "fixture.txt"),
    };
  }
  if (engine === "codex") {
    const cli = process.env.CODEX_BIN ?? "codex";
    const home = process.env.CODEX_HOME ?? "";
    if (!home) return skipped("CODEX_HOME not set");
    return {
      driver: CodexDriver,
      config: { cli, fullAuto: true },
      environment: { CODEX_HOME: home },
      model: "gpt-5.6-sol",
      live: true,
      cwd: workdir,
      fixturePath: join(workdir, "fixture.txt"),
    };
  }
  return skipped("no binary or credentials on this machine (grok/agy/gemini/meta)");
}

const isWindowsCli = (cli: string) => /\.exe$/i.test(cli) || /^[a-z]:\\/i.test(cli);

let failures = 0;
mkdirSync(out, { recursive: true });
const summaries: Array<Record<string, unknown>> = [];

for (const engine of engines) {
  const raw = mkdtempSync(join(tmpdir(), `omb-bench-${engine}-`));
  const spec = await specFor(engine, raw);
  if (!spec) continue;
  const cli = String((spec.config as { cli?: unknown }).cli ?? "");
  const cwd = isWindowsCli(cli) ? toWindowsPath(raw) : raw;
  const fixturePath = isWindowsCli(cli) ? toWindowsPath(join(raw, "fixture.txt")) : join(raw, "fixture.txt");
  writeFileSync(join(raw, "fixture.txt"), `${FIXTURE_TEXT}\n`);

  const createdAt = performance.now();
  const instance = await spec.driver.create({
    instanceId: `bench-${engine}`,
    displayName: `bench ${engine}`,
    environment: spec.environment,
    enabled: true,
    config: spec.driver.decodeConfig(spec.config),
  });
  const createMs = performance.now() - createdAt;

  for (const task of tasks) {
    const prompt = TASK_PROMPTS[task];
    if (!prompt) {
      console.log(`engine ${engine}: unknown task ${task}, skipped`);
      continue;
    }
    const repSummaries: Array<ReturnType<typeof summarizeTurn> & { chars: number; inputTokens: number }> = [];
    for (let rep = 1; rep <= reps; rep++) {
      const threadId = `bench-${engine}-${task}-${Date.now()}-${rep}`;
      const marks: Array<Record<string, unknown> & { t: number }> = [];
      const mark = (kind: string, extra: Record<string, unknown> = {}) => marks.push({ t: performance.now(), kind, ...extra });
      let tokenChars = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let completed: { ok: boolean } | null = null;
      let seenContent = false;
      const openTools = new Map<string, number>();
      const done = new Promise<void>((resolve) => {
        const stop = instance.adapter.onEvent((event) => {
          if (event.threadId !== threadId) return;
          if (event.type === "turn.started") mark("start");
          else if (event.type === "content.delta") {
            if (!seenContent) {
              seenContent = true;
              mark("firstToken");
            }
            tokenChars += event.delta.length;
          } else if (event.type === "item.started" && event.itemType === "tool") {
            openTools.set(event.itemId ?? `${openTools.size}`, performance.now());
            mark("toolStart");
          } else if (event.type === "item.completed" && event.itemType === "tool") {
            mark("toolEnd");
          } else if (event.type === "thread.token-usage.updated") {
            inputTokens = event.input;
            outputTokens = event.output;
          } else if (event.type === "turn.completed") {
            completed = { ok: event.ok };
            mark("end", { output: outputTokens, ok: event.ok, stopReason: event.stopReason ?? null });
            stop();
            resolve();
          } else if (event.type === "runtime.error") {
            mark("error", { message: String(event.message ?? "").slice(0, 300) });
          } else if (event.type === "turn.retrying") {
            mark("retry", { reason: String(event.reason ?? "").slice(0, 120) });
          }
        });
      });
      const tSend = performance.now();
      await instance.adapter.sendTurn({ threadId, text: prompt(fixturePath), model: spec.model, cwd });
      const started = marks.find((mark) => mark.kind === "start");
      const summary = await Promise.race([
        done.then(() => summarizeTurn([{ t: tSend, kind: "send" }, ...marks])),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), TURN_TIMEOUT_MS)),
      ]);
      if (summary === null || completed === null || !completed.ok) {
        failures++;
        console.log(`engine ${engine} task ${task} rep ${rep}: FAIL (timeout or unsuccessful turn)`);
        for (const err of marks.filter((mark) => mark.kind === "error" || mark.kind === "retry" || mark.kind === "end")) {
          console.log(`  mark: ${JSON.stringify(err).slice(0, 400)}`);
        }
        try {
          await instance.adapter.interruptTurn(threadId);
        } catch {}
        continue;
      }
      summary.localMs = { ...(summary.localMs as Record<string, number>), create: createMs, spawn: started ? (started.t as number) - tSend : 0 };
      summary.providerMs =
        summary.totalMs !== null
          ? summary.totalMs - Object.values(summary.localMs as Record<string, number>).reduce((sum, ms) => sum + ms, 0)
          : null;
      repSummaries.push({ ...summary, chars: tokenChars, inputTokens });
      const file = join(out, `${engine}-${task}-rep${rep}.jsonl`);
      writeFileSync(file, `${marks.map((mark) => JSON.stringify(mark)).join("\n")}\n`);
      console.log(
        `engine ${engine} task ${task} rep ${rep}: total=${summary.totalMs?.toFixed(0)}ms ttft=${summary.ttftMs?.toFixed(0)}ms ` +
          `tok/s=${summary.tokPerSec?.toFixed(1) ?? "n/a"} tools=${summary.toolCount} in/out=${inputTokens}/${outputTokens} chars=${tokenChars}`,
      );
    }
    const totals = repSummaries.map((summary) => summary.totalMs ?? 0);
    const ttfts = repSummaries.map((summary) => summary.ttftMs ?? 0);
    summaries.push({ engine, task, model: spec.model, live: spec.live, reps: repSummaries.length, totalMs: stats(totals), ttftMs: stats(ttfts), turns: repSummaries });
  }
  await instance.dispose?.();
}

writeFileSync(join(out, "summary.json"), `${JSON.stringify({ createdAt: new Date().toISOString(), summaries }, null, 2)}\n`);
console.log(`\nwrote ${summaries.length} engine-task summaries to ${join(out, "summary.json")}`);
if (failures > 0) {
  console.error(`${failures} turn(s) failed`);
  process.exit(1);
}
