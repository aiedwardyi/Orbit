import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workerReportText } from "./drivers/terminal-proxy.ts";
import type { RateLimitsMap, RateLimitsReport } from "./rate-limits-store.ts";
import { createSpawnUsage, spawnEngine } from "./spawn-usage.ts";

const NOW = new Date(2026, 9, 25, 12, 30).getTime();
const RESET = new Date(2026, 9, 25, 13, 40).getTime();
const WEEKLY_RESET = NOW + 3 * 24 * 60 * 60_000;
const BOT = "career";
const LABEL = "CAREER | gpt-6-astra | high";
const CODEX = "codex --model gpt-6-astra -c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox 'Read C:/cards/CAREER.md and do it.'";
const HOLD_TAIL = "Pick another engine, or send the same spawn again within 2 min to launch anyway.";
const WIN = workerReportText("win32", true);

function reading(sessionUsed: number, weeklyUsed: number, at = NOW - 60_000, sessionReset: number | null = RESET, weeklyReset: number | null = WEEKLY_RESET): RateLimitsReport {
  return {
    observedAt: new Date(at).toISOString(),
    windows: [
      { id: "five_hour", usedPercent: sessionUsed, resetsAt: sessionReset, windowMinutes: 300 },
      { id: "seven_day", usedPercent: weeklyUsed, resetsAt: weeklyReset, windowMinutes: 10_080 },
    ],
  };
}

type Refresh = (instanceId: string, previous: RateLimitsReport | undefined) => Promise<{ report?: RateLimitsReport }>;

