/** Friends Computer-panel chrome: preview plus Off / This computer.
 * Cloud, Local VM, backend, Box, and schedules stay folded until asked. */

export type ComputerMode = "cloud" | "vm" | "local" | "off" | undefined;

/** The two destinations on the idle friends surface. */
export const FRIENDS_COMPUTER_DESTINATIONS = ["off", "local"] as const;

export function isFriendsComputerDestination(computer: ComputerMode): boolean {
  return computer === "off" || computer === "local";
}

export function computerRunsOnLabel(computer: ComputerMode): string {
  switch (computer) {
    case "cloud":
      return "Cloud";
    case "vm":
      return "Local VM";
    case "local":
      return "This computer";
    case "off":
      return "Off";
    default:
      return "Auto";
  }
}

export type ComputerStatusKind = "ready" | "off" | "checking" | "attention" | null;

export function computerStatusKind(input: {
  computer: ComputerMode;
  phase: string;
}): ComputerStatusKind {
  if (input.computer === "off" || input.phase === "off") return "off";
  if (input.phase === "ready" || input.phase === "vm" || input.phase === "local") return "ready";
  if (input.phase === "checking" || input.phase === "starting") return "checking";
  if (
    input.phase === "unconfigured" ||
    input.phase === "vps-unconfigured" ||
    input.phase === "vps-incompatible" ||
    input.phase === "vps-stopped" ||
    input.phase === "local-unavailable" ||
    input.phase === "vm-unavailable" ||
    input.phase === "error"
  ) {
    return "attention";
  }
  return null;
}

export function computerStatusLabel(kind: ComputerStatusKind): string | null {
  switch (kind) {
    case "ready":
      return "Ready";
    case "off":
      return "Off";
    case "checking":
      return "Checking";
    case "attention":
      return "Needs attention";
    default:
      return null;
  }
}

/** Skip the checking flash when the computer is already off. */
export function initialComputerPhase(computer: ComputerMode): "off" | "checking" {
  return computer === "off" ? "off" : "checking";
}

/** Cloud / Local VM / backend / Box / schedules stay folded until asked. */
export function showComputerAdvancedControls(advancedOpen: boolean): boolean {
  return advancedOpen;
}

/** Linux/Mac local-control and host screen-preview. Visible when this computer
 * is the destination (including Auto that landed on local), or when Advanced is open. */
export function showComputerHostControls(input: {
  computer: ComputerMode;
  phase: string;
  advancedOpen: boolean;
}): boolean {
  return (
    input.advancedOpen ||
    input.computer === "local" ||
    input.phase === "local" ||
    input.phase === "local-unavailable"
  );
}
