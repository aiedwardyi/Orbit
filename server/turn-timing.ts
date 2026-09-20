// Env-gated turn timing for latency diagnosis.
// ORBIT_TURN_TIMING=1 appends one JSON line per turn to <DATA_DIR>/turn-timing.jsonl.
// Inert when unset/off — zero behavior change for normal runs.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export type TurnTimingMarks = {
  engine?: string;
  model?: string;
  effort?: string | number | null;
  botId?: string;
  systemPromptChars?: number;
  mcpServerCount?: number;
  argsLength?: number;
  reusedSession?: boolean;
  /** Create-time spawn+initialize(+auth) borrowed; session/new still runs. */
  reusedHandshake?: boolean;
};

type Ms = number | null;

export type TurnTimer = {
  mark(name: "dispatch" | "cliProbed" | "spawnOrReuse" | "cliReady" | "firstVisible" | "turnDone"): void;
  setMeta(patch: Partial<TurnTimingMarks>): void;
  finish(extra?: Partial<TurnTimingMarks>): void;
};

function enabled(): boolean {
  const v = process.env.ORBIT_TURN_TIMING;
  return v === "1" || v === "true";
}

function dataDir(): string {
  return process.env.OMB_DATA_DIR ?? DATA_DIR;
}

function timingPath(): string {
  return join(dataDir(), "turn-timing.jsonl");
}

/** Start a turn timer. Returns a no-op timer when ORBIT_TURN_TIMING is off. */
export function startTurnTimer(meta: TurnTimingMarks = {}): TurnTimer {
  if (!enabled()) {
    return {
      mark() {},
      setMeta() {},
      finish() {},
    };
  }
  const t0 = performance.now();
  const marks: Record<string, Ms> = {
    dispatchMs: null,
    cliProbedMs: null,
    spawnOrReuseMs: null,
    cliReadyMs: null,
    firstVisibleMs: null,
    turnDoneMs: null,
  };
  let info: TurnTimingMarks = { ...meta };
  let finished = false;

  return {
    mark(name) {
      if (finished) return;
      const key =
        name === "dispatch"
          ? "dispatchMs"
          : name === "cliProbed"
            ? "cliProbedMs"
            : name === "spawnOrReuse"
              ? "spawnOrReuseMs"
              : name === "cliReady"
                ? "cliReadyMs"
                : name === "firstVisible"
                  ? "firstVisibleMs"
                  : "turnDoneMs";
      if (marks[key] == null) marks[key] = Math.round(performance.now() - t0);
    },
    setMeta(patch) {
      info = { ...info, ...patch };
    },
    finish(extra) {
      if (finished) return;
      finished = true;
      if (marks.turnDoneMs == null) marks.turnDoneMs = Math.round(performance.now() - t0);
      if (extra) info = { ...info, ...extra };
      try {
        mkdirSync(dataDir(), { recursive: true });
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          ...info,
          ...marks,
        });
        appendFileSync(timingPath(), `${line}\n`, "utf8");
      } catch {
        // Timing must never break a turn.
      }
    },
  };
}

export function turnTimingEnabled(): boolean {
  return enabled();
}

export function turnTimingFile(): string {
  return timingPath();
}
