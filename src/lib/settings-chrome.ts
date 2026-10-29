import type { AppSettingsSection } from "@/state/store";
import {
  showSettingsAdvancedSection,
  showSettingsEnginesNav,
  showSettingsMoreServicesSection,
} from "./friends-chrome";
import { settingsSectionMatches } from "./settings-search";

export function appSettingsNavigation(
  state: { appSettingsOpen: boolean; appSettingsSection: AppSettingsSection },
  action: { open?: boolean; section?: AppSettingsSection },
) {
  const open = action.open ?? !state.appSettingsOpen;
  return {
    appSettingsOpen: open,
    appSettingsSection: action.section ?? (open ? "general" as const : state.appSettingsSection),
    appSettingsPage: open && action.section !== undefined,
  };
}

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

// Phone setup belongs to the PC; engines live on Connections.
export function friendsSettingsNavVisible(
  id: AppSettingsSection,
  query: string,
  input: { phoneAvailable: boolean },
): boolean {
  if (id === "sync" || id === "computer") return false;
  if (id === "companion" && !input.phoneAvailable) return false;
  if (id === "engines" && !showSettingsEnginesNav()) return false;
  return settingsSectionMatches(id, query);
}

/** Preserve old section links after regrouping Settings. */
export function resolvedAppSettingsSection(id: AppSettingsSection): AppSettingsSection {
  if (id === "sync") return "account";
  if (id === "engines" && !showSettingsEnginesNav()) return "connections";
  return id;
}