function setup(initial?: RateLimitsReport, refresh = vi.fn<Refresh>(async () => ({})), environment: Record<string, string> = {}) {
  const clock = { now: NOW };
  const rateLimits: RateLimitsMap = new Map(initial ? [["codex", initial]] : []);
  const save = vi.fn();
  return { clock, rateLimits, save, refresh, check: createSpawnUsage({ rateLimits, save, refresh, environment: () => environment, now: () => clock.now }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("spawnEngine", () => {
  it.each([
    { template: "Claude", name: "Claude", instanceId: "claude", command: `claude --model claude-opus-5-5 --effort high --dangerously-skip-permissions ${WIN.claude}'Read C:/cards/X.md and do it.'` },
    { template: "Codex", name: "Codex", instanceId: "codex", command: `codex --model gpt-6-astra -c model_reasoning_effort=high -c "projects={'C:/wt'={trust_level='trusted'}}" --dangerously-bypass-approvals-and-sandbox ${WIN.env}${WIN.notify}'Do it.'` },
    { template: "Muse", name: "Muse", instanceId: "muse", command: "muse --model muse-spark-1.3 --reasoning-effort high --yolo 'Do it.'" },
    { template: "Grok", name: "Grok", instanceId: "grok", command: "grok -m grok-4.7 --effort high --always-approve --trust 'Do it.'" },
    { template: "Windows Gemini", name: "Gemini", instanceId: "antigravity", command: `${WIN.agy}agy --model gemini-4-argon-high --dangerously-skip-permissions -i 'Do it.'` },
    { template: "plain Gemini", name: "Gemini", instanceId: "antigravity", command: "agy --model gemini-3.8-flash-low --dangerously-skip-permissions -i 'Do it.'" },
  ])("detects the $template template", ({ name, instanceId, command }) => {
    expect(spawnEngine(command)).toEqual({ name, instanceId });
  });

  it("skips a command that runs another account or another program", () => {
    expect(spawnEngine(`$env:CODEX_HOME='C:\\Users\\me\\.codex-work'; ${CODEX}`)).toBeNull();
    expect(spawnEngine("$Env:claude_config_dir = \"C:\\Users\\me\\.claude-2\"; claude --model claude-opus-5-5 'Do it.'")).toBeNull();
    expect(spawnEngine(`${WIN.agy}$env:CODEX_HOME='D:\\codex'; codex 'Do it.'`)).toBeNull();
    for (const command of ["pnpm dev", "codex-review --fix", "& codex 'Do it.'", "", "  "]) expect(spawnEngine(command)).toBeNull();
  });
});

describe("createSpawnUsage", () => {
  it("adds the usage line when both windows have room", async () => {
    const { check, refresh } = setup(reading(38, 13));
    expect(await check(BOT, LABEL, CODEX)).toEqual({ line: "Codex usage left: 5h 62% (resets 13:40), weekly 87%." });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("holds under 25% left in the 5h window", async () => {
    expect(await setup(reading(85, 13)).check(BOT, LABEL, CODEX)).toEqual({ hold: `Held: Codex 5h 15% left (resets 13:40), weekly 87% left. ${HOLD_TAIL}` });
    expect(await setup(reading(75, 13)).check(BOT, LABEL, CODEX)).toEqual({ line: "Codex usage left: 5h 25% (resets 13:40), weekly 87%." });
  });

  it("holds under 10% left in the weekly window", async () => {
    expect(await setup(reading(20, 91)).check(BOT, LABEL, CODEX)).toEqual({ hold: `Held: Codex 5h 80% left (resets 13:40), weekly 9% left. ${HOLD_TAIL}` });
    expect(await setup(reading(20, 90)).check(BOT, LABEL, CODEX)).toEqual({ line: "Codex usage left: 5h 80% (resets 13:40), weekly 10%." });
  });

  it("launches the same spawn sent again within 2 min, once", async () => {
    const { check, clock } = setup(reading(85, 13));
    expect(await check(BOT, LABEL, CODEX)).toHaveProperty("hold");
    expect(await check(BOT, "OTHER | gpt-6-astra | high", CODEX)).toHaveProperty("hold");
    expect(await check(BOT, LABEL, `${CODEX} `)).toHaveProperty("hold");
    expect(await check("orch", LABEL, CODEX)).toHaveProperty("hold");
    clock.now += 2 * 60_000;
    expect(await check(BOT, LABEL, CODEX)).toEqual({ line: "Codex usage left: 5h 15% (resets 13:40), weekly 87%." });
    expect(await check(BOT, LABEL, CODEX)).toHaveProperty("hold");
    clock.now += 2 * 60_000 + 1;
    expect(await check(BOT, LABEL, CODEX)).toHaveProperty("hold");
  });

  it("never holds on a window whose reset has passed or is unknown", async () => {
    expect(await setup(reading(95, 13, NOW - 60_000, NOW - 1)).check(BOT, LABEL, CODEX)).toEqual({ line: "Codex usage left: weekly 87%." });
    expect(await setup(reading(20, 95, NOW - 60_000, RESET, NOW)).check(BOT, LABEL, CODEX)).toEqual({ line: "Codex usage left: 5h 80% (resets 13:40)." });
    expect(await setup(reading(95, 13, NOW - 60_000, null)).check(BOT, LABEL, CODEX)).toEqual({ line: "Codex usage left: 5h 5%, weekly 87%." });
  });

  it("skips another account without reading or refreshing usage", async () => {
    const { check, refresh } = setup(reading(85, 13, NOW - 60 * 60_000));
    expect(await check(BOT, LABEL, `$env:CODEX_HOME='C:\\Users\\me\\.codex-work'; ${CODEX}`)).toEqual({});
    expect(refresh).not.toHaveBeenCalled();
  });

  it("skips an engine whose instance runs another account", async () => {
    const environments: Record<string, string>[] = [{ CODEX_HOME: "C:\\Users\\me\\.codex-work" }, { Claude_Config_Dir: "C:\\Users\\me\\.claude-2" }];
    for (const environment of environments) {
      const { check, refresh } = setup(reading(85, 13, NOW - 60 * 60_000), undefined, environment);
      expect(await check(BOT, LABEL, CODEX)).toEqual({});
      expect(refresh).not.toHaveBeenCalled();
    }
    expect(await setup(reading(85, 13), undefined, { PATH: "C:\\bin" }).check(BOT, LABEL, CODEX)).toHaveProperty("hold");
  });

  it("says nothing for an unknown engine or no data", async () => {
    const { check, refresh } = setup();
    expect(await check(BOT, "dev server", "pnpm dev")).toEqual({});
    expect(refresh).not.toHaveBeenCalled();
    expect(await check(BOT, LABEL, CODEX)).toEqual({});
    expect(refresh).toHaveBeenCalledWith("codex", undefined);
  });

  it("refreshes a reading over 5 min old before deciding", async () => {
    const stale = reading(38, 13, NOW - 5 * 60_000 - 1);
    const fresh = reading(85, 13, NOW);
    const { check, refresh, rateLimits, save } = setup(stale, vi.fn<Refresh>(async () => ({ report: fresh })));
    expect(await check(BOT, LABEL, CODEX)).toEqual({ hold: `Held: Codex 5h 15% left (resets 13:40), weekly 87% left. ${HOLD_TAIL}` });
    expect(refresh).toHaveBeenCalledWith("codex", stale);
    expect(rateLimits.get("codex")).toBe(fresh);
    expect(save).toHaveBeenCalledOnce();
    const recent = setup(reading(38, 13, NOW - 5 * 60_000));
    await recent.check(BOT, LABEL, CODEX);
    expect(recent.refresh).not.toHaveBeenCalled();
  });

  it("decides on the reading it has when the refresh takes over 3 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let land!: (value: { report?: RateLimitsReport }) => void;
    const { check, rateLimits } = setup(reading(85, 13, NOW - 10 * 60_000), vi.fn<Refresh>(() => new Promise((resolve) => { land = resolve; })));
    let settled = false;
    const result = check(BOT, LABEL, CODEX).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ hold: `Held: Codex 5h 15% left (resets 13:40), weekly 87% left. ${HOLD_TAIL}` });
    const late = reading(38, 13, NOW);
    land({ report: late });
    await vi.waitFor(() => expect(rateLimits.get("codex")).toBe(late));
  });

  it("is wired to the bot's own spawn-usage route", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const route = source.slice(source.indexOf('path === "/api/internal/spawn-usage"'));
    expect(route.slice(0, route.indexOf("\n      }\n"))).toContain("spawnUsage(from.id, String(body.label ?? \"\"), String(body.command ?? \"\"))");
  });
});
