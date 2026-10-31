export function isShownMessage(message: { role?: string; summarized?: boolean; hidden?: boolean }): boolean {
  return !(message.role === "bot" && (message.summarized || message.hidden));
}
