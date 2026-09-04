/** Friends-desktop chrome: hide power-user surfaces without deleting them.
 * Flip a function to true to put that control back on the idle UI. */

export function showSettingsSearch(): boolean {
  return false;
}

export function showSettingsAdvancedSection(): boolean {
  return false;
}

export function showBotDetailsAdvanced(): boolean {
  return false;
}

export function showComputerPanelChrome(): boolean {
  return false;
}

export function showBotNewTaskControl(): boolean {
  return false;
}

export function showChannelNewTaskControl(): boolean {
  return false;
}

export function showChannelCallControl(): boolean {
  return false;
}

export function showSidebarTeachSkill(): boolean {
  return false;
}

export function showSidebarRoutines(): boolean {
  return false;
}

export function showCommunityRepoLink(): boolean {
  return false;
}

export function showAvatarImageGenerate(): boolean {
  return false;
}

export function showAvatarShapeOptions(): boolean {
  return false;
}

/** Avatars-only collapse and Comfortable / Compact / Avatars-only. Resize replaces them. */
export function showSidebarDensityControls(): boolean {
  return false;
}

/** AssemblyAI, Box, VPS, and self-host stay in code, off the Connections page. */
export function showSettingsMoreServicesSection(): boolean {
  return false;
}

/** Engines is folded into Connections. Flip to restore a separate tab. */
export function showSettingsEnginesNav(): boolean {
  return false;
}

/** Per-bot tokens/turns/cost table under Settings → Usage. */
export function showUsagePerBotTable(): boolean {
  return false;
}

/** "Show all engines · N more" and the local engine zoo on the picker rail. */
export function showEngineRailZoo(): boolean {
  return false;
}
