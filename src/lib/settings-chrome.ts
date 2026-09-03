/** Friends App Settings chrome: keep the idle surface small.
 * Local VM, Channel turns, Experimental, and Diagnostics share one Advanced
 * disclosure. Connections shows Gemini only; the other services fold away. */
import type { AppSettingsSection } from "@/state/store";

/** Top-level nav on the friends Settings surface. Local VM is not a section. */
export const FRIENDS_APP_SETTINGS_SECTIONS = [
  "general",
  "connections",
  "engines",
  "usage",
] as const satisfies readonly AppSettingsSection[];

export function friendsAppSettingsNavVisible(
  id: AppSettingsSection,
  phoneAvailable: boolean,
): boolean {
  if (id === "computer") return false;
  if (id === "companion") return phoneAvailable;
  return (FRIENDS_APP_SETTINGS_SECTIONS as readonly AppSettingsSection[]).includes(id);
}

export function showSettingsAdvanced(advancedOpen: boolean): boolean {
  return advancedOpen;
}

export function showMoreServices(moreServicesOpen: boolean): boolean {
  return moreServicesOpen;
}

/** Idle General must not show these as always-visible blocks. */
export const SETTINGS_ADVANCED_BLOCKS = [
  "localVm",
  "channelTurns",
  "experimental",
  "diagnostics",
] as const;

export const CONNECTIONS_PRIMARY = "gemini" as const;

export const CONNECTIONS_MORE_SERVICES = [
  "transcription",
  "box",
  "vps",
  "opencodeGo",
] as const;
