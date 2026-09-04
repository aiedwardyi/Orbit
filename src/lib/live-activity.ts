import type { Message } from "@/state/store";
import { t, type MessageKey } from "./i18n";

const FALLBACK_LABELS: Array<[RegExp, MessageKey]> = [
  [/\b(?:bash|shell|terminal|exec|command|run_command)\b/i, "activity.runningCommand"],
  [/\b(?:read|read_file|view|open_file)\b/i, "activity.readingFile"],
  [/\b(?:write|write_file|create_file)\b/i, "activity.writingFile"],
  [/\b(?:edit|apply_patch|replace|str_replace)\b/i, "activity.editingFile"],
  [/\b(?:web_search|search_web)\b/i, "activity.searchingWeb"],
  [/\b(?:web_fetch|fetch_url|read_page)\b/i, "activity.readingPage"],
  [/\b(?:grep|glob|find|search)\b/i, "activity.searching"],
  [/\b(?:screenshot|screen_capture)\b/i, "activity.lookingAtScreen"],
  [/\b(?:click|type|keypress|press|scroll|computer)\b/i, "activity.usingComputer"],
  [/\b(?:open_url|navigate)\b/i, "activity.openingPage"],
  [/\b(?:list_bots|list_agents)\b/i, "activity.checkingWho"],
  [/\b(?:ask_bot|delegate_bot|send_message)\b/i, "activity.askingTeammate"],
];

function sentenceCase(value: string): string {
  const trimmed = value.trim().replace(/[.\s]+$/, "");
  if (!trimmed) return t("activity.thinking");
  return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
}

/**
 * The one quiet line shown while an agent is working. This follows t3code's
 * live-activity model: thinking before a tool starts, then the current verb.
 * The server-provided narration is authoritative; fallbacks cover older
 * messages and third-party drivers that only report a tool name.
 *
 * When Show tool calls is off, stay on "Thinking" — named verbs and
 * spoken tool lines are execution chrome, not chat presence.
 */
export function liveActivityLabel(message?: Message, showToolCalls = true): string {
  if (
    !showToolCalls ||
    message?.kind !== "activity" ||
    !message.tool ||
    message.tool.ok !== undefined ||
    message.comm
  ) {
    return t("activity.thinking");
  }

  if (message.tool.spoken?.trim()) return sentenceCase(message.tool.spoken);

  const toolName = message.tool.name.replace(/^mcp__[^_]+__/, "").split(":", 1)[0] ?? "";
  for (const [pattern, label] of FALLBACK_LABELS) {
    if (pattern.test(toolName)) return t(label);
  }
  return t("activity.working");
}
