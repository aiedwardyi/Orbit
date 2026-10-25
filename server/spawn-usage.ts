// Usage left for the engine a terminal_spawn launches, and a hold on a nearly empty window.
import type { RateLimitWindow } from "./contracts.ts";
import type { RateLimitsMap, RateLimitsReport } from "./rate-limits-store.ts";

type Engine = { name: string; instanceId: string };
type SpawnUsage = { hold?: string; line?: string };

// First words of the terminal_spawn templates, each with its engine's default instance.
const ENGINES = new Map<string, Engine>([
  ["claude", { name: "Claude", instanceId: "claude" }],
  ["codex", { name: "Codex", instanceId: "codex" }],
  ["grok", { name: "Grok", instanceId: "grok" }],
  ["agy", { name: "Gemini", instanceId: "antigravity" }],
  ["muse", { name: "Muse", instanceId: "muse" }],
]);
// The Gemini template on Windows leads with `$env:NAME='value'; `.
const ENV_STATEMENT = /^\s*\$env:(\w+)\s*=\s*(?:'[^']*'|"[^"]*"|[^\s;]+)\s*;/i;
// Either one points the CLI at another account than the default instance reads.
const OTHER_HOME = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR"]);
const STALE_MS = 5 * 60_000;
const REFRESH_CAP_MS = 3_000;
const REPEAT_MS = 2 * 60_000;
const SESSION_MIN_LEFT = 25;
const WEEKLY_MIN_LEFT = 10;
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function spawnEngine(command: string): Engine | null {
  let rest = command;
  for (let statement = ENV_STATEMENT.exec(rest); statement; statement = ENV_STATEMENT.exec(rest)) {
    if (OTHER_HOME.has(statement[1].toUpperCase())) return null;
    rest = rest.slice(statement[0].length);
  }
  return ENGINES.get(rest.trimStart().split(/\s/, 1)[0]) ?? null;
}

// Whole percent left, as the usage bars show it.
const left = (window: RateLimitWindow) => Math.max(0, 100 - Math.max(0, Math.round(window.usedPercent)));

function settleWithin(pending: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    pending.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
}

type Deps = {
  rateLimits: RateLimitsMap;
  save: () => void;
  refresh: (instanceId: string, previous: RateLimitsReport | undefined) => Promise<{ report?: RateLimitsReport }>;
  now?: () => number;
};

export function createSpawnUsage(deps: Deps) {
  const now = deps.now ?? Date.now;
  const held = new Map<string, number>();
  const refreshed = async (instanceId: string) => {
    const result = await deps.refresh(instanceId, deps.rateLimits.get(instanceId));
    const current = deps.rateLimits.get(instanceId);
    if (result.report && (!current || Date.parse(result.report.observedAt) >= Date.parse(current.observedAt))) {
      deps.rateLimits.set(instanceId, result.report);
      deps.save();
    }
  };
  return async (botId: string, label: string, command: string): Promise<SpawnUsage> => {
    const engine = spawnEngine(command);
    if (!engine) return {};
    const report = deps.rateLimits.get(engine.instanceId);
    if (!report || !(now() - Date.parse(report.observedAt) <= STALE_MS)) await settleWithin(refreshed(engine.instanceId), REFRESH_CAP_MS);
    const at = now();
    // A passed reset makes the last fill history, so that window drops out.
    const live = (deps.rateLimits.get(engine.instanceId)?.windows ?? []).filter((window) => window.resetsAt === null || window.resetsAt > at);
    const session = live.find((window) => window.id === "five_hour");
    const weekly = live.find((window) => window.id === "seven_day");
    if (!session && !weekly) return {};
    const text = (suffix: string) => [
      session && `5h ${left(session)}%${suffix}${session.resetsAt === null ? "" : ` (resets ${CLOCK.format(session.resetsAt)})`}`,
      weekly && `weekly ${left(weekly)}%${suffix}`,
    ].filter(Boolean).join(", ");
    const low = (window: RateLimitWindow | undefined, min: number) => window !== undefined && window.resetsAt !== null && left(window) < min;
    for (const [key, heldAt] of held) if (at - heldAt > REPEAT_MS) held.delete(key);
    const key = JSON.stringify([botId, label, command]);
    if ((low(session, SESSION_MIN_LEFT) || low(weekly, WEEKLY_MIN_LEFT)) && !held.has(key)) {
      held.set(key, at);
      return { hold: `Held: ${engine.name} ${text(" left")}. Pick another engine, or send the same spawn again within 2 min to launch anyway.` };
    }
    held.delete(key);
    return { line: `${engine.name} usage left: ${text("")}.` };
  };
}
