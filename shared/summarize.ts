/** One line, short enough for a lock screen, with the newlines, code
 * fences and markdown marks of a model's answer flattened out of it. */
export function summarize(text: string, max = 140): string {
  const line = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\*([^*\s][^*]*?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
