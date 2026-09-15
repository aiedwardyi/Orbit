import { describe, expect, it } from "vitest";

import { MspMuseAgentDriver, MSP_MUSE_EFFORT_LEVELS, MSP_MUSE_MODELS } from "./muse.ts";
import { classifyMuseError, museDefaultCli } from "../acp/muse.ts";
import { defaultModelEffort } from "../../../shared/model-effort.ts";

describe("classifyMuseError MSP turn errors", () => {
  it("maps authRequired to invalid_credentials, leaves the rest generic", () => {
    expect(classifyMuseError({ kind: "authRequired", message: "login expired" })).toBe("invalid_credentials");
    expect(classifyMuseError({ kind: "modelError", message: "boom" })).toBeUndefined();
  });

  it("keeps the ACP envelope behavior unchanged", () => {
    expect(classifyMuseError({ code: "AUTH_REQUIRED" })).toBe("invalid_credentials");
    expect(classifyMuseError({ code: "QUOTA_EXCEEDED" })).toBe("quota_or_region_restriction");
    expect(classifyMuseError({ code: -32601 })).toBeUndefined();
  });
});

describe("MSP Muse driver", () => {
  it("ships the four live model/list models with the 1.3 default", () => {
    expect(MSP_MUSE_MODELS.default).toBe("muse-spark-1.3");
    expect(MSP_MUSE_MODELS.options.map((o) => o.id)).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
    ]);
    expect(MspMuseAgentDriver.models).toEqual(MSP_MUSE_MODELS);
  });

  it("registers behind the same museAgent kind the fleet keys on", () => {
    expect(MspMuseAgentDriver.driverKind).toBe("museAgent");
    expect(MspMuseAgentDriver.metadata.displayName).toBe("Meta Muse");
  });

  it("decodes the shared instance config with the platform CLI default", () => {
    expect(MspMuseAgentDriver.decodeConfig({}).cli).toBe(museDefaultCli());
    expect(MspMuseAgentDriver.decodeConfig({ cli: "custom-muse", fullAuto: true })).toMatchObject({
      cli: "custom-muse",
      fullAuto: true,
    });
    expect(MspMuseAgentDriver.defaultConfig().cli).toBe(museDefaultCli());
  });

  it("advertises the six CLI /effort tiers", async () => {
    expect([...MSP_MUSE_EFFORT_LEVELS]).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    const instance = await MspMuseAgentDriver.create({
      instanceId: "msp-effort-caps",
      displayName: "MSP Effort",
      environment: {},
      enabled: true,
      config: { cli: "missing-muse-cli", fullAuto: false },
    });
    try {
      expect(instance.adapter.capabilities.effortLevels).toEqual([...MSP_MUSE_EFFORT_LEVELS]);
    } finally {
      await instance.dispose();
    }
  });

  it("leaves the Muse default unset so the CLI keeps its own (high)", () => {
    for (const model of ["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-spark-1.2"]) {
      expect(defaultModelEffort("museAgent", model, [...MSP_MUSE_EFFORT_LEVELS])).toBeUndefined();
    }
    expect(defaultModelEffort("claudeAgent", "claude-sonnet-5", ["low", "medium", "high", "xhigh", "max"])).toBe(
      "high",
    );
  });

  it("gates turns on the ambient login, not a stored-file probe alone", async () => {
    const offline = await MspMuseAgentDriver.create({
      instanceId: "msp-auth-off",
      displayName: "MSP Auth",
      environment: {},
      enabled: true,
      config: { cli: "missing-muse-cli", fullAuto: false },
    });
    expect(await offline.snapshot()).toMatchObject({ state: "unavailable" });
    await offline.dispose();
  });
});
