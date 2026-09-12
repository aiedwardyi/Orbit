import type { AppSettingsSection } from "@/state/store";
import { showSettingsMoreServicesSection } from "./friends-chrome";
import { catalogs, type MessageKey } from "./i18n-catalog";

/** Settings nav search matches both English and Korean labels/body copy so a
 * Korean query still finds a section when the chrome is English, and vice versa. */
export const SECTION_PHRASE_KEYS = {
  general: [
    "settings.section.general",
    "language.title",
    "settings.profile.title",
    "settings.profile.subtitle",
    "settings.profile.namePlaceholder",
    "settings.profile.save",
    "settings.skin.title",
    "settings.skin.subtitle",
    "settings.skin.midnight.tagline",
    "settings.skin.atelier.tagline",
    "settings.skin.foundry.tagline",
    "settings.skin.lagoon.tagline",
    "settings.skin.ledger.tagline",
    "settings.skin.catppuccin-mocha.tagline",
    "settings.skin.tokyo-night.tagline",
    "settings.skin.vesper.tagline",
    "settings.skin.onyx.tagline",
    "settings.skin.dracula.tagline",
    "settings.skin.cobalt.tagline",
    "settings.channelTurns.title",
    "settings.channelTurns.subtitle",
    "settings.toolCalls.title",
    "settings.toolCalls.subtitle",
    "settings.toolCalls.toggle",
    "settings.experimental.title",
    "settings.experimental.skill",
    "settings.experimental.browser",
    "settings.updates.title",
    "settings.diagnostics.title",
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
    "connections.opencode.label",
    "engines.setCli",
    "engines.help",
    "connections.box.label",
    "connections.vps.label",
    "connections.transcription.label",
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

/** Box, VPS, AssemblyAI, and self-host stay in the catalog for when More
 * services is flipped back on; they must not match Connections search while
 * that block is hidden. */
const CONNECTIONS_MORE_SERVICES_KEYS = new Set<MessageKey>([
  "settings.connections.selfHost",
  "settings.connections.moreServices",
  "connections.box.label",
  "connections.vps.label",
  "connections.transcription.label",
]);

function phraseKeysFor(id: AppSettingsSection): readonly MessageKey[] {
  const keys = SECTION_PHRASE_KEYS[id];
  if (id !== "connections" || showSettingsMoreServicesSection()) return keys;
  return keys.filter((key) => !CONNECTIONS_MORE_SERVICES_KEYS.has(key));
}

const EXTRA_KEYWORDS = {
  general: ["profile", "name", "skin", "theme", "appearance", "updates", "tools", "tool calls", "language", "locale", "vm", "diagnostics", "experimental"],
  connections: ["keys", "api", "gemini", "opencode", "claude", "grok", "codex", "antigravity", "cli"],
  engines: ["models", "claude", "grok", "providers", "cli"],
  companion: ["companion", "phone", "pair", "mobile"],
  computer: ["vm", "virtual", "desktop"],
  usage: ["tokens", "cost", "billing"],
} as const satisfies Record<AppSettingsSection, readonly string[]>;

export function settingsSectionSearchHaystack(id: AppSettingsSection): string {
  const phrases = phraseKeysFor(id).flatMap((key) => [catalogs.en[key], catalogs.ko[key]]);
  return [...phrases, ...EXTRA_KEYWORDS[id]].join("\n").toLowerCase();
}

export function settingsSectionMatches(id: AppSettingsSection, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return settingsSectionSearchHaystack(id).includes(q);
}
