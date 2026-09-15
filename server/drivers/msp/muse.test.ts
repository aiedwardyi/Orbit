import { describe, expect, it } from "vitest";

import { MspMuseAgentDriver, MSP_MUSE_MODELS } from "./muse.ts";
import { classifyMuseError, museDefaultCli } from "../acp/muse.ts";

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
