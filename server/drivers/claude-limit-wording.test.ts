import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import { ClaudeDriver } from "./claude.ts";
import { chatUsageLimit } from "./rate-limits.ts";
import { recordEvents } from "../testing/events.ts";

const FAKE_CLI = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
const CONTROL = "You've hit your limit · resets 3am (Asia/Seoul)";
const REAL = [
  "You've hit your session limit · resets 3am (Asia/Seoul)",
  "API Error: You've hit your session limit · resets 9:20pm (Asia/Seoul) (error type rate_limit, HTTP 429)",
  "You've hit your weekly limit · resets Nov 2, 9am (Asia/Seoul)",
];

describe("HIGH 1 Claude limit wording", () => {
  let instance: Awaited<ReturnType<typeof ClaudeDriver.create>> | undefined;
  let recorder: ReturnType<typeof recordEvents> | undefined;

  beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
  });

  it.each([CONTROL, ...REAL])("the driver marks a usage limit for: %s", async (text) => {
    process.env.FAKE_CLAUDE_MODE = "usage-limit";
    const reset = Math.floor(Date.now() / 1000) + 3600;
    instance = await ClaudeDriver.create({
      instanceId: "claude-audit", displayName: "Claude", enabled: true,
      environment: { FAKE_CLAUDE_RESET_AT: String(reset), FAKE_CLAUDE_FAILURE_TEXT: text },
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-audit-limit", text: "continue work", model: "claude-opus-5" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "runtime.error" && "usageLimit" in e && e.usageLimit)).toHaveLength(1);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "usage_limit" });
  });

  it("chatUsageLimit accepts the typographic apostrophe the pane regex already allows", () => {
    const now = Date.parse("2026-10-28T00:00:00Z");
    const spent = [{ id: "five_hour", usedPercent: 100, resetsAt: now + 3_600_000, windowMinutes: 300 }];
    expect(chatUsageLimit("claude", "You\u2019ve hit your limit · resets 3am (Asia/Seoul)", spent, true, now)).not.toBeNull();
  });
});

it("a marked usage limit does not also stream its text as a reply", async () => {
  ensureDirs(); chmodSync(FAKE_CLI, 0o755);
  process.env.FAKE_CLAUDE_MODE = "usage-limit";
  const instance = await ClaudeDriver.create({
    instanceId: "claude-audit-l7", displayName: "Claude", enabled: true,
    environment: { FAKE_CLAUDE_RESET_AT: String(Math.floor(Date.now() / 1000) + 3600), FAKE_CLAUDE_FAILURE_TEXT: CONTROL },
    config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "t-audit-l7", text: "continue work", model: "claude-opus-5" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.some((e) => e.type === "runtime.error" && "usageLimit" in e && e.usageLimit)).toBe(true);
    expect(recorder.events.filter((e) => e.type === "item.completed" && "text" in e && e.text === CONTROL)).toHaveLength(0);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    recorder.stop();
    await instance.dispose();
  }
});
