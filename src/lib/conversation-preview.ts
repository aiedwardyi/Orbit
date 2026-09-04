// Sidebar row preview for a 1:1 bot. Busy/waiting win; otherwise the
// visible branch's tail. First-run quiz cards hide from chat once
// answered or ignored — the preview must skip them too or the unanswered
// question keeps staring from the roster after Ignore.
import { shouldHideOnboardingCard } from "@/components/OptionCard";
import { t, type Translate } from "@/lib/i18n";
import { visibleMessages, type Bot } from "@/state/store";

export type PreviewBot = Pick<Bot, "activity" | "busy" | "messages" | "activeLeafId">;

/** Ignored (X / Ignore), not a chosen option. Choosing sets answered. */
export function isIgnoredOnboardingCard(message: PreviewBot["messages"][number], transcript: PreviewBot["messages"]): boolean {
  return (
    shouldHideOnboardingCard(message, transcript) &&
    Boolean(message.card?.dismissed) &&
    !message.card?.answered
  );
}

/** True when the thread has nothing left to show after Ignore. A chosen
 * option is not idle — the user echo may still be in flight. */
export function transcriptIdleAfterOnboarding(messages: PreviewBot["messages"]): boolean {
  if (messages.length === 0) return true;
  return messages.every((message) => isIgnoredOnboardingCard(message, messages));
}

/** Hide the Ask-for-approval chip only when Ignore left a first-turn quiz
 * as the sole leftover. Empty job-first threads and live chats keep it. */
export function showComposerPermissionChip(messages: PreviewBot["messages"]): boolean {
  if (messages.length === 0) return true;
  return !transcriptIdleAfterOnboarding(messages);
}

export function conversationPreview(bot: PreviewBot, translate: Translate = t): string {
  if (bot.activity === "waiting-on-you") return translate("chrome.waitingForYou");
  if (bot.busy) return translate("chrome.working");
  const visible = visibleMessages(bot);
  for (let i = visible.length - 1; i >= 0; i--) {
    const last = visible[i];
    if (last.kind === "options" && last.card) {
      if (shouldHideOnboardingCard(last, visible)) {
        if (last.card.answered) return last.card.answered;
        continue;
      }
      return last.card.title;
    }
    if (last.kind === "activity" && last.tool) return last.tool.name;
    if (last.kind === "screen") return translate("chrome.screenFrame");
    if (last.text) return last.text;
  }
  return "";
}
