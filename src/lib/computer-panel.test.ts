import { describe, expect, it } from "vitest";

import {
  computerRunsOnLabel,
  computerStatusKind,
  computerStatusLabel,
  initialComputerPhase,
  showComputerAdvancedControls,
  showComputerHostControls,
} from "./computer-panel";

describe("computerRunsOnLabel", () => {
  it("names each destination the Runs-on row already uses", () => {
    expect(computerRunsOnLabel("cloud")).toBe("Cloud");
    expect(computerRunsOnLabel("vm")).toBe("Local VM");
    expect(computerRunsOnLabel("local")).toBe("This computer");
    expect(computerRunsOnLabel("off")).toBe("Off");
    expect(computerRunsOnLabel(undefined)).toBe("Auto");
  });
});

describe("computerStatusKind", () => {
  it("shows Off when the computer is off, even before the panel finishes checking", () => {
    expect(computerStatusKind({ computer: "off", phase: "checking" })).toBe("off");
    expect(computerStatusKind({ computer: "off", phase: "off" })).toBe("off");
  });

  it("shows Ready for a live cloud, Local VM, or this-computer session", () => {
    expect(computerStatusKind({ computer: "cloud", phase: "ready" })).toBe("ready");
    expect(computerStatusKind({ computer: "vm", phase: "vm" })).toBe("ready");
    expect(computerStatusKind({ computer: "local", phase: "local" })).toBe("ready");
    expect(computerStatusKind({ computer: undefined, phase: "ready" })).toBe("ready");
  });

  it("shows Checking while the panel is still resolving a destination", () => {
    expect(computerStatusKind({ computer: "cloud", phase: "checking" })).toBe("checking");
    expect(computerStatusKind({ computer: undefined, phase: "starting" })).toBe("checking");
  });

  it("flags setup and error phases as needing attention", () => {
    expect(computerStatusKind({ computer: "cloud", phase: "unconfigured" })).toBe("attention");
    expect(computerStatusKind({ computer: "cloud", phase: "vps-stopped" })).toBe("attention");
    expect(computerStatusKind({ computer: "vm", phase: "vm-unavailable" })).toBe("attention");
    expect(computerStatusKind({ computer: "local", phase: "local-unavailable" })).toBe("attention");
    expect(computerStatusKind({ computer: "cloud", phase: "error" })).toBe("attention");
  });
});

describe("computerStatusLabel", () => {
  it("uses the same Ready / Off words as the engine and Local VM pills", () => {
    expect(computerStatusLabel("ready")).toBe("Ready");
    expect(computerStatusLabel("off")).toBe("Off");
    expect(computerStatusLabel("checking")).toBe("Checking");
    expect(computerStatusLabel("attention")).toBe("Needs attention");
    expect(computerStatusLabel(null)).toBeNull();
  });
});

describe("initialComputerPhase", () => {
  it("skips the checking flash when the computer is already off", () => {
    expect(initialComputerPhase("off")).toBe("off");
    expect(initialComputerPhase("cloud")).toBe("checking");
    expect(initialComputerPhase(undefined)).toBe("checking");
  });
});

describe("showComputerAdvancedControls", () => {
  it("keeps the destination zoo folded until the user asks", () => {
    expect(showComputerAdvancedControls(false)).toBe(false);
    expect(showComputerAdvancedControls(true)).toBe(true);
  });
});

describe("showComputerHostControls", () => {
  it("hides Linux/Mac local-control cards while the computer is idle and folded", () => {
    expect(showComputerHostControls({ computer: "off", phase: "off", advancedOpen: false })).toBe(false);
    expect(showComputerHostControls({ computer: "cloud", phase: "ready", advancedOpen: false })).toBe(false);
    expect(showComputerHostControls({ computer: "vm", phase: "vm", advancedOpen: false })).toBe(false);
    expect(showComputerHostControls({ computer: undefined, phase: "ready", advancedOpen: false })).toBe(false);
  });

  it("shows host controls when this computer is the destination or Advanced is open", () => {
    expect(showComputerHostControls({ computer: "local", phase: "local", advancedOpen: false })).toBe(true);
    expect(showComputerHostControls({ computer: undefined, phase: "local", advancedOpen: false })).toBe(true);
    expect(showComputerHostControls({ computer: "off", phase: "off", advancedOpen: true })).toBe(true);
    expect(
      showComputerHostControls({ computer: "local", phase: "local-unavailable", advancedOpen: false }),
    ).toBe(true);
  });
});
