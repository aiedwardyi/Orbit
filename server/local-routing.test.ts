import { describe, expect, it, vi } from "vitest";
import {
  defaultComputerForNewBot,
  localVmTurnPlan,
  packagedOrbitServer,
  shouldMountLocalComputer,
} from "./local-routing.ts";

describe("local computer routing", () => {
  it("never lets Linux Auto fall back to the user's desktop", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "linux",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("requires an explicit local selection and an approval-capable provider on Linux", () => {
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "linux",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "linux",
        providerSupportsLocal: false,
      }),
    ).toBe(false);
  });

  it("preserves the established macOS Auto fallback", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
  });

  it("never mounts the local desktop for explicit cloud/off or on an unsupported host", () => {
    for (const requested of ["cloud", "off"] as const) {
      expect(
        shouldMountLocalComputer({
          requested,
          hostPlatform: "darwin",
          providerSupportsLocal: true,
        }),
      ).toBe(false);
    }
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "win32",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });
});

describe("packaged Windows first-run computer default", () => {
  it("defaults Runs-on to Off so a packaged Windows install can chat without Docker", () => {
    expect(defaultComputerForNewBot({ platform: "win32", packaged: true })).toBe("off");
  });

  it("keeps Auto on unpackaged Windows and on other packaged desktops", () => {
    expect(defaultComputerForNewBot({ platform: "win32", packaged: false })).toBeUndefined();
    expect(defaultComputerForNewBot({ platform: "darwin", packaged: true })).toBeUndefined();
    expect(defaultComputerForNewBot({ platform: "linux", packaged: true })).toBeUndefined();
  });

  it("treats the packaged Electron harness env as packaged", () => {
    expect(packagedOrbitServer({ OMB_PACKAGED: "1" })).toBe(true);
    expect(packagedOrbitServer({ OMB_STATIC_DIR: "/tmp/ui" })).toBe(false);
    expect(packagedOrbitServer({})).toBe(false);
  });

  it("uses OMB_PACKAGED when host.packaged is omitted", () => {
    vi.stubEnv("OMB_PACKAGED", "1");
    expect(defaultComputerForNewBot({ platform: "win32" })).toBe("off");
    vi.stubEnv("OMB_PACKAGED", "");
    expect(defaultComputerForNewBot({ platform: "win32" })).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe("Local VM turn planning", () => {
  it("does not hard-fail a chat when no container runtime is installed", () => {
    expect(localVmTurnPlan({ runtime: null, ready: false })).toBe("skip-uninstalled");
  });

  it("still mounts an explicit Local VM that is ready, and fails when a runtime exists but the VM is not", () => {
    expect(localVmTurnPlan({ runtime: "docker", ready: true })).toBe("mount");
    expect(localVmTurnPlan({ runtime: "docker", ready: false })).toBe("fail");
  });
});
