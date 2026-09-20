// The win32 WSL gate. A passive probe — boot, app-load, alt-tab refresh —
// must never spawn wsl.exe on a cold WSL, because that reboots the VM and
// steals keyboard focus. A turn or an explicit rescan still may.
//
// No test here spawns a real wsl.exe: the gate's distro listing is injected
// and procs.execCli is mocked, so the assertions are exact call counts.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { createAcpDriver, type AcpSupport } from "./drivers/acp/core.ts";
import { museIsAuthenticated, museWslFallbackCli } from "./drivers/acp/muse.ts";
import type { ProviderInstance } from "./contracts.ts";
import { recordEvents } from "./testing/events.ts";
import * as procs from "./procs.ts";
import { isWslCommand, setWslGateForTests, wslProbeAllowed } from "./wsl-gate.ts";

const isWsl = (cli: string) => isWslCommand(cli);

let execCalls: string[] = [];
let listRunning: Mock<() => string>;
let wslResolveCli: Mock<() => Promise<string>>;
let isAuthenticated: Mock<() => boolean>;
let instance: ProviderInstance | null = null;

/** A WSL-backed harness with the same three-step fallback as Meta Muse, so
 * the gate is exercised without depending on a real CLI being installed. */
function gateDriver() {
  const support: AcpSupport = {
    driverKind: "wslGateTest",
    displayName: "Gate Test",
    models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
    defaultCli: "gate-test-cli",
    nativeSource: "test.acp",
    loginNote: "never reached",
    spawnArgs: () => [],
    pickAuthMethod: () => null,
    authFailure: "continue",
    wslProbeWrapper: museWslFallbackCli,
    wslResolveCli,
    isAuthenticated,
  };
  return createAcpDriver(support);
}

async function createInstance() {
  instance = await gateDriver().create({
    instanceId: "wsl-gate",
    displayName: "Gate Test",
    environment: {},
    enabled: true,
    config: { cli: "gate-test-cli", fullAuto: false, prewarm: false },
  });
  return instance;
}

beforeEach(() => {
  execCalls = [];
  listRunning = vi.fn(() => "");
  wslResolveCli = vi.fn(async () => "wsl /home/u/.local/bin/gate-test-cli");
  isAuthenticated = vi.fn(() => true);
  vi.spyOn(procs, "execCli").mockImplementation((cli, _args, _opts, cb) => {
    execCalls.push(cli);
    cb(new Error("spawn ENOENT"), "");
  });
  setWslGateForTests({ platform: "win32", env: {}, listRunning });
});

afterEach(async () => {
  await instance?.dispose();
  instance = null;
  setWslGateForTests(null);
  vi.restoreAllMocks();
});

describe("wslProbeAllowed", () => {
  it("refuses a passive probe while WSL is down and allows the user-driven ones", () => {
    expect(wslProbeAllowed("passive")).toBe(false);
    expect(wslProbeAllowed("turn")).toBe(true);
    expect(wslProbeAllowed("rescan")).toBe(true);
  });

  it("allows a passive probe once a distro is already running", () => {
    listRunning.mockReturnValue("Ubuntu\n");
    expect(wslProbeAllowed("passive")).toBe(true);
  });

  it("refuses every reason under ORBIT_NO_WSL=1, without listing distros", () => {
    setWslGateForTests({ platform: "win32", env: { ORBIT_NO_WSL: "1" }, listRunning });
    expect([wslProbeAllowed("passive"), wslProbeAllowed("turn"), wslProbeAllowed("rescan")]).toEqual([false, false, false]);
    expect(listRunning).not.toHaveBeenCalled();
  });

  it("is a no-op off win32", () => {
    setWslGateForTests({ platform: "linux", env: {}, listRunning });
    expect(wslProbeAllowed("passive")).toBe(true);
    expect(listRunning).not.toHaveBeenCalled();
  });

  it("reads a running distro list as UTF-16LE, the way wsl.exe writes it", () => {
    listRunning.mockReturnValue(Buffer.from("Ubuntu\n", "utf16le").toString("utf16le"));
    expect(wslProbeAllowed("passive")).toBe(true);
  });
});

