#!/usr/bin/env node
/**
 * Orbit turn-latency bench.
 * Usage:
 *   node scripts/bench/turn-latency.mjs              # both A + B
 *   node scripts/bench/turn-latency.mjs --mode=A     # bare CLI only
 *   node scripts/bench/turn-latency.mjs --mode=B     # Orbit driver (fake ACP) only
 * Env: ORBIT_TURN_TIMING=1 (set here for Orbit path B)
 *      BENCH_MODE=A|B|both  (alt to --mode)
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const PROMPTS = ["say hi", "what is 2+2", "list three colors"];
const RUNS = 5;
const RESULTS = join(__dirname, "results");
mkdirSync(RESULTS, { recursive: true });

const modeArg = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1];
const MODE = (modeArg || process.env.BENCH_MODE || "both").toLowerCase();
const runA = MODE === "a" || MODE === "both" || MODE === "all";
const runB = MODE === "b" || MODE === "both" || MODE === "all";

function which(cmd) {
  return new Promise((resolve) => {
    const c = spawn(process.platform === "win32" ? "where" : "which", [cmd], { shell: true });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] : null));
  });
}

function run(cmd, args, opts = {}) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const useShell = opts.shell ?? process.platform === "win32";
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: useShell,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let firstByte = null;
    child.stdout.on("data", (d) => {
      if (firstByte == null) firstByte = performance.now();
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
        ttftMs: firstByte == null ? null : Math.round(firstByte - t0),
        totalMs: Math.round(performance.now() - t0),
      });
    });
  });
}

function median(xs) {
  const a = xs.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

function p90(xs) {
  const a = xs.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)];
}

async function benchBare(name, build) {
  const rows = [];
  for (const prompt of PROMPTS) {
    for (let i = 0; i < RUNS; i++) {
      const { cmd, args } = build(prompt);
      const r = await run(cmd, args);
      rows.push({ prompt, i, ...r, engine: name, condition: "A_bare_cli" });
      console.log(`${name} A ${prompt} #${i + 1}: ttft=${r.ttftMs} total=${r.totalMs} code=${r.code}`);
    }
  }
  return rows;
}

/** Orbit driver path B: spawn TS runner with isolated OMB_DATA_DIR. */
async function benchOrbitB() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dataDir = join(RESULTS, `omb-data-b-${stamp}`);
  const outPath = join(RESULTS, `orbit-b-${stamp}.json`);
  mkdirSync(dataDir, { recursive: true });

  const r = await run(
    process.execPath,
    ["--experimental-strip-types", join(__dirname, "orbit-driver-b.ts")],
    {
      cwd: ROOT,
      shell: false,
      env: {
        ORBIT_TURN_TIMING: "1",
        OMB_DATA_DIR: dataDir,
        BENCH_OUT: outPath,
        BENCH_RUNS: String(RUNS),
        BENCH_PROMPTS: PROMPTS.join("|"),
        BENCH_B_COLD_N: "5",
      },
    },
  );
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.code !== 0) {
    console.error(`orbit-driver-b exited ${r.code}`);
    return { rows: [], summary: [], outPath: null, dataDir, error: r.stderr || `exit ${r.code}` };
  }
  if (!existsSync(outPath)) {
    // Fallback: parse BENCH_B_OUT= from stdout
    const m = r.stdout.match(/BENCH_B_OUT=(.+)/);
    if (m && existsSync(m[1].trim())) {
      const parsed = JSON.parse(readFileSync(m[1].trim(), "utf8"));
      return { rows: parsed.rows ?? [], summary: parsed.summary ?? [], outPath: m[1].trim(), dataDir, raw: parsed };
    }
    return { rows: [], summary: [], outPath: null, dataDir, error: "missing BENCH_OUT" };
  }
  const parsed = JSON.parse(readFileSync(outPath, "utf8"));
  return { rows: parsed.rows ?? [], summary: parsed.summary ?? [], outPath, dataDir, raw: parsed };
}

const grok = runA ? await which("grok") : null;
const claude = runA ? await which("claude") : null;
const gemini = runA ? await which("gemini") : null;
const muse = runA ? await which("muse") : null;
const codex = runA ? await which("codex") : null;

if (runA) console.log({ grok, claude, gemini, muse, codex });

let all = [];
let modeBMeta = { pending: !runB };

