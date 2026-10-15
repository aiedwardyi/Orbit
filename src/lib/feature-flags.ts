export interface FeatureFlagConfig {
  features?: { skillRecorder?: boolean; showToolCalls?: boolean; detailedReplies?: boolean; browser?: boolean; memoryNotes?: boolean };
}

export function detailedRepliesEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.detailedReplies === true;
}

/** Background chat notes into MEMORY.md. The bot's own switch, else the old global one, on unless switched off. */
export function memoryNotesEnabled(config: FeatureFlagConfig | null | undefined, bot?: { memoryNotes?: boolean } | null): boolean {
  return bot?.memoryNotes ?? (config?.features?.memoryNotes !== false);
}

/** Experimental features are available only after an explicit opt-in. */
export function skillRecorderEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillRecorder === true;
}

/** The built-in per-bot browser (Browser tab of the computer panel) is
 * removed: permanently off, whatever the config says. */
export function builtInBrowserEnabled(_config: FeatureFlagConfig | null | undefined): boolean {
  return false;
}

/** Tool-run chips in the transcript. Off by default — the mascot already
 * shows that work is happening. */
export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls === true;
}
