// Turn-latency baseline runner: drives ONE fixed tiny task headlessly through
// Orbit's real driver code (create → sendTurn → adapter events) and records a
// decomposed timeline per turn. Live engines spend their own quota; fake-CLI
// engines calibrate the Orbit-side overhead floor deterministically offline.
//
// Run docs (from the repo root; engines without credentials are skipped):
//   node --experimental-strip-types scripts/turn-latency-baseline.ts \
//     --engines=claude,codex --reps=3 --out=/tmp/qa-perf
// Env (only needed for live engines):
//   CLAUDE_CLI=claude.exe CLAUDE_CONFIG_DIR=<dir-with-.credentials.json>
//   CODEX_BIN=codex CODEX_HOME=<native-home-with-auth.json>
//   BENCH_WIN_TMPDIR=</mnt/c/...-mount-path> (Windows-drive fixture root for
//     .exe CLIs; the fixture path is mapped to C:\ form automatically)
// Fake calibration (no credentials, offline):
//   node --experimental-strip-types scripts/turn-latency-baseline.ts \
//     --engines=fake-claude,fake-codex --reps=3 --out=/tmp/qa-perf
// Output: <out>/<engine>-<task>-rep<N>.jsonl (raw marks) plus
// <out>/summary.json (per-rep summaries + aggregates). Exit non-zero when any
// live turn fails or times out.
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
      // The per-task fake mode is set by the task loop (quiet for A).
      environment: {},
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
    // Bench-only narrowing (instance config, not product code):
    // bypassPermissions skips the permission broker, whose --mcp-config temp
    // file lives on a Linux-only /tmp path a Windows .exe CLI cannot open
    // (hard exit before result on any tool turn). Neither bench task needs an
    // approval decision, so the policy is orthogonal to the timings.
    return {
      driver: ClaudeDriver,
      config: { cli, permissionMode: "bypassPermissions" },
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

// Windows CLIs cannot open POSIX temp paths, so their fixture lives on a
// mounted Windows drive whenever one is writable; otherwise tmpdir() stays.
// The spawn cwd keeps the POSIX form regardless: Node stats it Linux-side,
// so a C:\-style cwd fails the spawn before the child ever runs.
function workdirFor(cliHint: string, engine: string): string {
  // BENCH_WIN_TMPDIR overrides the Windows-drive temp root (must be passed
  // as its /mnt/c/... mount path). mkdtempSync is the writability probe.
  if (isWindowsCli(cliHint)) {
    for (const base of [process.env.BENCH_WIN_TMPDIR, "/mnt/c/Windows/Temp"].filter((dir) => dir && existsSync(dir))) {
      try {
        return mkdtempSync(join(base as string, `omb-bench-${engine}-`));
      } catch {}
    }
  }
  return mkdtempSync(join(tmpdir(), `omb-bench-${engine}-`));
}

function cliHintFor(engine: string): string {
  if (engine === "claude") return process.env.CLAUDE_CLI ?? "claude.exe";
  if (engine === "codex") return process.env.CODEX_BIN ?? "codex";
  return engine;
}

let failures = 0;
mkdirSync(out, { recursive: true });
const summaries: Array<Record<string, unknown>> = [];

for (const engine of engines) {
  const raw = workdirFor(cliHintFor(engine), engine);
  const spec = await specFor(engine, raw);
  if (!spec) continue;
  const cli = String((spec.config as { cli?: unknown }).cli ?? "");
  const cwd = raw;
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
    // Fake calibration honors the workload: task A runs the text-only quiet
    // fixture (no-tool generation floor), task B the default scripted turn.
    const savedClaudeMode = process.env.FAKE_CLAUDE_MODE;
    const savedCodexMode = process.env.FAKE_CODEX_MODE;
    if (engine === "fake-claude") process.env.FAKE_CLAUDE_MODE = task === "a" ? "bench-quiet" : "stream";
    if (engine === "fake-codex") process.env.FAKE_CODEX_MODE = task === "a" ? "bench-quiet" : "happy";
    const repSummaries: Array<ReturnType<typeof summarizeTurn> & { chars: number; inputTokens: number; createMs: number }> = [];
    for (let rep = 1; rep <= reps; rep++) {
      const threadId = `bench-${engine}-${task}-${Date.now()}-${rep}`;
      const marks: Array<Record<string, unknown> & { t: number }> = [];
      const mark = (kind: string, extra: Record<string, unknown> = {}) => marks.push({ t: performance.now(), kind, ...extra });
      let tokenChars = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let completed: { ok: boolean } | null = null;
      let seenContent = false;
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
            mark("toolStart", { itemId: event.itemId ?? null });
          } else if (event.type === "item.completed" && event.itemType === "tool") {
            mark("toolEnd", { itemId: event.itemId ?? null });
          } else if (event.type === "thread.token-usage.updated") {
            inputTokens = event.input;
            outputTokens = event.output;
          } else if (event.type === "turn.completed") {
            completed = { ok: event.ok };
            // The completion carries this turn's aggregate as the provider
            // reports it; the live token-usage indicator differs per driver
            // (per-step, per-message, thread total) and is only the fallback.
            if (event.usage && Number.isFinite(event.usage.output)) outputTokens = event.usage.output;
            if (event.usage && Number.isFinite(event.usage.input)) inputTokens = event.usage.input;
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const summary = await Promise.race([
        done.then(() => summarizeTurn([{ t: tSend, kind: "send" }, ...marks])),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), TURN_TIMEOUT_MS);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      // Read after the race: sendTurn returns before the driver emits
      // turn.started, so anything earlier finds an empty timeline. The send
      // mark is persisted too: totals span the send call, and the math
      // module derives the same numbers offline from this file alone.
      const started = marks.find((mark) => mark.kind === "start");
      const file = join(out, `${engine}-${task}-rep${rep}.jsonl`);
      const persisted = [{ t: tSend, kind: "send" }, ...marks];
      writeFileSync(file, `${persisted.map((mark) => JSON.stringify(mark)).join("\n")}\n`);
      if (summary === null || completed === null || !completed.ok) {
        failures++;
        console.log(`engine ${engine} task ${task} rep ${rep}: FAIL (timeout or unsuccessful turn), marks kept in ${file}`);
        for (const err of marks.filter((mark) => mark.kind === "error" || mark.kind === "retry" || mark.kind === "end")) {
          console.log(`  mark: ${JSON.stringify(err).slice(0, 400)}`);
        }
        try {
          await instance.adapter.interruptTurn(threadId);
        } catch {}
        continue;
      }
      // createMs stays out of the per-turn subtraction: instance setup runs
      // once per engine, before tSend, outside the total interval. Only the
      // spawn slice (send call to turn.started) is per-turn local overhead.
      summary.localMs = { ...(summary.localMs as Record<string, number>), spawn: started ? (started.t as number) - tSend : 0 };
      summary.providerMs =
        summary.totalMs !== null
          ? summary.totalMs - Object.values(summary.localMs as Record<string, number>).reduce((sum, ms) => sum + ms, 0)
          : null;
      repSummaries.push({ ...summary, chars: tokenChars, inputTokens, createMs });
      console.log(
        `engine ${engine} task ${task} rep ${rep}: total=${summary.totalMs?.toFixed(0)}ms ttft=${summary.ttftMs?.toFixed(0)}ms ` +
          `tok/s=${summary.tokPerSec?.toFixed(1) ?? "n/a"} tools=${summary.toolCount} in/out=${inputTokens}/${outputTokens} chars=${tokenChars}`,
      );
    }
    // Missing TTFT stays missing: a content-free success must not read as an
    // instantaneous first token in the aggregates.
    const totals = repSummaries.map((summary) => summary.totalMs).filter((value): value is number => value !== null);
    const ttfts = repSummaries.map((summary) => summary.ttftMs).filter((value): value is number => value !== null);
    summaries.push({ engine, task, model: spec.model, live: spec.live, reps: repSummaries.length, createMs, totalMs: stats(totals), ttftMs: stats(ttfts), turns: repSummaries });
    if (savedClaudeMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
    else process.env.FAKE_CLAUDE_MODE = savedClaudeMode;
    if (savedCodexMode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = savedCodexMode;
  }
  await instance.dispose?.();
}

writeFileSync(join(out, "summary.json"), `${JSON.stringify({ createdAt: new Date().toISOString(), summaries }, null, 2)}\n`);
console.log(`\nwrote ${summaries.length} engine-task summaries to ${join(out, "summary.json")}`);
if (failures > 0) {
  console.error(`${failures} turn(s) failed`);
  process.exit(1);
}
