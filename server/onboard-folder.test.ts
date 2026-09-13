// Onboarding folder choice: a chosen folder persists on the bot and shows
// in bot details; skipping keeps the private-workspace behavior.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";
import { validateBotCwd } from "./bot-cwd.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

const dir = mkdtempSync(join(tmpdir(), "omb-onboard-folder-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("onboard folder choice", () => {
  it("creation with a chosen folder persists it on the bot", () => {
    const checked = validateBotCwd(dir);
    expect(checked.ok).toBe(true);
    const cwd = checked.ok ? checked.cwd! : dir;
    const store = new Store(selection);
    const bot = store.createBot({ cwd }, { job: "Keep a weekly brief." });
    expect(bot.cwd).toBe(cwd);
    expect(store.bot(bot.id)?.cwd).toBe(cwd);
  });

  it("creation skipped keeps private-workspace behavior (no cwd)", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { job: "Keep a weekly brief." });
    expect(bot.cwd).toBeUndefined();
    expect(store.bot(bot.id)?.cwd).toBeUndefined();
  });

  it("wires the folder choice through creation UI into bot details", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sheet = readFileSync(join(here, "..", "src", "components", "CreateBotSheet.tsx"), "utf8");
    expect(sheet).toContain('t("bot.workingFolder")');
    expect(sheet).toContain("cwd");
    expect(sheet).toContain("/api/bots");
    const index = readFileSync(join(here, "index.ts"), "utf8");
    expect(index).toContain("validateBotCwd(body.cwd");
    const settings = readFileSync(join(here, "..", "src", "components", "SettingsPanel.tsx"), "utf8");
    expect(settings).toContain("<WorkingFolder bot={bot} />");
  });
});