if (runA) {
  if (claude) {
    all = all.concat(
      await benchBare("claude", (p) => ({
        cmd: "claude",
        args: ["-p", p, "--output-format", "text"],
      })),
    );
  }
  if (grok) {
    // Grok Build TUI: -p is not print mode; prompt is positional. Prefer
    // positional; still may fail if TUI-only. Do not burn retries here.
    all = all.concat(
      await benchBare("grok", (p) => ({
        cmd: "grok",
        args: [p],
      })),
    );
  }
  if (gemini) {
    all = all.concat(
      await benchBare("gemini", (p) => ({
        cmd: "gemini",
        args: ["-p", p],
      })),
    );
  }
  if (muse) {
    all = all.concat(
      await benchBare("muse", (p) => ({
        cmd: "muse",
        args: ["-p", p],
      })),
    );
  }
  if (codex) {
    all = all.concat(
      await benchBare("codex", (p) => ({
        cmd: "codex",
        args: ["exec", p],
      })),
    );
  }
}

if (runB) {
  console.log("=== Mode B: Orbit ACP driver (fake-acp-cli) ===");
  const b = await benchOrbitB();
  modeBMeta = {
    pending: false,
    outPath: b.outPath,
    dataDir: b.dataDir,
    error: b.error ?? null,
    note: b.raw?.note ?? null,
  };
  // Strip nested timingMarks from merged rows for compact combined file;
  // full detail stays in orbit-b-*.json.
  all = all.concat(
    (b.rows ?? []).map(({ timingMarks, error, turnId, cold, ...r }) => ({
      ...r,
      cold,
      turnId,
      error,
      hasTimingMarks: !!timingMarks,
      firstVisibleMs: timingMarks?.firstVisibleMs ?? null,
      spawnOrReuseMs: timingMarks?.spawnOrReuseMs ?? null,
      cliReadyMs: timingMarks?.cliReadyMs ?? null,
      turnDoneMs: timingMarks?.turnDoneMs ?? null,
      reusedSession: timingMarks?.reusedSession ?? null,
      stdoutChars: 0,
      stderrChars: 0,
    })),
  );
}

function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.engine}|${r.condition}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const table = [];
  for (const [k, rs] of by) {
    const [engine, condition] = k.split("|");
    const ttft = rs.map((r) => r.ttftMs);
    const tot = rs.map((r) => r.totalMs);
    table.push({
      engine,
      condition,
      n: rs.length,
      ttftMedian: median(ttft),
      ttftP90: p90(ttft),
      totalMedian: median(tot),
      totalP90: p90(tot),
    });
  }
  return table;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = {
  stamp,
  mode: MODE,
  note: runB
    ? "Includes Orbit driver path (B) via fake-acp-cli + createAcpDriver. A (bare CLI) included only if --mode=A|both."
    : "Bare CLI (A) only. Orbit driver path (B) skipped this run.",
  modeB: modeBMeta,
  installed: runA
    ? { grok: !!grok, claude: !!claude, gemini: !!gemini, muse: !!muse, codex: !!codex }
    : undefined,
  summary: summarize(all),
  rows: all.map(({ stdout, stderr, ...r }) => ({
    ...r,
    stdoutChars: r.stdoutChars ?? stdout?.length ?? 0,
    stderrChars: r.stderrChars ?? stderr?.length ?? 0,
  })),
};

const jsonPath = join(RESULTS, `${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(out, null, 2));
const md = [
  `# Turn latency ${stamp}`,
  "",
  `mode: ${MODE}`,
  "",
  "| engine | condition | n | TTFT median | TTFT p90 | total median | total p90 |",
  "|---|---|---:|---:|---:|---:|---:|",
  ...out.summary.map(
    (r) =>
      `| ${r.engine} | ${r.condition} | ${r.n} | ${r.ttftMedian} | ${r.ttftP90} | ${r.totalMedian} | ${r.totalP90} |`,
  ),
  "",
  out.note,
  "",
  modeBMeta?.outPath ? `Mode B detail: ${modeBMeta.outPath}` : "",
  modeBMeta?.dataDir ? `OMB_DATA_DIR (timing): ${modeBMeta.dataDir}` : "",
  "",
].join("\n");
writeFileSync(join(RESULTS, `${stamp}.md`), md);
console.log(md);
console.log("wrote", jsonPath);
