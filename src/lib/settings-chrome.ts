import type { AppSettingsSection } from "@/state/store";
import { showSettingsAdvancedSection } from "./friends-chrome";
import { settingsSectionMatches } from "./settings-search";

/** Power controls stay folded until asked — same as the Computer panel Advanced. */
export function showSettingsAdvancedControls(advancedOpen: boolean): boolean {
  return showSettingsAdvancedSection() && advancedOpen;
}

/** Box, VPS, transcription, OpenCode, and self-host stay behind More services. */
export function showSettingsMoreServices(moreServicesOpen: boolean): boolean {
  return moreServicesOpen;
}

/** Idle friends settings hide Local VM and Phone. Local VM stays off the
 * nav even when search would otherwise match — Advanced is not on this surface. */
export function friendsSettingsNavVisible(
  id: AppSettingsSection,
  query: string,
  input: { phoneAvailable: boolean },
): boolean {
  void input;
  if (id === "companion" || id === "computer") return false;
  return settingsSectionMatches(id, query);
}
