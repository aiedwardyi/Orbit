import { memoryFileRaw } from "./workspace.ts";

export const MEMORY_SAVE_TOOL = "memory.save";

const snapshots = new Map<string, string>();

function factLines(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const trimmed = line.trim().replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) return [];
    return [trimmed];
  });
}

export function memorySaveSummary(before: string, after: string): string | null {
  const previous = new Set(factLines(before));
  const added = factLines(after).filter((line) => !previous.has(line));
  const picked = added.at(-1);
  if (!picked) return null;
  return picked.slice(0, 80);
}

export function peekMemory(botId: string): void {
  snapshots.set(botId, memoryFileRaw(botId));
}

export function rememberMemoryWrite(botId: string): string | null {
  const next = memoryFileRaw(botId);
  const prev = snapshots.get(botId);
  if (prev === undefined) {
    snapshots.set(botId, next);
    return null;
  }
  snapshots.set(botId, next);
  return memorySaveSummary(prev, next);
}

export function resetMemorySnapshots(): void {
  snapshots.clear();
}
