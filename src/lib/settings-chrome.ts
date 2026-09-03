import type { AppSettingsSection } from "@/state/store";
import { settingsSectionMatches } from "./settings-search";

/** Power controls stay folded until asked — same as the Computer panel Advanced. */
export function showSettingsAdvancedControls(advancedOpen: boolean): boolean {
  return advancedOpen;
}

/** Box, VPS, transcription, OpenCode, and self-host stay behind More services. */
export function showSettingsMoreServices(moreServicesOpen: boolean): boolean {
  return moreServicesOpen;
}

/** Idle friends settings hide Local VM (it lives under General → Advanced)
 * and keep Phone parked. Search can still surface Local VM. */
export function friendsSettingsNavVisible(
  id: AppSettingsSection,
  query: string,
  input: { phoneAvailable: boolean },
): boolean {
  void input;
  if (id === "companion") return false;
  if (id === "computer" && !query.trim()) return false;
  return settingsSectionMatches(id, query);
}
