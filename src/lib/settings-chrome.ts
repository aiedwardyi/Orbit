import type { AppSettingsSection } from "@/state/store";
import {
  showSettingsAdvancedSection,
  showSettingsEnginesNav,
  showSettingsMoreServicesSection,
} from "./friends-chrome";
import { settingsSectionMatches } from "./settings-search";

/** Fold Local VM / channel turns / experiments / diagnostics when that
 * section is on the surface. `advancedOpen` is ignored while
 * `showSettingsAdvancedSection()` is off; it matters again if that flag
 * is flipped. */
export function showSettingsAdvancedControls(advancedOpen: boolean): boolean {
  return showSettingsAdvancedSection() && advancedOpen;
}

/** Box, VPS, transcription, and self-host stay behind More services when
 * that section is on the surface. */
export function showSettingsMoreServices(moreServicesOpen: boolean): boolean {
  return showSettingsMoreServicesSection() && moreServicesOpen;
}

/** Idle friends settings hide Local VM, Phone, and the Engines tab
 * (engines live on Connections). Local VM stays off the nav even when search
 * would otherwise match — Advanced is not on this surface. */
export function friendsSettingsNavVisible(
  id: AppSettingsSection,
  query: string,
  input: { phoneAvailable: boolean },
): boolean {
  void input;
  if (id === "companion" || id === "computer") return false;
  if (id === "engines" && !showSettingsEnginesNav()) return false;
  return settingsSectionMatches(id, query);
}

/** Deep links to Engines land on the unified Connections page. */
export function resolvedAppSettingsSection(id: AppSettingsSection): AppSettingsSection {
  if (id === "engines" && !showSettingsEnginesNav()) return "connections";
  return id;
}
