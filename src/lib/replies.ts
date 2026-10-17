import { attachedFilePreview } from "@/lib/composer-attachments";
import type { Message } from "@/state/store";

export function replySnippet(text: string, limit = 160): string {
  const withImages = text.replace(/<attached-image\s+path="[^"]*"\s*\/>/g, "[image]");
  const clean = attachedFilePreview(withImages, (name) => `[file: ${name}]`)
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
export function replyAuthor(message: Message, fallback = "Assistant"): string {
  return message.from?.name ?? (message.role === "user" ? "You" : fallback);
}
