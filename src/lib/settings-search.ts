import type { AppSettingsSection } from "@/state/store";
import { catalogs, type MessageKey } from "./i18n-catalog";

/** Settings nav search matches both English and Korean labels/body copy so a
 * Korean query still finds a section when the chrome is English, and vice versa. */
const SECTION_PHRASE_KEYS = {
  general: [
    "settings.section.general",
    "language.title",
    "settings.profile.title",
    "settings.profile.subtitle",
    "settings.profile.namePlaceholder",
    "settings.profile.emailPlaceholder",
    "settings.skin.title",
    "settings.skin.subtitle",
    "settings.skin.ledger.tagline",
    "settings.channelTurns.title",
    "settings.channelTurns.subtitle",
    "settings.toolCalls.title",
    "settings.toolCalls.subtitle",
    "settings.toolCalls.toggle",
    "settings.experimental.title",
    "settings.experimental.skill",
    "settings.experimental.browser",
    "settings.browserProfiles.title",
    "settings.updates.title",
    "settings.diagnostics.title",
    "settings.analytics.title",
    "settings.advanced.title",
    "settings.advanced.subtitle",
    "settings.section.computer",
  ],
  connections: [
    "settings.section.connections",
    "settings.connections.title",
    "settings.connections.subtitle",
    "settings.connections.ready",
    "settings.connections.selfHost",
    "settings.connections.moreServices",
    "connections.gemini.label",
    "connections.box.label",
    "connections.vps.label",
    "connections.transcription.label",
    "connections.opencode.label",
  ],
  engines: [
    "settings.section.engines",
    "settings.engines.title",
    "settings.engines.subtitle",
    "engines.setCli",
    "engines.help",
    "engines.none",
  ],
  companion: [
    "settings.section.companion",
  ],
  computer: [
    "settings.section.computer",
  ],
  usage: [
    "settings.section.usage",
  ],
} as const satisfies Record<AppSettingsSection, readonly MessageKey[]>;

const EXTRA_KEYWORDS = {
  general: ["profile", "name", "email", "skin", "theme", "appearance", "analytics", "updates", "tools", "tool calls", "language", "locale", "vm", "virtual", "desktop", "diagnostics", "experimental"],
  connections: ["keys", "api", "composio", "box", "xai", "vps"],
  engines: ["models", "claude", "grok", "providers", "cli"],
  companion: ["companion", "phone", "pair", "mobile"],
  computer: ["vm", "virtual", "desktop"],
  usage: ["tokens", "cost", "billing"],
} as const satisfies Record<AppSettingsSection, readonly string[]>;

export function settingsSectionSearchHaystack(id: AppSettingsSection): string {
  const phrases = SECTION_PHRASE_KEYS[id].flatMap((key) => [catalogs.en[key], catalogs.ko[key]]);
  return [...phrases, ...EXTRA_KEYWORDS[id]].join("\n").toLowerCase();
}

export function settingsSectionMatches(id: AppSettingsSection, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return settingsSectionSearchHaystack(id).includes(q);
}
