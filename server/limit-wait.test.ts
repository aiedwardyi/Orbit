import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { TASK_RESUME_PROMPT } from "./turn-context.ts";

it("resumes an ordinary Claude chat once on its original thread and selection after reopening storage", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "limit-wait-")), "limit-waits.json");
  const selection = { instanceId: "claude", model: "opus", effort: "max" as const };
  let now = Date.parse("2026-10-28T00:00:00Z");
  const reset = now + 5 * 60 * 60_000;
  const dispatch = vi.fn(async () => {});
  const current = () => ({ threadId: "chat", controlKey: "same-request-and-account", busy: false });
  const usage = vi.fn(async () => ({
    report: { observedAt: new Date(now).toISOString(), windows: [
      { id: "five_hour", usedPercent: 0, resetsAt: null },
      { id: "seven_day", usedPercent: 50, resetsAt: null },
    ] }, retryAt: now + 30_000,
  }));
  // Base has passive limit rows but no wait owner. Keep that path executable for the red evidence.
  const modulePath = "./limit-wait.ts";
  const open = async () => existsSync(new URL(modulePath, import.meta.url))
    ? new (await import(/* @vite-ignore */ modulePath)).LimitWaits({ file, now: () => now, deviceId: () => "pc-a", current, usage, dispatch })
    : null;
  let waits = await open();
  waits?.track("bot", "chat", selection);
  waits?.bind("chat", "failed-turn");
  waits?.failed("chat", "failed-turn", reset, "limit-row", ["five_hour", "seven_day"]);
  waits?.settled("chat", "failed-turn", false);
  waits = await open();
  now = reset + 30_000;
  await Promise.all([waits?.tick(), waits?.tick()]);
  await waits?.tick();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot", threadId: "chat", selection }), TASK_RESUME_PROMPT);
  expect(usage).toHaveBeenCalledTimes(1);
});
