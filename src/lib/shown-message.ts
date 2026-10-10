/** An engine summary of a bot's mid-turn note is not the bot's words, so the user never sees it. */
export function isShownMessage(message: { role?: string; summarized?: boolean }): boolean {
  return !(message.role === "bot" && message.summarized);
}
