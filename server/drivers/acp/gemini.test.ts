import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { ensureWorkspace } from "../../workspace.ts";
import { GeminiAgentDriver } from "./gemini.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("Gemini workspace trust", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-gemini-trust-"));
    delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    delete process.env.FAKE_ACP_DUMP;
    await removeTempDir(scratch);
  });

  const trustEnvFor = async (cwd: string) => {
    instance = await GeminiAgentDriver.create({
      instanceId: "gemini-trust",
      displayName: "Gemini",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const dump = join(scratch, "gemini-trust.json");
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-gemini-trust", text: "go", cwd });
    await recorder.until((e) => e.type === "turn.completed");

    return JSON.parse(readFileSync(dump, "utf8")).env.GEMINI_CLI_TRUST_WORKSPACE;
  };

  it("trusts a wink bot workspace", async () => {
    expect(await trustEnvFor(ensureWorkspace("gemini-bot"))).toBe("true");
  });

  it("leaves trust alone for any other folder", async () => {
    expect(await trustEnvFor(scratch)).toBeUndefined();
  });
});