describe("snapshot() under the gate", () => {
  it("spawns no wsl.exe on a passive snapshot while WSL is down", async () => {
    const inst = await createInstance();
    const snapshot = await inst.snapshot();
    expect(execCalls.filter(isWsl)).toEqual([]);
    expect(wslResolveCli).not.toHaveBeenCalled();
    expect(isAuthenticated).not.toHaveBeenCalled();
    expect(snapshot).toEqual({
      state: "unavailable",
      reason: "Gate Test runs in WSL. Send it a message or press Check again to start WSL.",
    });
  });

  it("probes WSL exactly as before once a distro is running", async () => {
    listRunning.mockReturnValue("Ubuntu\n");
    const inst = await createInstance();
    const snapshot = await inst.snapshot();
    expect(execCalls).toEqual(["gate-test-cli", "wsl gate-test-cli", "wsl /home/u/.local/bin/gate-test-cli"]);
    expect(wslResolveCli).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual({ state: "unavailable", reason: "`gate-test-cli` CLI not found" });
  });

  it("probes WSL on an explicit rescan even while WSL is down", async () => {
    const inst = await createInstance();
    await inst.snapshot();
    expect(execCalls.filter(isWsl)).toEqual([]);
    await inst.snapshot({ rescan: true });
    expect(execCalls.filter(isWsl)).toEqual(["wsl gate-test-cli", "wsl /home/u/.local/bin/gate-test-cli"]);
  });

  it("spawns no wsl.exe on any snapshot under ORBIT_NO_WSL=1", async () => {
    setWslGateForTests({ platform: "win32", env: { ORBIT_NO_WSL: "1" }, listRunning });
    const inst = await createInstance();
    const snapshot = await inst.snapshot({ rescan: true });
    expect(execCalls.filter(isWsl)).toEqual([]);
    expect(wslResolveCli).not.toHaveBeenCalled();
    expect(snapshot).toEqual({
      state: "unavailable",
      reason: "Gate Test runs in WSL, which is disabled by ORBIT_NO_WSL=1.",
    });
  });

  it("leaves an engine with no WSL fallback alone", async () => {
    instance = await createAcpDriver({
      driverKind: "nativeOnlyTest",
      displayName: "Native Only",
      models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
      defaultCli: "native-only-cli",
      nativeSource: "test.acp",
      loginNote: "never reached",
      spawnArgs: () => [],
      pickAuthMethod: () => null,
      authFailure: "continue",
      isAuthenticated: () => true,
    }).create({
      instanceId: "native-only",
      displayName: "Native Only",
      environment: {},
      enabled: true,
      config: { cli: "native-only-cli", fullAuto: false, prewarm: false },
    });
    expect(await instance.snapshot()).toEqual({ state: "unavailable", reason: "`native-only-cli` CLI not found" });
    expect(listRunning).not.toHaveBeenCalled();
  });
});

describe("turns under the gate", () => {
  it("probes WSL from cold, so a blocked snapshot never poisons the first turn", async () => {
    const inst = await createInstance();
    await inst.snapshot();
    expect(execCalls.filter(isWsl)).toEqual([]);
    // The turn dies at the spawn — the probe it had to run first is the point.
    vi.spyOn(procs, "spawnCli").mockImplementation(() => {
      throw new Error("spawn gate-test-cli ENOENT");
    });
    await expect(inst.adapter.sendTurn({ threadId: "t-gate", text: "hi" })).rejects.toThrow("ENOENT");
    expect(execCalls.filter(isWsl)).toEqual(["wsl gate-test-cli", "wsl /home/u/.local/bin/gate-test-cli"]);
  });

  it("tells the user WSL is off rather than spawning it under ORBIT_NO_WSL=1", async () => {
    setWslGateForTests({ platform: "win32", env: { ORBIT_NO_WSL: "1" }, listRunning });
    const inst = await createInstance();
    const recorder = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "t-no-wsl", text: "hi" });
    const failure = await recorder.until((e) => e.type === "runtime.error");
    recorder.stop();
    expect(failure).toMatchObject({ message: "Gate Test runs in WSL, which is disabled by ORBIT_NO_WSL=1." });
    expect(execCalls.filter(isWsl)).toEqual([]);
  });
});

describe("the WSL-side Muse login probe", () => {
  it("reads as logged out instead of booting WSL for a passive check", () => {
    expect(museIsAuthenticated({ HOME: "/nonexistent-home", XDG_CONFIG_HOME: "/nonexistent-xdg" }, undefined, { platform: "win32" })).toBe(false);
    expect(listRunning).toHaveBeenCalled();
  });
});
