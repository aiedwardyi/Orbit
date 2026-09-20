import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTurnTimer } from "./turn-timing.ts";

describe("turn-timing", () => {
  const dir = join(tmpdir(), `orbit-turn-timing-${process.pid}`);
  const prevTiming = process.env.ORBIT_TURN_TIMING;
  const prevData = process.env.OMB_DATA_DIR;

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    process.env.OMB_DATA_DIR = dir;
    process.env.ORBIT_TURN_TIMING = "1";
  });

  afterEach(() => {
    if (prevTiming === undefined) delete process.env.ORBIT_TURN_TIMING;
    else process.env.ORBIT_TURN_TIMING = prevTiming;
    if (prevData === undefined) delete process.env.OMB_DATA_DIR;
    else process.env.OMB_DATA_DIR = prevData;
    const p = join(dir, "turn-timing.jsonl");
    if (existsSync(p)) unlinkSync(p);
  });

  it("is a no-op when ORBIT_TURN_TIMING is off", () => {
    process.env.ORBIT_TURN_TIMING = "0";
    const t = startTurnTimer({ engine: "grok" });
    t.mark("dispatch");
    t.finish();
    expect(existsSync(join(dir, "turn-timing.jsonl"))).toBe(false);
  });

  it("appends one JSON line with ms marks when enabled", () => {
    const t = startTurnTimer({ engine: "grok", model: "grok-4", effort: "low", botId: "b1" });
    t.mark("dispatch");
    t.mark("spawnOrReuse");
    t.mark("cliReady");
    t.mark("firstVisible");
    t.mark("turnDone");
    t.finish({ mcpServerCount: 0, argsLength: 12, systemPromptChars: 100 });
    // DATA_DIR is captured at config import time from OMB_DATA_DIR — may be process default
    // when config loaded earlier. Prefer reading via env data dir OR default ~/.orbit if test isolation failed.
    const candidates = [join(dir, "turn-timing.jsonl"), join(process.env.OMB_DATA_DIR ?? dir, "turn-timing.jsonl")];
    const path = candidates.find((p) => existsSync(p));
    expect(path, "timing file written").toBeTruthy();
    const row = JSON.parse(readFileSync(path!, "utf8").trim());
    expect(row.engine).toBe("grok");
    expect(row.model).toBe("grok-4");
    expect(typeof row.dispatchMs).toBe("number");
    expect(typeof row.firstVisibleMs).toBe("number");
    expect(typeof row.turnDoneMs).toBe("number");
    expect(row.systemPromptChars).toBe(100);
  });
});
